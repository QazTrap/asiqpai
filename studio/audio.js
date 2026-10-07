export const MAX_SECONDS = 180;

export const PRESETS = {
  clean: {
    label: 'MID · CLEAN',
    highpass: 82,
    presence: 2.1,
    ratio: 3.2,
    threshold: -20,
    reverbMix: 0.045,
    delayMix: 0.035,
    defaults: { tune: false, eq: true, comp: true, reverb: false, delay: false }
  },
  premium: {
    label: 'MID · PREMIUM',
    highpass: 78,
    presence: 2.8,
    ratio: 3.8,
    threshold: -22,
    reverbMix: 0.085,
    delayMix: 0.055,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: false }
  },
  dark: {
    label: 'MID · DARK',
    highpass: 92,
    presence: 0.8,
    ratio: 4.0,
    threshold: -22,
    reverbMix: 0.12,
    delayMix: 0.075,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: true }
  },
  back: {
    label: 'BACK · WIDE',
    highpass: 135,
    presence: 1.2,
    ratio: 4.2,
    threshold: -23,
    reverbMix: 0.17,
    delayMix: 0.12,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: true }
  },
  adlibs: {
    label: 'ADLIBS · SPACE',
    highpass: 120,
    presence: 2.0,
    ratio: 4.0,
    threshold: -22,
    reverbMix: 0.24,
    delayMix: 0.17,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: true }
  },

  // Legacy preset keys kept for older saved sessions / UI compatibility.
  dry: {
    label: 'Сухой рэп',
    highpass: 85,
    presence: 2,
    ratio: 3,
    threshold: -20,
    reverbMix: 0.08,
    delayMix: 0.07,
    defaults: { tune: false, eq: true, comp: true, reverb: false, delay: false }
  },
  soft: {
    label: 'Мягкий вокал',
    highpass: 70,
    presence: 0.5,
    ratio: 2.5,
    threshold: -20,
    reverbMix: 0.12,
    delayMix: 0.08,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: false }
  },
  space: {
    label: 'Атмосферный',
    highpass: 95,
    presence: 1,
    ratio: 3,
    threshold: -20,
    reverbMix: 0.23,
    delayMix: 0.14,
    defaults: { tune: false, eq: true, comp: true, reverb: true, delay: true }
  }
};

export function analyse(buffer) {
  let sum = 0, peak = 0, count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (const s of data) {
      sum += s * s;
      peak = Math.max(peak, Math.abs(s));
      count++;
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(count, 1)) };
}

