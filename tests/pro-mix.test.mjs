import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProMixSettings, applyVocalProMix, routeProMixMaster, measureProMixStats } from '../studio/pro-mix.js';

function makeNode(type, registry) {
  const node = {
    type,
    connections: [],
    frequency: { value: 0 }, gain: { value: 0 }, Q: { value: 0 },
    threshold: { value: 0 }, ratio: { value: 0 }, knee: { value: 0 },
    attack: { value: 0 }, release: { value: 0 },
    connect(to) { this.connections.push(to); return to; }
  };
  registry.push(node);
  return node;
}
function fakeContext() {
  const nodes = [];
  const ctx = {
    createBiquadFilter: () => makeNode('biquad', nodes),
    createWaveShaper: () => makeNode('waveshaper', nodes),
    createGain: () => makeNode('gain', nodes),
    createDynamicsCompressor: () => makeNode('compressor', nodes)
  };
  return { ctx, nodes };
}

test('off by default, bounds intensity, validates style', () => {
  assert.deepEqual(resolveProMixSettings({ style: '__proto__', intensity: 200 }), {
    enabled: false, style: 'dry', intensity: 100
  });
  assert.equal(resolveProMixSettings({ enabled: true, intensity: -5 }).intensity, 0);
  assert.equal(resolveProMixSettings({ enabled: true, intensity: NaN }).intensity, 65);
});

test('disabled mode routes unchanged input to output', () => {
  const {ctx, nodes} = fakeContext();
  const input = makeNode('input', nodes), destination = makeNode('destination', nodes);
  assert.equal(applyVocalProMix(ctx, input, {enabled:false}), input);
  routeProMixMaster(ctx, input, destination, {enabled:false});
  assert.deepEqual(input.connections, [destination]);
  assert.equal(nodes.length, 2);
});

test('enabled mode uses vocal filters, soft saturation and master glue', () => {
  const {ctx, nodes} = fakeContext();
  const input = makeNode('input', nodes), master = makeNode('master', nodes);
  const settings = { enabled:true, style:'heavy', intensity:70 };
  const vocalOut = applyVocalProMix(ctx, input, settings, 'mid');
  assert.notEqual(vocalOut, input);
  assert.equal(nodes.filter(n=>n.type==='biquad').length, 4);
  assert.ok(nodes.some(n=>n.type==='waveshaper' && n.curve.length===1025));
  assert.ok(nodes.filter(n=>n.type==='biquad').every(n=>Number.isFinite(n.frequency.value)));
  routeProMixMaster(ctx, vocalOut, master, settings);
  const comp = nodes.find(n=>n.type==='compressor');
  assert.ok(comp && comp.ratio.value > 1);
  assert.ok(nodes.some(n=>n.connections.includes(master)));
});

test('renders understandable peak/RMS measurements, including silence', () => {
  const buffer = { numberOfChannels:2, getChannelData:()=>Float32Array.from([0, 0.5, -0.5, 0]) };
  const stats = measureProMixStats(buffer);
  assert.equal(stats.peakDbfs, -6);
  assert.ok(stats.rmsDbfs < stats.peakDbfs);
  assert.deepEqual(measureProMixStats({ numberOfChannels:1, getChannelData:()=>new Float32Array(5) }), {peakDbfs:null,rmsDbfs:null});
});
