import crypto from "node:crypto";
import { PRESETS, durationFor, promptFor } from "./samplePrompt.js";

const KEYS = Object.freeze(["Fm","F#m","Gm","G#m","Am","A#m","Bm","Cm","C#m","Dm","D#m","Em"]);

function boolEnv(name, fallback=false){
  const value=String(process.env[name]||"").trim().toLowerCase();
  return value ? ["1","true","yes","on"].includes(value) : fallback;
}
function allowedUsers(){
  const values=String(process.env.SAMPLES_ALLOWED_USER_IDS||"").split(",").map(v=>v.trim()).filter(v=>/^\d+$/.test(v));
  const admin=String(process.env.ADMIN_CHAT_ID||"").trim();
  if(/^\d+$/.test(admin)) values.push(admin);
  return new Set(values);
}
function assertAccess(userId){
  if(boolEnv("SAMPLES_PUBLIC",false) || allowedUsers().has(String(userId))) return;
  const error=new Error("Доступ к AI Samples пока закрыт.");
  error.status=403;
  throw error;
}
function providerReady(){
  return String(process.env.STABILITY_API_KEY||"").trim().length>10;
}
function settingsFrom(value){
  value=value||{};
  const settings={
    bpm:Number(value.bpm??122),
    bars:Number(value.bars??8),
    key:String(value.key||"Fm"),
    preset:String(value.preset||"memphis"),
    dense:value.dense===undefined?true:value.dense,
    description:String(value.description||"").trim()
  };
  if(!Number.isInteger(settings.bpm)||settings.bpm<70||settings.bpm>180) throw new Error("BPM должен быть от 70 до 180.");
  if(![4,8].includes(settings.bars)) throw new Error("Длина должна быть 4 или 8 тактов.");
  if(!KEYS.includes(settings.key)) throw new Error("Недопустимая тональность.");
  if(!Object.hasOwn(PRESETS,settings.preset)) throw new Error("Недопустимый стиль.");
  if(typeof settings.dense!=="boolean") throw new Error("Некорректная плотность.");
  if(settings.description.length>600) throw new Error("Описание: до 600 символов.");
  return settings;
}
function transformSettings(source,action){
  const s=settingsFrom(source);
  const extra={
    similar:"Create a fresh variation with the same mood and musical role, but a new original melody.",
    darker:"Make the harmony darker, more ominous and tense while keeping it musical and loopable.",
    harder:"Make the melody more aggressive, urgent and energetic without adding drums or bass.",
    softer:"Make the melody softer, warmer, more spacious and emotional."
  }[action];
  if(!extra) throw new Error("Неизвестное действие.");
  s.description=[s.description||PRESETS[s.preset].instruments,extra].join(" ").slice(0,600);
  return s;
}
function stabilityHeaders(){
  return {
    authorization:"Bearer "+String(process.env.STABILITY_API_KEY||"").trim(),
    accept:"audio/*",
    "stability-client-id":"asiqpai-samples",
    "stability-client-version":"0.3.0"
  };
}
async function submitAudio(settings,seed){
  if(!providerReady()){
    const error=new Error("AI Samples ещё не подключён к генератору.");
    error.status=503;
    throw error;
  }

  const model=String(process.env.SAMPLES_STABILITY_MODEL||"stable-audio-2.5").trim();
  const useV3=model==="stable-audio-3";
  const form=new FormData();
  form.append("none",new Blob([],{type:"application/octet-stream"}),"none");
  form.append("prompt",promptFor(settings));
  form.append("duration",String(durationFor(settings)));
  form.append("model",useV3?"stable-audio-3":"stable-audio-2.5");
  form.append("output_format","wav");
  form.append("seed",String(seed));
  form.append("steps","8");

  const endpoint=useV3
    ?"https://api.stability.ai/v2beta/audio/stable-audio/text-to-audio"
    :"https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio";

  const response=await fetch(endpoint,{
    method:"POST",headers:stabilityHeaders(),body:form,signal:AbortSignal.timeout(useV3?65000:180000)
  });

  if(useV3){
    const data=await response.json().catch(()=>({}));
    if(response.status!==202||!/^[a-f0-9]{64}$/i.test(String(data.id||""))){
      const detail=String(data?.errors?.join?.("; ")||data?.message||data?.name||"").slice(0,240);
      const error=new Error("Stable Audio "+response.status+(detail?": "+detail:""));
      error.status=response.status;
      throw error;
    }
    return {generationId:data.id};
  }

  if(response.status!==200){
    const data=await response.json().catch(()=>({}));
    const detail=String(data?.errors?.join?.("; ")||data?.message||data?.name||"").slice(0,240);
    const error=new Error("Stable Audio "+response.status+(detail?": "+detail:""));
    error.status=response.status;
    throw error;
  }

  const audio=Buffer.from(await response.arrayBuffer());
  if(audio.length<44||audio.length>32*1024*1024||audio.toString("ascii",0,4)!=="RIFF"||audio.toString("ascii",8,12)!=="WAVE"){
    const error=new Error("Stable Audio вернул некорректный WAV.");
    error.status=502;
    throw error;
  }
  return {audio};
}
async function fetchAudio(id){
  const response=await fetch("https://api.stability.ai/v2beta/audio/results/"+encodeURIComponent(id),{
    headers:stabilityHeaders(),signal:AbortSignal.timeout(45000)
  });
  if(response.status===202) return {status:"waiting"};
  if(response.status===404) return {status:"failed",error:"Результат генерации истёк или не найден."};
  if(response.status!==200) throw new Error("Stable Audio result failed.");
  const audio=Buffer.from(await response.arrayBuffer());
  if(audio.length<44||audio.length>32*1024*1024||audio.toString("ascii",0,4)!=="RIFF"||audio.toString("ascii",8,12)!=="WAVE") throw new Error("Некорректный WAV.");
  return {status:"ready",audio};
}

