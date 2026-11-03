import { MAX_SECONDS, analyse, encodeWav, renderSessionMix } from '../../studio/audio.js';
import { measureProMixStats } from '../../studio/pro-mix.js';

const $ = id => document.getElementById(id);
const state = { beat: null, vocals: { mid: null, back: null, adlibs: null }, recording: false, busy: false, urls: new Map(), recorder: null, stream: null, ctx: null, liveBeat: null };
const LABELS = { mid: 'MID', back: 'BACK', adlibs: 'ADLIBS' };

function report(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function revoke(key) {
  if (state.urls.has(key)) URL.revokeObjectURL(state.urls.get(key));
  state.urls.delete(key);
}
function audioUrl(key, file) {
  revoke(key);
  const url = URL.createObjectURL(file);
  state.urls.set(key, url);
  return url;
}
function disable(enabled) {
  state.busy = enabled;
  $('render').disabled = enabled || !state.beat || !Object.values(state.vocals).some(Boolean);
  $('record').disabled = enabled || state.recording || !state.beat || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  $('stop').disabled = !state.recording;
  for (const id of ['beat', 'mid', 'back', 'adlibs', 'recordTrack', 'style', 'enabled', 'intensity', 'beatVolume', 'offset']) {
    $(id).disabled = enabled || state.recording;
  }
}
async function audioContext() {
  state.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  await state.ctx.resume();
  return state.ctx;
}
async function decode(file) {
  if (!file || file.size > 45 * 1024 * 1024) throw new Error('Файл больше 45 МБ — выберите короткий WAV / MP3.');
  const ctx = await audioContext();
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  if (!buffer.length || buffer.duration > MAX_SECONDS + 0.1) throw new Error('Длительность аудио должна быть до 3 минут.');
  return buffer;
}
function resetResults() {
  $('results').hidden = true;
  for (const id of ['before', 'after']) {
    $(id).pause();
    $(id).removeAttribute('src');
    $(id).load();
    revoke(id);
  }
  revoke('download');
}
function refreshVoiceDetails() {
  const ready = Object.entries(state.vocals).filter(([, b]) => Boolean(b));
  $('voiceDetails').textContent = ready.length
    ? ready.map(([id, b]) => LABELS[id] + ': ' + b.duration.toFixed(1) + ' c').join(' · ')
    : 'Ни одной записанной дорожки.';
  disable(false);
}
async function onFile(id, setter) {
  const file = $(id).files?.[0];
  if (!file) return;
  resetResults();
  disable(true);
  try {
    report('Читаем ' + file.name + '…');
    const buffer = await decode(file);
    setter(buffer);
    report('✓ Загружено: ' + file.name + ', ' + buffer.duration.toFixed(1) + ' с.');
  } catch (error) {
    report(error.message || 'Не удалось открыть аудио.', true);
  } finally {
    disable(false);
    refreshVoiceDetails();
  }
}
$('beat').addEventListener('change', () => onFile('beat', b => {
  state.beat = b;
  $('beatDetails').textContent = 'Бит готов: ' + b.duration.toFixed(1) + ' с. · ' + b.sampleRate + ' Hz';
}));
for (const id of Object.keys(state.vocals)) {
  $(id).addEventListener('change', () => onFile(id, b => { state.vocals[id] = b; }));
}
$('enabled').addEventListener('change', () => {
  $('options').hidden = !$('enabled').checked;
  resetResults();
});
$('style').addEventListener('change', resetResults);
$('intensity').addEventListener('input', () => {
  $('intensityText').textContent = $('intensity').value + '%';
  resetResults();
});
$('beatVolume').addEventListener('input', () => {
  $('beatVolumeText').textContent = $('beatVolume').value + '%';
  resetResults();
});
$('offset').addEventListener('input', () => {
  $('offsetText').textContent = $('offset').value + ' ms';
  resetResults();
});
$('render').addEventListener('click', async () => {
  disable(true);
  resetResults();
  try {
    const tracks = Object.entries(state.vocals).filter(([, vocal]) => vocal).map(([id, vocal]) => ({
      id, vocal,
      preset: id === 'mid' ? 'premium' : id === 'back' ? 'back' : 'adlibs',
      effects: { tune: false, eq: true, comp: true, reverb: id !== 'mid', delay: id === 'adlibs' },
      offset: Number($('offset').value) / 1000,
      level: id === 'mid' ? 1 : 0.76,
      pan: 0, width: id === 'mid' ? 0 : id === 'back' ? 0.75 : 0.55
    }));
    const beatLevel = Number($('beatVolume').value) / 100;
    report('Создаём контрольную версию без PRO MIX…');
    const before = await renderSessionMix({beat:state.beat, tracks, beatLevel, processed:true});
    report($('enabled').checked ? 'PRO MIX: обрабатываем дорожки и общий микс…' : 'Собираем WAV без дополнительного PRO MIX…');
    const after = await renderSessionMix({
      beat:state.beat, tracks, beatLevel, processed:true,
      proMix: {enabled:$('enabled').checked, style:$('style').value, intensity:Number($('intensity').value)}
    });
    const finalWav = encodeWav(after);
    $('before').src = audioUrl('before', encodeWav(before));
    $('after').src = audioUrl('after', finalWav);
    $('download').href = audioUrl('download', finalWav);
    const s1 = measureProMixStats(before), s2 = measureProMixStats(after);
    const fmt = v => v === null ? 'тишина' : v + ' dBFS';
    $('report').textContent = 'Sample peak: ' + fmt(s1.peakDbfs) + ' → ' + fmt(s2.peakDbfs) + ' · RMS: ' + fmt(s1.rmsDbfs) + ' → ' + fmt(s2.rmsDbfs) + '. RMS — не LUFS.';
    $('results').hidden = false;
    report('✓ Готово. Сравните два варианта и сохраните WAV.');
    $('results').scrollIntoView({block:'start',behavior:'smooth'});
  } catch (error) {
    report(error.message || 'Ошибка сведения. Попробуйте более короткие файлы.', true);
  } finally {
    disable(false);
  }
});
$('record').addEventListener('click', async () => {
  if (!state.beat || state.recording) return;
  try {
    const ctx = await audioContext();
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio:{ channelCount:1, echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    const mimeType = ['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(state.stream, mimeType ? {mimeType} : undefined);
    const chunks = [];
    const target = $('recordTrack').value;
    state.recorder = recorder;
    recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener('stop', async () => {
      state.liveBeat?.stop?.();
      state.liveBeat = null;
      state.stream?.getTracks().forEach(track => track.stop());
      state.stream = null;
      state.recording = false;
      disable(false);
      report('Обрабатываем запись с микрофона…');
      try {
        const blob = new Blob(chunks, {type:recorder.mimeType || 'audio/mp4'});
        state.vocals[target] = await decode(blob);
        refreshVoiceDetails();
        report('✓ Запись ' + LABELS[target] + ' готова. Нажмите «Свести трек».');
      } catch (error) {
        report('Не удалось прочитать запись. Попробуйте другой браузер или загрузите WAV. ' + (error.message || ''), true);
      }
    },{once:true});
    resetResults();
    recorder.start();
    state.recording = true;
    disable(false);
    const source = ctx.createBufferSource();
    source.buffer = state.beat;
    const gain = ctx.createGain();
    gain.gain.value = Number($('beatVolume').value)/100;
    source.connect(gain).connect(ctx.destination);
    state.liveBeat = source;
    source.onended = () => { if(state.recording) $('stop').click(); };
    source.start();
    report('● Запись ' + LABELS[target] + ' идёт. Бит играет в наушниках. Не закрывайте страницу.');
  } catch(error) {
    state.recording = false;
    state.stream?.getTracks().forEach(track => track.stop());
    state.stream = null;
    disable(false);
    report('Микрофон недоступен. Разрешите доступ или загрузите вокал. ' + (error.message||''), true);
  }
});
$('stop').addEventListener('click', () => {
  if (!state.recording) return;
  state.recording = false;
  try { state.liveBeat?.stop?.(); } catch {}
  state.liveBeat = null;
  if (state.recorder?.state === 'recording') state.recorder.stop();
  disable(true);
  report('Останавливаем запись…');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.recording) $('stop').click();
});
window.addEventListener('pagehide', () => {
  for(const key of state.urls.keys()) revoke(key);
  state.stream?.getTracks().forEach(track => track.stop());
  state.ctx?.close();
});
disable(false);
