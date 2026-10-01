import { MAX_SECONDS, analyse, encodeWav, renderMix, PRESETS } from './audio.js';

export function mountStudio({ apiUrl }) {
  const el = id => document.getElementById(`studio-${id}`);
  if (!el('beat')) return;
  let ctx, beat, vocal, cleanVocal, recorder, stream, backing, recordingTimer;
  let busy = false, recording = false, disposed = false, elapsed = 0, mixBlob, beatName = 'demo';
  let aiAvailable = false, initialized = false;
  const urls = new Map();
  const status = (message, error = false) => { el('status').textContent = message; el('status').classList.toggle('error', error); };
  const setURL = (id, blob) => {
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    const url = URL.createObjectURL(blob); urls.set(id, url); return url;
  };
  function controls() {
    for (const id of ['beat', 'upload', 'preset', 'beat-level', 'voice-level', 'offset']) el(id).disabled = busy || recording;
    el('record').disabled = busy || recording || !beat || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
    el('stop').disabled = !recording;
    el('process').disabled = busy || recording || !beat || !vocal;
    el('ai').disabled = busy || recording || !aiAvailable;
    el('beat-preview').controls = !busy && !recording;
    el('voice-preview').controls = !busy && !recording;
  }
  function invalidate() {
    el('result').hidden = true; mixBlob = null;
    for (const id of ['before', 'after']) { el(id).pause(); el(id).removeAttribute('src'); el(id).load(); }
    for (const id of ['before', 'after', 'download']) if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
  }
  async function context() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.OfflineAudioContext) throw new Error('Этот браузер не поддерживает студию. Попробуйте Safari или Chrome.');
    ctx ||= new AC(); await ctx.resume(); return ctx;
  }
  async function decode(blob, max = MAX_SECONDS) {
    if (blob.size > 25 * 1024 * 1024) throw new Error('Файл больше 25 МБ. Сократите запись.');
    const audio = await (await context()).decodeAudioData(await blob.arrayBuffer());
    if (!audio.length || audio.duration > max + 0.25) throw new Error(`Максимальная длительность — ${max} секунд.`);
    return audio;
  }
  async function action(fn) {
    if (busy || recording) return;
    busy = true; controls();
    try { await fn(); } catch (e) { status(e.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону или загрузите готовую запись.' : e.message || 'Не удалось выполнить действие.', true); }
    finally { busy = false; controls(); }
  }
  function wave(buffer) {
    const canvas = el('wave'), c = canvas.getContext('2d'), d = buffer.getChannelData(0);
    c.clearRect(0, 0, canvas.width, canvas.height); c.fillStyle = '#e7c56b';
    for (let x = 0; x < canvas.width; x++) {
      const from = Math.floor(x * d.length / canvas.width), to = Math.floor((x + 1) * d.length / canvas.width);
      let peak = 0; for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(d[i]));
      const h = Math.max(1, peak * 62); c.fillRect(x, (68 - h) / 2, 1, h);
    }
  }
  function acceptVoice(buffer) {
    vocal = buffer; cleanVocal = null; invalidate(); wave(buffer);
    el('voice-preview').src = setURL('voice-preview', encodeWav(buffer));
    const stats = analyse(buffer);
    el('vocal-info').textContent = `Вокал: ${buffer.duration.toFixed(1)} с${stats.peak >= 0.999 ? ' · Запись перегружена: попробуйте отойти от микрофона.' : ''}`;
    status(stats.rms < 0.001 ? 'Запись очень тихая. Проверьте микрофон.' : 'Голос добавлен. Выберите звучание и соберите демо.');
  }
  el('beat').addEventListener('change', () => action(async () => {
    invalidate(); beat = null; el('beat-preview').pause(); el('beat-preview').removeAttribute('src');
    const option = el('beat').selectedOptions[0]; if (!option?.value) return;
    status('Загружаем бит…');
    const response = await fetch(option.value, { signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error('Не удалось загрузить бит. Попробуйте другой.');
    const blob = await response.blob();
    // Existing catalogue beats may exceed three minutes; render only the first three.
    beat = await decode(blob, 600); beatName = option.textContent;
    el('beat-preview').src = setURL('beat-preview', blob);
    status('Бит готов. Запишите голос в наушниках или загрузите отдельную вокальную дорожку.');
  }));
  el('upload').addEventListener('change', () => action(async () => {
    const file = el('upload').files[0]; if (!file) return;
    status('Читаем вокал…');
    const buffer = await decode(file); acceptVoice(buffer); el('offset').value = '0';
    el('upload').value = '';
  }));
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    clearInterval(recordingTimer);
    try { backing?.stop(); } catch {}
    backing = null; stream?.getTracks().forEach(track => track.stop()); stream = null;
    recording = false;
  }
  el('record').addEventListener('click', () => action(async () => {
    await context();
    for (const a of document.querySelectorAll('audio')) a.pause();
    status('Запрашиваем микрофон…');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    if (disposed || !document.getElementById('page-studio')?.classList.contains('active')) { stream.getTracks().forEach(t => t.stop()); stream = null; return; }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
    try { recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream); }
    catch (error) { stream.getTracks().forEach(t => t.stop()); stream = null; throw error; }
    const chunks = []; let recordedBytes = 0;
    recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); recordedBytes += event.data.size; if (recordedBytes > 24 * 1024 * 1024) stopRecording(); } };
    recorder.onerror = () => { status('Ошибка записи. Попробуйте загрузить аудиофайл.', true); stopRecording(); };
    recorder.onstop = async () => {
      busy = true; stopRecording(); controls(); status('Сохраняем дубль…');
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const buffer = await decode(blob, MAX_SECONDS + 2);
        // Timer/codec padding may add a fraction of a second at the limit.
        const count = Math.min(buffer.length, Math.floor(MAX_SECONDS * buffer.sampleRate));
        const trimmed = ctx.createBuffer(buffer.numberOfChannels, count, buffer.sampleRate);
        for (let c = 0; c < buffer.numberOfChannels; c++) trimmed.copyToChannel(buffer.getChannelData(c).subarray(0, count), c);
        acceptVoice(trimmed); el('offset').value = '0';
      } catch (e) { status(`Не удалось сохранить запись: ${e.message}`, true); }
      finally { busy = false; controls(); }
    };
    recorder.onstart = () => {
      backing = ctx.createBufferSource(); backing.buffer = beat;
      const gain = ctx.createGain(); gain.gain.value = Number(el('beat-level').value) / 100;
      backing.connect(gain).connect(ctx.destination); backing.start();
      elapsed = performance.now();
      recordingTimer = setInterval(() => {
        const secs = (performance.now() - elapsed) / 1000;
        status(`● Запись ${Math.floor(secs)} / ${MAX_SECONDS} с. После записи при необходимости поправьте синхронизацию.`);
        if (secs >= Math.min(MAX_SECONDS, beat.duration)) stopRecording();
      }, 200);
    };
    invalidate(); recorder.start(250); recording = true; controls(); status('● Запись началась…');
  }));
  el('stop').addEventListener('click', stopRecording);
  for (const id of ['preset', 'ai', 'offset', 'beat-level', 'voice-level']) el(id).addEventListener('input', () => {
    invalidate(); el('beat-value').textContent = `${el('beat-level').value}%`; el('voice-value').textContent = `${el('voice-level').value}%`;
  });
  el('process').addEventListener('click', () => action(async () => {
    for (const a of document.querySelectorAll('audio')) a.pause();
    invalidate();
    const offset = Number(el('offset').value);
    if (!el('offset').checkValidity() || !Number.isFinite(offset) || offset >= MAX_SECONDS || offset <= -vocal.duration) throw new Error('Укажите сдвиг, при котором голос остаётся в пределах демо.');
    if (offset + vocal.duration > MAX_SECONDS + 0.1) throw new Error('Голос со сдвигом выходит за 3 минуты. Уменьшите сдвиг или загрузите более короткую запись.');
    let chosen = vocal;
    if (el('ai').checked) {
      if (!cleanVocal) {
        status('ИИ очищает вокал. Это может занять до 2–3 минут…');
        const initData = window.Telegram?.WebApp?.initData || '';
        if (!initData) throw new Error('Для ИИ-обработки откройте приложение через Telegram.');
        const response = await fetch(`${apiUrl}/api/studio/enhance`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Telegram-Init-Data': initData },
          body: encodeWav(vocal, true), signal: AbortSignal.timeout(180000)
        });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Сервис ИИ недоступен. Повторите позже или выключите ИИ-очистку.'); }
        cleanVocal = await decode(await response.blob(), MAX_SECONDS + 1);
      }
      chosen = cleanVocal;
    }
    const settings = { beat, offset, preset: el('preset').value, beatLevel: Number(el('beat-level').value) / 100, vocalLevel: Number(el('voice-level').value) / 100 };
    status('Собираем вариант до обработки…');
    const before = await renderMix({ ...settings, vocal, processed: false });
    el('before').src = setURL('before', encodeWav(before));
    status('Применяем эффекты и собираем WAV…');
    const after = await renderMix({ ...settings, vocal: chosen });
    mixBlob = encodeWav(after); el('after').src = setURL('after', mixBlob);
    el('download').href = setURL('download', mixBlob);
    const name = beatName.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60) || 'demo';
    el('download').download = `ASIQPAI-${name}-demo.wav`;
    const file = new File([mixBlob], el('download').download, { type: 'audio/wav' });
    el('share').hidden = !navigator.canShare?.({ files: [file] });
    el('result-info').textContent = `${PRESETS[el('preset').value].label} · ${el('ai').checked ? 'С ИИ-очисткой' : 'Эффекты без ИИ'} · WAV, 44,1 кГц · ${(mixBlob.size / 1048576).toFixed(1)} МБ`;
    el('result').hidden = false; status('Демо готово. Сравните звучание и скачайте результат.');
    el('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  el('share').addEventListener('click', async () => {
    if (!mixBlob) return;
    try { await navigator.share({ files: [new File([mixBlob], el('download').download, { type: 'audio/wav' })] }); }
    catch (e) { if (e.name !== 'AbortError') status('Не удалось поделиться. Используйте «Скачать WAV».', true); }
  });
  for (const id of ['before', 'after', 'beat-preview', 'voice-preview']) el(id).addEventListener('play', () => {
    if (recording || busy) { el(id).pause(); return; }
    for (const a of document.querySelectorAll('audio')) if (a !== el(id)) a.pause();
  });
  async function initialize() {
    if (initialized) return; initialized = true;
    try {
      const response = await fetch('tracks.json', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Каталог недоступен.');
      const tracks = await response.json();
      for (const track of tracks.filter(t => /INSTRUMENTAL|BEAT|БИТ|ИНСТРУМЕНТАЛ/i.test(t.meta || ''))) {
        const url = new URL(track.file, location.href); if (url.origin !== location.origin) continue;
        const option = document.createElement('option'); option.value = url.href; option.textContent = track.title; el('beat').append(option);
      }
      status('Выберите бит, затем добавьте голос.');
    } catch (e) { initialized = false; status(`${e.message} Откройте студию повторно.`, true); }
    try {
      const response = await fetch(`${apiUrl}/api/studio/status`, { signal: AbortSignal.timeout(8000) });
      const result = response.ok ? await response.json() : {};
      aiAvailable = result.aiAvailable === true;
    } catch { aiAvailable = false; }
    el('ai-state').textContent = aiAvailable ? '— доступна' : '— сервер не подключён'; controls();
  }
  window.addEventListener('asiqpai:page', event => {
    if (event.detail === 'studio') initialize();
    else { if (recording) stopRecording(); for (const id of ['before', 'after', 'beat-preview', 'voice-preview']) el(id).pause(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && recording) stopRecording(); });
  window.addEventListener('pagehide', () => {
    disposed = true; if (recording) stopRecording(); stream?.getTracks().forEach(t => t.stop());
    for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear();
  });
  controls();
}