export function mountSampleRoutes(app,{pool,requireTelegramUser}){
  let schemaPromise;
  const dailyLimit=Math.max(1,Math.min(50,Number(process.env.SAMPLES_DAILY_LIMIT||3)));

  function initSchema(){
    if(!schemaPromise){
      schemaPromise=(async()=>{
        await pool.query("CREATE TABLE IF NOT EXISTS sample_ai_usage (telegram_id BIGINT NOT NULL, usage_day DATE NOT NULL DEFAULT CURRENT_DATE, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (telegram_id,usage_day))");
        await pool.query("CREATE TABLE IF NOT EXISTS sample_ai_jobs (id UUID PRIMARY KEY, telegram_id BIGINT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', count INTEGER NOT NULL CHECK (count IN (1,3)), settings JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (telegram_id,request_id))");
        await pool.query("CREATE TABLE IF NOT EXISTS sample_ai_variants (id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES sample_ai_jobs(id) ON DELETE CASCADE, telegram_id BIGINT NOT NULL, generation_id TEXT, seed BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', favorite BOOLEAN NOT NULL DEFAULT FALSE, audio BYTEA, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
        await pool.query("CREATE INDEX IF NOT EXISTS sample_ai_variants_user_idx ON sample_ai_variants (telegram_id,created_at DESC)");
      })().catch(error=>{schemaPromise=null;throw error;});
    }
    return schemaPromise;
  }
  async function usage(userId){
    const r=await pool.query("SELECT requests FROM sample_ai_usage WHERE telegram_id=$1 AND usage_day=CURRENT_DATE",[userId]);
    return Number(r.rows[0]?.requests||0);
  }
  async function reserve(userId,count){
    const r=await pool.query(
      "INSERT INTO sample_ai_usage (telegram_id,usage_day,requests) VALUES ($1,CURRENT_DATE,$2) ON CONFLICT (telegram_id,usage_day) DO UPDATE SET requests=sample_ai_usage.requests+EXCLUDED.requests WHERE sample_ai_usage.requests+EXCLUDED.requests<=$3 RETURNING requests",
      [userId,count,dailyLimit]
    );
    if(!r.rowCount){const e=new Error("Дневной лимит AI Samples исчерпан.");e.status=429;throw e;}
  }
  async function release(userId,count){
    if(count>0) await pool.query("UPDATE sample_ai_usage SET requests=GREATEST(0,requests-$2) WHERE telegram_id=$1 AND usage_day=CURRENT_DATE",[userId,count]);
  }
  async function refresh(row){
    if(!row||row.status!=="waiting"||!row.generation_id||!providerReady()) return row;
    try{
      const result=await fetchAudio(row.generation_id);
      if(result.status==="waiting") return row;
      if(result.status==="ready"){
        const r=await pool.query("UPDATE sample_ai_variants SET status='ready',audio=$2,error=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",[row.id,result.audio]);
        return r.rows[0];
      }
      const r=await pool.query("UPDATE sample_ai_variants SET status='failed',error=$2,updated_at=NOW() WHERE id=$1 RETURNING *",[row.id,result.error||"Generation failed"]);
      return r.rows[0];
    }catch(error){
      console.error("AI Samples polling:",error.message);
      return row;
    }
  }
  async function jobJson(userId,jobId){
    const jr=await pool.query("SELECT * FROM sample_ai_jobs WHERE id=$1 AND telegram_id=$2 LIMIT 1",[jobId,userId]);
    const job=jr.rows[0];
    if(!job){const e=new Error("Генерация не найдена.");e.status=404;throw e;}
    let variants=(await pool.query("SELECT * FROM sample_ai_variants WHERE job_id=$1 AND telegram_id=$2 ORDER BY created_at",[jobId,userId])).rows;
    variants=await Promise.all(variants.map(refresh));
    const ready=variants.filter(v=>v.status==="ready").length;
    const failed=variants.filter(v=>v.status==="failed").length;
    const status=ready+failed>=job.count?(failed?"interrupted":"ready"):"waiting";
    if(status!==job.status) await pool.query("UPDATE sample_ai_jobs SET status=$2,updated_at=NOW() WHERE id=$1",[jobId,status]);
    return {id:job.id,status,count:job.count,variants:variants.map(v=>({id:v.id,status:v.status,ready:v.status==="ready"}))};
  }
  async function createGeneration(userId,value,countValue,requestIdValue){
    await initSchema(); assertAccess(userId);
    const settings=settingsFrom(value);
    const count=Number(countValue);
    if(![1,3].includes(count)) throw new Error("Можно создать 1 или 3 варианта.");
    const requestId=String(requestIdValue||"").trim();
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Некорректный идентификатор запроса.");
    if(!providerReady()){const e=new Error("AI Samples ещё не подключён к генератору.");e.status=503;throw e;}
    const old=await pool.query("SELECT id FROM sample_ai_jobs WHERE telegram_id=$1 AND request_id=$2 LIMIT 1",[userId,requestId]);
    if(old.rows[0]) return {jobId:old.rows[0].id,created:false};
    await reserve(userId,count);
    const jobId=crypto.randomUUID();
    try{
      await pool.query("INSERT INTO sample_ai_jobs (id,telegram_id,request_id,status,count,settings) VALUES ($1,$2,$3,'waiting',$4,$5::jsonb)",[jobId,userId,requestId,count,JSON.stringify(settings)]);
    }catch(error){
      await release(userId,count);
      throw error;
    }
    let submitted=0;
    for(let i=0;i<count;i++){
      const variantId=crypto.randomUUID();
      const seed=crypto.randomInt(1,4294967295);
      try{
        const result=await submitAudio(settings,seed);
        if(result.audio){
          await pool.query("INSERT INTO sample_ai_variants (id,job_id,telegram_id,seed,status,audio) VALUES ($1,$2,$3,$4,'ready',$5)",[variantId,jobId,userId,seed,result.audio]);
        }else{
          await pool.query("INSERT INTO sample_ai_variants (id,job_id,telegram_id,generation_id,seed,status) VALUES ($1,$2,$3,$4,$5,'waiting')",[variantId,jobId,userId,result.generationId,seed]);
        }
        submitted++;
      }catch(error){
        console.error("AI Samples submit:",error.message);
        await pool.query("INSERT INTO sample_ai_variants (id,job_id,telegram_id,seed,status,error) VALUES ($1,$2,$3,$4,'failed',$5)",[variantId,jobId,userId,seed,String(error.message).slice(0,300)]);
      }
    }
    if(submitted<count) await release(userId,count-submitted);
    if(!submitted) await pool.query("UPDATE sample_ai_jobs SET status='interrupted',updated_at=NOW() WHERE id=$1",[jobId]);
    return {jobId,created:true};
  }
  function fail(res,error){
    console.error("AI Samples:",error.message);
    const status=Number(error.status)||(error.message.includes("BPM")||error.message.includes("Недопуст")||error.message.includes("Некорр")||error.message.includes("вариант")?400:500);
    res.status(status).json({error:status>=500?"Ошибка AI Samples. Повторите позже.":error.message});
  }
  app.get("/api/samples/bootstrap",requireTelegramUser,async(req,res)=>{
    try{
      await initSchema();assertAccess(req.telegramUser.id);
      const last=await pool.query("SELECT settings FROM sample_ai_jobs WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 1",[req.telegramUser.id]);
      const used=await usage(req.telegramUser.id);
      res.set("Cache-Control","no-store");
      res.json({ok:true,settings:settingsFrom(last.rows[0]?.settings||{}),presets:Object.entries(PRESETS).map(([id,v])=>({id,name:v.name})),keys:[...KEYS],limits:{daily:dailyLimit,used,remaining:Math.max(0,dailyLimit-used)},provider_ready:providerReady()});
    }catch(error){fail(res,error);}
  });
  app.get("/api/samples/history",requireTelegramUser,async(req,res)=>{
    try{
      await initSchema();assertAccess(req.telegramUser.id);
      const limit=Math.max(1,Math.min(50,Number(req.query.limit||20)));
      const favorites=String(req.query.favorites||"0")==="1";
      let rows=(await pool.query("SELECT v.*,j.settings FROM sample_ai_variants v JOIN sample_ai_jobs j ON j.id=v.job_id WHERE v.telegram_id=$1 AND ($2::boolean=FALSE OR v.favorite=TRUE) ORDER BY v.created_at DESC LIMIT $3",[req.telegramUser.id,favorites,limit])).rows;
      rows=await Promise.all(rows.map(refresh));
      const items=rows.map(row=>({id:row.id,status:row.status,ready:row.status==="ready",favorite:Boolean(row.favorite),bpm:Number(row.settings?.bpm||122),key:row.settings?.key||"Fm",bars:Number(row.settings?.bars||8),preset_name:PRESETS[row.settings?.preset]?.name||"Sample",created_at:row.created_at}));
      res.set("Cache-Control","no-store");res.json({ok:true,items});
    }catch(error){fail(res,error);}
  });
  app.get("/api/samples/job/:jobId",requireTelegramUser,async(req,res)=>{
    try{await initSchema();assertAccess(req.telegramUser.id);res.set("Cache-Control","no-store");res.json({ok:true,job:await jobJson(req.telegramUser.id,req.params.jobId)});}catch(error){fail(res,error);}
  });
  app.get("/api/samples/file/:variantId",requireTelegramUser,async(req,res)=>{
    try{
      await initSchema();assertAccess(req.telegramUser.id);
      let row=(await pool.query("SELECT * FROM sample_ai_variants WHERE id=$1 AND telegram_id=$2 LIMIT 1",[req.params.variantId,req.telegramUser.id])).rows[0];
      if(!row){const e=new Error("Сэмпл не найден.");e.status=404;throw e;}
      row=await refresh(row);
      if(row.status!=="ready"||!row.audio){const e=new Error("Сэмпл ещё не готов.");e.status=409;throw e;}
      const download=String(req.query.download||"0")==="1";
      res.set({"Content-Type":"audio/wav","Cache-Control":"private, max-age=300","Content-Disposition":(download?"attachment":"inline")+"; filename=\"ASIQPAI_"+row.id+".wav\""});
      res.send(row.audio);
    }catch(error){fail(res,error);}
  });
  app.post("/api/samples/generate",requireTelegramUser,async(req,res)=>{
    try{const r=await createGeneration(req.telegramUser.id,req.body,req.body?.count,req.body?.request_id);res.status(202).json({ok:true,job_id:r.jobId,created:r.created});}catch(error){fail(res,error);}
  });
  app.post("/api/samples/action",requireTelegramUser,async(req,res)=>{
    try{
      await initSchema();assertAccess(req.telegramUser.id);
      const row=(await pool.query("SELECT v.id,j.settings FROM sample_ai_variants v JOIN sample_ai_jobs j ON j.id=v.job_id WHERE v.id=$1 AND v.telegram_id=$2 LIMIT 1",[String(req.body?.variant_id||""),req.telegramUser.id])).rows[0];
      if(!row){const e=new Error("Сэмпл не найден.");e.status=404;throw e;}
      const settings=transformSettings(row.settings,String(req.body?.action||""));
      const r=await createGeneration(req.telegramUser.id,settings,1,req.body?.request_id);
      res.status(202).json({ok:true,job_id:r.jobId,settings});
    }catch(error){fail(res,error);}
  });
  app.post("/api/samples/favorite",requireTelegramUser,async(req,res)=>{
    try{
      await initSchema();assertAccess(req.telegramUser.id);
      if(typeof req.body?.favorite!=="boolean") throw new Error("Некорректное значение favorite.");
      const r=await pool.query("UPDATE sample_ai_variants SET favorite=$3,updated_at=NOW() WHERE id=$1 AND telegram_id=$2 RETURNING id",[String(req.body?.variant_id||""),req.telegramUser.id,req.body.favorite]);
      if(!r.rowCount){const e=new Error("Сэмпл не найден.");e.status=404;throw e;}
      res.json({ok:true});
    }catch(error){fail(res,error);}
  });
  app.post("/api/samples/delete",requireTelegramUser,async(req,res)=>{
    let client;
    try{
      await initSchema();assertAccess(req.telegramUser.id);
      const variantId=String(req.body?.variant_id||"").trim();
      if(!/^[0-9a-f-]{36}$/i.test(variantId)) throw new Error("Некорректный идентификатор сэмпла.");
      client=await pool.connect();
      await client.query("BEGIN");
      const deleted=await client.query("DELETE FROM sample_ai_variants WHERE id=$1 AND telegram_id=$2 RETURNING job_id",[variantId,req.telegramUser.id]);
      if(!deleted.rowCount){const e=new Error("Сэмпл не найден.");e.status=404;throw e;}
      const jobId=deleted.rows[0].job_id;
      await client.query("DELETE FROM sample_ai_jobs j WHERE j.id=$1 AND j.telegram_id=$2 AND NOT EXISTS (SELECT 1 FROM sample_ai_variants v WHERE v.job_id=j.id)",[jobId,req.telegramUser.id]);
      await client.query("COMMIT");
      res.json({ok:true});
    }catch(error){
      if(client){try{await client.query("ROLLBACK");}catch{}}
      fail(res,error);
    }finally{
      client?.release();
    }
  });
}
