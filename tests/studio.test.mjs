import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeWav, analyse } from '../studio/audio.js';

const buffer = { sampleRate: 44100, length: 3, numberOfChannels: 2, getChannelData: c => new Float32Array(c ? [0.5, 1, -1] : [0.5, -1, 1]) };
test('WAV contains interleaved PCM16 stereo with correct byte counts', async () => {
  const wav = new DataView(await encodeWav(buffer).arrayBuffer());
  assert.equal(wav.getUint16(22, true), 2); assert.equal(wav.getUint32(24, true), 44100);
  assert.equal(wav.getUint32(40, true), 12); assert.equal(wav.byteLength, 56);
  assert.equal(wav.getInt16(48, true), -32768); assert.equal(wav.getInt16(50, true), 32767);
});
test('AI upload downmixes stereo without interleaving corruption', async () => {
  const wav = new DataView(await encodeWav(buffer, true).arrayBuffer());
  assert.equal(wav.getUint16(22, true), 1); assert.equal(wav.getUint32(40, true), 6);
  assert.equal(wav.getInt16(44, true), 16384); assert.equal(wav.getInt16(46, true), 0);
});
test('silence analysis never produces NaN', () => {
  assert.deepEqual(analyse({ numberOfChannels: 1, getChannelData: () => new Float32Array(10) }), { peak: 0, rms: 0 });
});
// Route-handler harness: no real database, network, or running application funds.
const source = (await readFile(new URL('../src/studio.js', import.meta.url), 'utf8')).replace("import express from 'express';", 'const express = { raw: () => (_req, _res, next) => next() };');
const { mountStudioRoutes } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function fixture(pool) {
  const routes = {};
  const auth = () => {};
  mountStudioRoutes({ get: (p, ...h) => routes[p] = h, post: (p, ...h) => routes[p] = h }, { pool, requireTelegramUser: auth });
  return { handlers: routes['/api/studio/enhance'], auth };
}
function response() { return { code: 200, headersSent: false, once() {}, set() { return this; }, status(c) { this.code = c; return this; }, json(value) { this.body = value; }, send(value) { this.body = value; } }; }
test('unconfigured AI refuses processing and keeps Telegram middleware first', () => {
  delete process.env.STUDIO_AI_URL; delete process.env.STUDIO_AI_TOKEN;
  const { handlers, auth } = fixture({}); assert.equal(handlers[0], auth);
  const res = response(); handlers[1]({}, res, () => assert.fail('should not advance'));
  assert.equal(res.code, 503);
});
test('quota exhaustion rejects processing before contacting worker', async () => {
  process.env.STUDIO_AI_URL = 'https://worker.invalid'; process.env.STUDIO_AI_TOKEN = 'test';
  const { handlers } = fixture({ query: async () => ({ rowCount: 0 }) });
  const req = { telegramUser: { id: 1 }, body: Buffer.from(await encodeWav(buffer, true).arrayBuffer()) };
  const res = response(); handlers[1](req, res, () => {}); await handlers[3](req, res);
  assert.equal(res.code, 429);
});
test('duplicate in-flight request is blocked; slot released after processing', async () => {
  const { handlers } = fixture({ query: async () => ({ rowCount: 0 }) });
  const req = { telegramUser: { id: 2 }, body: Buffer.from('invalid') };
  const res = response(); handlers[1](req, res, () => {});
  const blocked = response(); handlers[1]({ telegramUser: { id: 2 } }, blocked, () => assert.fail()); assert.equal(blocked.code, 429);
  await handlers[3](req, res); assert.equal(res.code, 400);
  let passed = false; const retry = { telegramUser: { id: 2 } };
  handlers[1](retry, response(), () => passed = true); assert.ok(passed); retry.releaseStudio();
});

test('real HTTP route requires auth, returns audio, and reports worker readiness', async () => {
  const express = (await import('express')).default;
  const { mountStudioRoutes: mountReal } = await import('../src/studio.js');
  const pcm = Buffer.from(await encodeWav(buffer, true).arrayBuffer());
  const worker = express();
  worker.get('/health', (_req,res) => res.json({ready:true}));
  worker.post('/enhance', express.raw({type:'application/octet-stream'}), (req,res) => res.type('audio/wav').send(req.body));
  const ws = worker.listen(0,'127.0.0.1'); await new Promise(r=>ws.once('listening',r));
  process.env.STUDIO_AI_URL = `http://127.0.0.1:${ws.address().port}`; process.env.STUDIO_AI_TOKEN='test-secret';
  const app = express();
  mountReal(app, { pool: { query: async () => ({ rowCount:1, rows:[{usage_day:'2026-09-29'}] }) }, requireTelegramUser(req,res,next){ if(req.headers['x-telegram-init-data']!=='test')return res.status(401).end();req.telegramUser={id:42};next(); } });
  const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauth = await fetch(url+'/api/studio/enhance',{method:'POST'}); assert.equal(unauth.status,401);
    const health = await fetch(url+'/api/studio/status'); assert.equal((await health.json()).aiAvailable,true);
    const result = await fetch(url+'/api/studio/enhance',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Telegram-Init-Data':'test'},body:pcm});
    assert.equal(result.status,200); assert.equal(result.headers.get('cache-control'),'no-store');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()),pcm);
    const invalid = await fetch(url+'/api/studio/enhance',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Telegram-Init-Data':'test'},body:'bad'});
    assert.equal(invalid.status,400);
  } finally { await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>ws.close(r))]); }
});
