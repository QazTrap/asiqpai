import test from "node:test";
import assert from "node:assert/strict";
import { promptFor, durationFor, PRESETS } from "../src/samplePrompt.js";
import { mountSampleRoutes } from "../src/samples.js";

const settings={preset:"memphis",bpm:148,key:"D#m",bars:8,dense:true,
  description:"Без ударных без вокала только клавишные пианино как у young dolph"};

test("the reported solo piano request overrides every preset and density",()=>{
  for(const preset of Object.keys(PRESETS))for(const dense of [true,false]){
    const prompt=promptFor({...settings,preset,dense});
    assert.match(prompt,/solo acoustic piano, piano as the only sound source/);
    assert.match(prompt,/No drums, percussion/);
    assert.doesNotMatch(prompt,/Rhodes|guitar|strings?|synth|pad|2 to 4|young dolph|trap/i);
    assert.match(prompt,/148 BPM, 4\/4, D sharp minor/);
  }
});

test("custom instruments and negative piano requests do not get a preset piano layer",()=>{
  for(const description of ["без пианино, только гитара как у young dolph","Solo guitar only, no piano","только Rhodes"]){
    const prompt=promptFor({...settings,description});
    assert.doesNotMatch(prompt,/acoustic piano|supporting texture|sustained string|analogue pad|2 to 4/i);
  }
});

test("empty descriptions still get a defined preset instrument",()=>{
  for(const preset of Object.keys(PRESETS)){
    assert.ok(promptFor({...settings,preset,description:""}).includes(PRESETS[preset].instruments));
  }
});

test("duration uses exactly the requested bars across the supported BPM range",()=>{
  for(const bpm of [70,118,122,148,180])for(const bars of [4,8]){
    assert.ok(Math.abs(durationFor({...settings,bpm,bars})-bars*4*60/bpm)<=0.0005);
  }
  assert.equal(durationFor({...settings,bpm:180,bars:4}),5.333);
});

// DB and provider are fakes: tests exercise the actual route and multipart body
// without credentials, a running server, or a billable generation.
function routes(source=settings){
  const handlers=new Map(),jobs=new Map();
  const app={get:(path,...fns)=>handlers.set("GET "+path,fns.at(-1)),post:(path,...fns)=>handlers.set("POST "+path,fns.at(-1))};
  const pool={query:async(sql,args=[])=>{
    if(sql.startsWith("SELECT v.id,j.settings"))return {rows:[{id:"sample-1",settings:source}],rowCount:1};
    if(sql.startsWith("SELECT id FROM sample_ai_jobs"))return {rows:jobs.has(args[1])?[{id:jobs.get(args[1])}]:[],rowCount:jobs.has(args[1])?1:0};
    if(sql.startsWith("INSERT INTO sample_ai_jobs"))jobs.set(args[2],args[0]);
    return {rows:[],rowCount:1};
  }};
  mountSampleRoutes(app,{pool,requireTelegramUser:()=>{}});
  return async(body,action=false)=>{
    const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
    await handlers.get(action?"POST /api/samples/action":"POST /api/samples/generate")({telegramUser:{id:123},body},res);
    return res;
  };
}

for(const model of ["stable-audio-2.5","stable-audio-3"]){
  test(model+": selected settings reach the provider once; a repeated request ID is reused",async t=>{
    const environment={STABILITY_API_KEY:"test-only-not-a-real-api-key",SAMPLES_ALLOWED_USER_IDS:"123",SAMPLES_STABILITY_MODEL:model};
    for(const [name,value] of Object.entries(environment)){
      const previous=process.env[name];process.env[name]=value;
      t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});
    }
    const calls=[];
    t.mock.method(globalThis,"fetch",async(url,options)=>{
      calls.push({url,form:options.body});
      if(model==="stable-audio-3")return Response.json({id:"a".repeat(64)},{status:202});
      const wav=Buffer.alloc(44);wav.write("RIFF");wav.write("WAVE",8);
      return new Response(wav,{status:200,headers:{"content-type":"audio/wav"}});
    });
    const generate=routes();
    const body={...settings,preset:"dark",bpm:118,key:"Em",bars:4,count:1,request_id:"request_piano_001"};
    const first=await generate(body),second=await generate(body);
    assert.equal(first.code,202);assert.equal(second.body.job_id,first.body.job_id);
    assert.equal(second.body.created,false);assert.equal(calls.length,1);
    assert.equal(calls[0].form.get("model"),model);
    assert.equal(calls[0].form.get("output_format"),"wav");
    assert.equal(calls[0].form.get("steps"),"8");
    assert.equal(calls[0].form.get("duration"),"8.136");
    assert.match(calls[0].form.get("prompt"),/118 BPM, 4\/4, E minor/);
    assert.match(calls[0].form.get("prompt"),/solo acoustic piano/);
    assert.doesNotMatch(calls[0].form.get("prompt"),/guitar|Rhodes|synth|2 to 4/);
    const variant=await generate({variant_id:"sample-1",action:"harder",request_id:"request_harder_001"},true);
    assert.equal(variant.code,202);
    assert.match(calls[1].form.get("prompt"),/solo acoustic piano/);
    assert.doesNotMatch(calls[1].form.get("prompt"),/guitar|Rhodes|synth|2 to 4/);
    const presetOnly=routes({...settings,description:""});
    await presetOnly({variant_id:"sample-1",action:"softer",request_id:"request_softer_001"},true);
    assert.ok(calls[2].form.get("prompt").includes(PRESETS.memphis.instruments));
  });
}
