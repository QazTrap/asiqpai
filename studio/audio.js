export const MAX_SECONDS = 180;
export const PRESETS = {
  dry: {
    label: 'Сухой рэп',
    highpass: 85,
    presence: 2,
    ratio: 3,
    reverbMix: 0.08,
    delayMix: 0.07,
    defaults: { tune: false, eq: true, comp: true, reverb: false, delay: false }
  },
  soft: {
    label: 'Мягкий вокал',
    highpass: 70,
    presence: 0.5,
    ratio: 2.5,
    reverbMix: 0.12,
    delayMix: 0.08,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: false }
  },
  space: {
    label: 'Атмосферный',
    highpass: 95,
    presence: 1,
    ratio: 3,
    reverbMix: 0.23,
    delayMix: 0.14,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: true }
  }
};
export function analyse(buffer) {
  let sum = 0, peak = 0, count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (const s of data) { sum += s * s; peak = Math.max(peak, Math.abs(s)); count++; }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(count, 1)) };
}
export function encodeWav(buffer, mono = false) {
  const channels = mono ? 1 : Math.min(2, buffer.numberOfChannels);
  const bytes = new ArrayBuffer(44 + buffer.length * channels * 2);
  const view = new DataView(bytes);
  const ascii = (offset, str) => [...str].forEach((s, i) => view.setUint8(offset + i, s.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
  const data = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) for (let c = 0; c < channels; c++) {
    let s = mono ? data.reduce((a, channel) => a + channel[i], 0) / data.length : data[c][i];
    s = Math.max(-1, Math.min(1, s));
    view.setInt16(offset, Math.round(s * (s < 0 ? 32768 : 32767)), true); offset += 2;
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
function impulse(ctx) {
  const b = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.4), ctx.sampleRate);
  let seed = 123456;
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      d[i] = ((seed / 4294967296) * 2 - 1) * Math.pow(1 - i / d.length, 3);
    }
  }
  return b;
}
export async function renderMix({ beat, vocal, preset = 'dry', processed = true, effects = null, offset = 0, beatLevel = 0.6, vocalLevel = 1 }) {
  if (!beat || !vocal) throw new Error('Сначала выберите бит и добавьте голос.');
  if (![offset, beatLevel, vocalLevel].every(Number.isFinite)) throw new Error('Некорректные настройки микса.');
  offset = Math.max(-10, Math.min(MAX_SECONDS, offset));
  const duration = Math.min(MAX_SECONDS + 2, Math.max(Math.min(beat.duration, MAX_SECONDS), vocal.duration + offset) + 1.5);
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * 44100), 44100);
  const master = ctx.createGain(); master.gain.value = 0.75; master.connect(ctx.destination);
  const backing = ctx.createBufferSource(); backing.buffer = beat;
  const bg = ctx.createGain(); bg.gain.value = beatLevel; backing.connect(bg).connect(master);
  backing.start(0, 0, Math.min(beat.duration, MAX_SECONDS));
  const voice = ctx.createBufferSource(); voice.buffer = vocal;
  const vg = ctx.createGain(); vg.gain.value = vocalLevel;
  let output = voice;
  if (processed) {
    const p = PRESETS[preset] || PRESETS.dry;
    const enabled = { ...p.defaults, ...(effects || {}) };
    const stats = analyse(vocal);
    const normal = ctx.createGain();
    normal.gain.value = stats.rms > 0.0001 ? Math.min(4, 0.12 / stats.rms) : 1;
    voice.connect(normal);
    output = normal;

    if (enabled.eq) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.highpass;
      const eq = ctx.createBiquadFilter();
      eq.type = 'peaking';
      eq.frequency.value = 3000;
      eq.Q.value = 0.7;
      eq.gain.value = p.presence;
      output.connect(hp).connect(eq);
      output = eq;
    }

    if (enabled.comp) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.ratio.value = p.ratio;
      comp.knee.value = 12;
      comp.attack.value = 0.005;
      comp.release.value = 0.15;
      output.connect(comp);
      output = comp;
    }

    if (enabled.reverb) {
      const reverb = ctx.createConvolver();
      reverb.buffer = impulse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = p.reverbMix;
      output.connect(reverb).connect(wet).connect(vg);
    }

    if (enabled.delay) {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.24;
      const wet = ctx.createGain();
      wet.gain.value = p.delayMix;
      output.connect(delay).connect(wet).connect(vg);
    }
  }
  output.connect(vg).connect(master);
  const skip = Math.max(0, -offset);
  if (skip < vocal.duration) voice.start(Math.max(0, offset), skip);
  const result = await ctx.startRendering();
  const { peak } = analyse(result);
  if (peak > 0.97) for (let c = 0; c < result.numberOfChannels; c++) {
    const d = result.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= 0.97 / peak;
  }
  return result;
}
