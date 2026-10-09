/**
 * ASIQPAI PRO MIX v1 — deterministic Web Audio signal chain.
 *
 * No voice cloning, transcription, tempo changes, or generative AI.
 * It retains the recorded performance and runs locally in the browser.
 * Server-side AI CLEAN / TUNE remain separate optional features.
 */
export const PRO_MIX_STYLES = Object.freeze({
  dry: Object.freeze({
    label: 'DRY PUNCH',
    lowCut: 76, mudDb: -3.2, presenceDb: 1.8, airDb: -0.7,
    drive: 1.55, masterThreshold: -12, masterRatio: 1.75
  }),
  heavy: Object.freeze({
    label: 'HEAVY',
    lowCut: 86, mudDb: -4.2, presenceDb: 3.1, airDb: -1.0,
    drive: 1.85, masterThreshold: -15, masterRatio: 2.2
  })
});

function clamp(value, low, high, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
}

export function resolveProMixSettings(settings) {
  const style = Object.hasOwn(PRO_MIX_STYLES, settings?.style) ? settings.style : 'dry';
  return {
    enabled: settings?.enabled === true,
    style,
    intensity: clamp(settings?.intensity, 0, 100, 65)
  };
}

function filter(ctx, input, type, frequency, gain = 0, q = 0.9) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  node.gain.value = gain;
  input.connect(node);
  return node;
}

function saturate(ctx, input, drive, wet = 1) {
  const shaper = ctx.createWaveShaper();
  const resolution = 1025;
  const curve = new Float32Array(resolution);
  const norm = Math.tanh(drive);
  for (let i = 0; i < resolution; i++) {
    const x = (i / (resolution - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  const level = ctx.createGain();
  level.gain.value = wet;
  input.connect(shaper);
  shaper.connect(level);
  return level;
}

export function applyVocalProMix(ctx, input, settings, trackId = 'mid') {
  const resolved = resolveProMixSettings(settings);
  if (!resolved.enabled || resolved.intensity === 0) return input;
  const style = PRO_MIX_STYLES[resolved.style];
  const amount = resolved.intensity / 100;
  const isLead = trackId === 'mid';

  let output = filter(ctx, input, 'highpass', style.lowCut);
  output = filter(ctx, output, 'peaking', 280, style.mudDb * amount, 1.05);
  output = filter(ctx, output, 'peaking', 3400, style.presenceDb * amount * (isLead ? 1 : 0.65), 0.85);
  // Soften harsh sibilance, rather than claiming a full adaptive de-esser.
  output = filter(ctx, output, 'highshelf', 7900, style.airDb * amount, 0.7);
  return saturate(ctx, output, 1 + (style.drive - 1) * amount, 0.92);
}

export function routeProMixMaster(ctx, input, destination, settings) {
  const resolved = resolveProMixSettings(settings);
  if (!resolved.enabled || resolved.intensity === 0) {
    input.connect(destination);
    return input;
  }
  const style = PRO_MIX_STYLES[resolved.style];
  const amount = resolved.intensity / 100;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -10 + (style.masterThreshold + 10) * amount;
  compressor.ratio.value = 1 + (style.masterRatio - 1) * amount;
  compressor.knee.value = 9;
  compressor.attack.value = 0.02;
  compressor.release.value = 0.19;
  input.connect(compressor);
  const out = saturate(ctx, compressor, 1 + 0.16 * amount, 0.96);
  out.connect(destination);
  return out;
}

export function measureProMixStats(buffer) {
  let sum = 0, peak = 0, count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i];
      if (!Number.isFinite(value)) continue;
      peak = Math.max(peak, Math.abs(value));
      sum += value * value;
      count++;
    }
  }
  const db = value => value > 0 ? Number((20 * Math.log10(value)).toFixed(1)) : null;
  return Object.freeze({ peakDbfs: db(peak), rmsDbfs: db(Math.sqrt(sum / Math.max(count, 1))) });
}
