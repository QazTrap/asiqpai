import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html=await readFile(new URL("../samples/index.html",import.meta.url),"utf8");
const initial={preset:"memphis",bpm:148,key:"D#m",bars:8,dense:true,description:"только пианино"};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function page(t,{remaining=3,failPlayback=false}={}){
  const requests=[],timers=[];
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const dom=new JSDOM(html,{url:"https://example.test/samples/",runScripts:"dangerously",beforeParse(window){
    window.setTimeout=callback=>{timers.push(callback);return timers.length;};
    window.fetch=async(url,options={})=>{
      const path=new URL(url).pathname;
      if(options.method==="POST"){
        requests.push({path,body:JSON.parse(options.body)});
        if(path.endsWith("/generate")||path.endsWith("/action"))return pending;
      }
      if(path.endsWith("/bootstrap"))return Response.json({settings:initial,presets:[{id:"memphis",name:"Memphis"},{id:"dark",name:"Dark Trap"}],keys:["D#m","Em"],limits:{daily:3,remaining},provider_ready:true});
      if(path.endsWith("/history"))return Response.json({items:[{id:"sample-1",preset_name:"Memphis",ready:true,bpm:148,bars:8,key:"D#m"}]});
      if(path.includes("/job/"))return Response.json({job:{status:"ready",count:1,variants:[{ready:true}]}});
      if(path.includes("/file/")&&failPlayback)throw new Error("playback failed");
      throw new Error("Unexpected test request: "+path);
    };
  }});
  t.after(()=>dom.window.close());
  await tick();await tick();
  const doc=dom.window.document;
  const click=selector=>doc.querySelector(selector).click();
  const rawClick=selector=>doc.querySelector(selector).dispatchEvent(new dom.window.MouseEvent("click",{bubbles:true}));
  return {doc,requests,timers,click,rawClick,finish:()=>finish(Response.json({job_id:"job-1"},{status:202}))};
}

test("one Generate sends the visible settings and blocks variant clicks until completion",async t=>{
  const p=await page(t);
  p.click('#presets [data-v="dark"]');p.doc.querySelector("#bpm").value="118";
  p.doc.querySelector("#key").value="Em";p.click('#bars [data-v="4"]');
  p.click("#generate");p.rawClick("#generate");p.rawClick('[data-act="harder"]');
  assert.equal(p.requests.length,1);
  assert.deepEqual({...p.requests[0].body,request_id:undefined},{preset:"dark",bpm:118,key:"Em",bars:4,dense:true,description:"только пианино",count:1,request_id:undefined});
  assert.equal(p.doc.querySelector('[data-act="harder"]').disabled,true);
  // While waiting, edits must survive the completion bootstrap refresh.
  p.doc.querySelector("#bpm").value="122";p.doc.querySelector("#description").value="только гитара";
  p.finish();await tick();p.timers.shift()();await tick();await tick();
  assert.equal(p.doc.querySelector("#bpm").value,"122");
  assert.equal(p.doc.querySelector("#key").value,"Em");
  assert.equal(p.doc.querySelector('#presets button.active').dataset.v,"dark");
  assert.equal(p.doc.querySelector("#description").value,"только гитара");
  assert.equal(p.doc.querySelector("#generate").disabled,false);
});

test("rapid variation clicks, a history re-render and playback failure cannot start a second generation",async t=>{
  const p=await page(t,{failPlayback:true});
  p.click('[data-act="similar"]');p.rawClick('[data-act="similar"]');p.rawClick('[data-act="softer"]');
  p.click('[data-filter="favorites"]');await tick();
  p.click('[data-act="play"]');await tick();
  p.rawClick("#generate");p.rawClick('[data-act="harder"]');
  assert.equal(p.requests.length,1);assert.equal(p.requests[0].path,"/api/samples/action");
  assert.equal(p.doc.querySelector("#generate").disabled,true);
});

test("quota blocks all billable buttons, including synthetic clicks",async t=>{
  const p=await page(t,{remaining:0});
  p.rawClick("#generate");p.rawClick('[data-act="similar"]');
  assert.equal(p.requests.length,0);assert.equal(p.doc.querySelector("#generate").disabled,true);
});

test("three variants are blocked when only one attempt remains",async t=>{
  const p=await page(t,{remaining:1});
  p.click('#count [data-v="3"]');p.rawClick("#generate");
  assert.equal(p.requests.length,0);
  p.click('#count [data-v="1"]');p.click("#generate");
  assert.equal(p.requests.length,1);assert.equal(p.requests[0].body.count,1);
});