export function encodeWav(buffer, mono = false) {
  const channels = mono ? 1 : Math.min(2, buffer.numberOfChannels);
  const bytes = new ArrayBuffer(44 + buffer.length * channels * 2);
  const view = new DataView(bytes);
  const ascii = (offset, str) => [...str].forEach((s, i) => view.setUint8(offset + i, s.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes.byteLength - 44, true);
  const data = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < channels; c++) {
      let s = mono
        ? data.reduce((a, channel) => a + channel[i], 0) / data.length
        : data[c][i];
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, Math.round(s * (s < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
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

function connectPan(ctx, input, destination, pan = 0, gainValue = 1) {
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  input.connect(gain);
  if (typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    gain.connect(panner).connect(destination);
    return panner;
  }
  gain.connect(destination);
  return gain;
}

function connectVoice({
  ctx,
  voice,
  destination,
  vocal,
  preset = 'premium',
  effects = null,
  processed = true,
  level = 1,
  pan = 0,
  width = 0
}) {
  const p = PRESETS[preset] || PRESETS.premium;
  const enabled = { ...p.defaults, ...(effects || {}) };
  let output = voice;

  if (processed) {
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
      comp.threshold.value = Number.isFinite(p.threshold) ? p.threshold : -20;
      comp.ratio.value = p.ratio;
      comp.knee.value = 12;
      comp.attack.value = 0.005;
      comp.release.value = 0.15;
      output.connect(comp);
      output = comp;
    }
  }

  const dryBus = ctx.createGain();
  dryBus.gain.value = Math.max(0, level);
  output.connect(dryBus);

  const stereoWidth = Math.max(0, Math.min(1, width));
  if (stereoWidth > 0.02) {
    const center = ctx.createGain();
    center.gain.value = Math.max(0.2, 1 - stereoWidth * 0.72);
    dryBus.connect(center);
    connectPan(ctx, center, destination, pan, 1);

    const leftDelay = ctx.createDelay(0.05);
    const rightDelay = ctx.createDelay(0.05);
    leftDelay.delayTime.value = 0.007;
    rightDelay.delayTime.value = 0.018;
    dryBus.connect(leftDelay);
    dryBus.connect(rightDelay);
    connectPan(ctx, leftDelay, destination, Math.max(-1, pan - stereoWidth), 0.42 * stereoWidth);
    connectPan(ctx, rightDelay, destination, Math.min(1, pan + stereoWidth), 0.42 * stereoWidth);
  } else {
    connectPan(ctx, dryBus, destination, pan, 1);
  }

  if (processed && enabled.reverb) {
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = p.reverbMix * Math.max(0, level);
    output.connect(reverb).connect(wet);
    connectPan(ctx, wet, destination, pan, 1);
  }

  if (processed && enabled.delay) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.24;
    const wet = ctx.createGain();
    wet.gain.value = p.delayMix * Math.max(0, level);
    output.connect(delay).connect(wet);
    connectPan(ctx, wet, destination, pan, 1);
  }
}

function startVoiceSource(source, vocal, offset = 0) {
  const safeOffset = Math.max(-10, Math.min(MAX_SECONDS, Number(offset) || 0));
  const skip = Math.max(0, -safeOffset);
  if (skip < vocal.duration) source.start(Math.max(0, safeOffset), skip);
}

async function normalizeRendered(result) {
  const { peak } = analyse(result);
  if (peak > 0.97) {
    const scale = 0.97 / peak;
    for (let c = 0; c < result.numberOfChannels; c++) {
      const d = result.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= scale;
    }
  }
  return result;
}

export async function renderSessionMix({
  beat,
  tracks = [],
  beatLevel = 0.6,
  processed = true
}) {
  if (!beat) throw new Error('Сначала выберите бит.');
  const audible = tracks.filter(track => track?.vocal && !track.muted);
  if (!audible.length) throw new Error('Запишите хотя бы одну вокальную дорожку.');

  const hasSolo = audible.some(track => track.solo);
  const selected = hasSolo ? audible.filter(track => track.solo) : audible;
  const maxEnd = selected.reduce((max, track) => {
    const offset = Number(track.offset) || 0;
    return Math.max(max, track.vocal.duration + offset);
  }, 0);
  const duration = Math.min(
    MAX_SECONDS + 2,
    Math.max(Math.min(beat.duration, MAX_SECONDS), maxEnd) + 1.5
  );

  const ctx = new OfflineAudioContext(2, Math.ceil(duration * 44100), 44100);
  const master = ctx.createGain();
  master.gain.value = 0.72;
  master.connect(ctx.destination);

  const backing = ctx.createBufferSource();
  backing.buffer = beat;
  const bg = ctx.createGain();
  bg.gain.value = Math.max(0, Number(beatLevel) || 0);
  backing.connect(bg).connect(master);
  backing.start(0, 0, Math.min(beat.duration, MAX_SECONDS));

  for (const track of selected) {
    const source = ctx.createBufferSource();
    source.buffer = track.vocal;
    connectVoice({
      ctx,
      voice: source,
      destination: master,
      vocal: track.vocal,
      preset: track.preset,
      effects: track.effects,
      processed,
      level: Number.isFinite(track.level) ? track.level : 1,
      pan: Number.isFinite(track.pan) ? track.pan : 0,
      width: Number.isFinite(track.width) ? track.width : 0
    });
    startVoiceSource(source, track.vocal, track.offset);
  }

  return normalizeRendered(await ctx.startRendering());
}

export async function renderMix({
  beat,
  vocal,
  preset = 'dry',
  processed = true,
  effects = null,
  offset = 0,
  beatLevel = 0.6,
  vocalLevel = 1
}) {
  return renderSessionMix({
    beat,
    beatLevel,
    processed,
    tracks: [{
      vocal,
      preset,
      effects,
      offset,
      level: vocalLevel,
      pan: 0,
      width: 0,
      muted: false,
      solo: false
    }]
  });
}
