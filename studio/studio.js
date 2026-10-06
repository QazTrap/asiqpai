import { MAX_SECONDS, analyse, encodeWav, renderMix, PRESETS } from './audio.js';

export function mountStudio({ apiUrl }) {
  const el = id => document.getElementById(`studio-${id}`);
  if (!el('beat')) return;
  let ctx, beat, vocal, serverVocal, serverVocalSignature = '', recorder, stream, backing, recordingTimer;
  let busy = false, recording = false, disposed = false, elapsed = 0, mixBlob, beatName = 'demo';
  let aiAvailable = false, tuneAvailable = false, initialized = false;
  let effectState = { ...PRESETS.dry.defaults };
  let bypassAll = false;
  const urls = new Map();
  const status = (message, error = false) => { el('status').textContent = message; el('status').classList.toggle('error', error); };
  const setURL = (id, blob) => {
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    const url = URL.createObjectURL(blob); urls.set(id, url); return url;
  };
  function syncFxButtons() {
    document.querySelectorAll('[data-studio-fx]').forEach(button => {
      const key = button.dataset.studioFx;
      const active = Boolean(effectState[key]);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      const state = button.querySelector('small');
      if (state) state.textContent = active ? 'ON' : 'OFF';
    });
    const tuneSettings = el('tune-settings');
    if (tuneSettings) tuneSettings.hidden = !effectState.tune;
    const bypass = el('bypass');
    if (bypass) {
      bypass.classList.toggle('active', bypassAll);
      bypass.setAttribute('aria-pressed', bypassAll ? 'true' : 'false');
      bypass.textContent = bypassAll ? 'BYPASS ALL · ON' : 'BYPASS ALL';
    }
  }
  function applyPresetDefaults() {
    const preset = PRESETS[el('preset').value] || PRESETS.dry;
    effectState = { ...preset.defaults };
    bypassAll = false;
    syncFxButtons();
    invalidate();
  }
  function controls() {
    for (const id of ['beat', 'upload', 'preset', 'beat-level', 'voice-level', 'offset']) el(id).disabled = busy || recording;
    for (const id of ['tune-key', 'tune-scale', 'tune-amount', 'tune-speed']) {
      if (el(id)) el(id).disabled = busy || recording || !effectState.tune || !tuneAvailable;
    }
    el('record').disabled = busy || recording || !beat || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
    el('stop').disabled = !recording;
    el('process').disabled = busy || recording || !beat || !vocal;
    el('ai').disabled = busy || recording || !aiAvailable;
    document.querySelectorAll('[data-studio-fx]').forEach(button => {
      button.disabled = busy || recording || (button.dataset.studioFx === 'tune' && !tuneAvailable);
    });
    if (el('bypass')) el('bypass').disabled = busy || recording;
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
  function centerVoice(buffer) {
    if (buffer.numberOfChannels === 1) return buffer;

    const channels = Array.from(
      { length: buffer.numberOfChannels },
      (_, c) => buffer.getChannelData(c)
    );

    const energies = channels.map(data => {
      let sum = 0;
      for (const sample of data) sum += sample * sample;
      return Math.sqrt(sum / Math.max(data.length, 1));
    });

    const loudest = energies.reduce(
      (best, value, index) => value > best.value ? { value, index } : best,
      { value: -1, index: 0 }
    );
    const others = energies.filter((_, index) => index !== loudest.index);
    const next = Math.max(0, ...others);

    const mono = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
    const out = mono.getChannelData(0);

    // Some mobile/wired headset inputs arrive as "stereo" with the mic only
    // in one channel. Preserve that channel at full level instead of halving it.
    if (next === 0 || loudest.value > next * 4) {
      out.set(channels[loudest.index]);
      return mono;
    }

    for (let i = 0; i < buffer.length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      out[i] = sample / channels.length;
    }
    return mono;
  }

  function acceptVoice(buffer) {
    const centered = centerVoice(buffer);
    vocal = centered; serverVocal = null; serverVocalSignature = ''; invalidate(); wave(centered);
    el('voice-preview').src = setURL('voice-preview', encodeWav(centered));
    const stats = analyse(centered);
    el('vocal-info').textContent = `Вокал: ${centered.duration.toFixed(1)} с · MONO / CENTER${stats.peak >= 0.999 ? ' · Запись перегружена: попробуйте отойти от микрофона.' : ''}`;
    status(stats.rms < 0.001 ? 'Запись очень тихая. Проверьте микрофон.' : 'Голос добавлен по центру. Выберите звучание и соберите демо.');
  }
  el('beat').addEventListener('change', () => action(async () => {
    await context();
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
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    const inputTrack = stream.getAudioTracks()[0];
    const inputName = inputTrack?.label?.trim() || 'Микрофон устройства';
    const inputSource = el('input-source');
    if (inputSource) {
      inputSource.textContent = `🎙 Источник записи: ${inputName}`;
      if (/airpods|bluetooth/i.test(inputName)) {
        inputSource.textContent += ' ⚠ Для лучшего качества используйте USB-микрофон.';
      }
    }
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
  el('preset').addEventListener('change', applyPresetDefaults);
  for (const id of ['ai', 'offset', 'beat-level', 'voice-level']) el(id).addEventListener('input', () => {
    invalidate();
    el('beat-value').textContent = `${el('beat-level').value}%`;
    el('voice-value').textContent = `${el('voice-level').value}%`;
  });
  for (const id of ['tune-key', 'tune-scale', 'tune-amount', 'tune-speed']) {
    el(id)?.addEventListener('input', () => {
      invalidate();
      if (el('tune-amount-value')) el('tune-amount-value').textContent = `${el('tune-amount').value}%`;
      if (el('tune-speed-value')) el('tune-speed-value').textContent = `${el('tune-speed').value}%`;
    });
  }
  document.querySelectorAll('[data-studio-fx]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.studioFx;
      if (!Object.hasOwn(effectState, key)) return;
      if (key === 'tune' && !tuneAvailable) return;
      effectState[key] = !effectState[key];
      bypassAll = false;
      syncFxButtons();
      invalidate();
      try { window.Telegram?.WebApp?.HapticFeedback?.selectionChanged(); } catch {}
    });
  });
  el('bypass')?.addEventListener('click', () => {
    bypassAll = !bypassAll;
    syncFxButtons();
    invalidate();
    try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light'); } catch {}
  });
  el('process').addEventListener('click', () => action(async () => {
    for (const a of document.querySelectorAll('audio')) a.pause();
    invalidate();
    const offset = Number(el('offset').value);
    if (!el('offset').checkValidity() || !Number.isFinite(offset) || offset >= MAX_SECONDS || offset <= -vocal.duration) throw new Error('Укажите сдвиг, при котором голос остаётся в пределах демо.');
    if (offset + vocal.duration > MAX_SECONDS + 0.1) throw new Error('Голос со сдвигом выходит за 3 минуты. Уменьшите сдвиг или загрузите более короткую запись.');
    let chosen = vocal;
    const useAiClean = el('ai').checked && !bypassAll;
    const useTune = effectState.tune && !bypassAll;
    if (useTune && !tuneAvailable) throw new Error('TUNE пока недоступен на сервере.');

    if (useAiClean || useTune) {
      const initData = window.Telegram?.WebApp?.initData || '';
      if (!initData) throw new Error('Для AI CLEAN / TUNE откройте приложение через Telegram.');

      const tuneKey = el('tune-key')?.value || 'F';
      const tuneScale = el('tune-scale')?.value || 'minor';
      const tuneAmount = Number(el('tune-amount')?.value || 70);
      const tuneSpeed = Number(el('tune-speed')?.value || 35);
      const signature = JSON.stringify({
        clean: useAiClean,
        tune: useTune,
        key: tuneKey,
        scale: tuneScale,
        amount: tuneAmount,
        speed: tuneSpeed
      });

      if (!serverVocal || serverVocalSignature !== signature) {
        status(useTune
          ? (useAiClean ? 'AI очищает вокал и корректирует ноты…' : 'TUNE корректирует вокал по тональности…')
          : 'AI очищает вокал. Это может занять до 2–3 минут…'
        );

        const response = await fetch(`${apiUrl}/api/studio/enhance`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Telegram-Init-Data': initData,
            'X-Studio-Clean': useAiClean ? '1' : '0',
            'X-Studio-Tune': useTune ? '1' : '0',
            'X-Studio-Key': tuneKey,
            'X-Studio-Scale': tuneScale,
            'X-Studio-Amount': String(tuneAmount),
            'X-Studio-Speed': String(tuneSpeed)
          },
          body: encodeWav(vocal, true),
          signal: AbortSignal.timeout(255000)
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || 'Vocal AI недоступен. Повторите позже или выключите AI CLEAN / TUNE.');
        }
        serverVocal = await decode(await response.blob(), MAX_SECONDS + 1);
        serverVocalSignature = signature;
      }
      chosen = serverVocal;
    }
    const settings = { beat, offset, preset: el('preset').value, beatLevel: Number(el('beat-level').value) / 100, vocalLevel: Number(el('voice-level').value) / 100 };
    status('Собираем вариант до обработки…');
    const before = await renderMix({ ...settings, vocal, processed: false });
    el('before').src = setURL('before', encodeWav(before));
    status(bypassAll ? 'Собираем WAV без эффектов…' : 'Применяем выбранные эффекты и собираем WAV…');
    const after = await renderMix({ ...settings, vocal: chosen, processed: !bypassAll, effects: effectState });
    mixBlob = encodeWav(after); el('after').src = setURL('after', mixBlob);
    el('download').href = setURL('download', mixBlob);
    const name = beatName.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60) || 'demo';
    el('download').download = `ASIQPAI-${name}-demo.wav`;
    const file = new File([mixBlob], el('download').download, { type: 'audio/wav' });
    el('share').hidden = !navigator.canShare?.({ files: [file] });
    const activeFx = bypassAll
      ? ['BYPASS ALL']
      : [
          useAiClean ? 'AI CLEAN' : null,
          useTune ? `TUNE ${el('tune-key')?.value || 'F'} ${(el('tune-scale')?.value || 'minor').toUpperCase()}` : null,
          effectState.eq ? 'EQ' : null,
          effectState.comp ? 'COMP' : null,
          effectState.reverb ? 'REVERB' : null,
          effectState.delay ? 'DELAY' : null
        ].filter(Boolean);
    el('result-info').textContent = `${PRESETS[el('preset').value].label} · ${activeFx.join(' + ') || 'DRY'} · WAV, 44,1 кГц · ${(mixBlob.size / 1048576).toFixed(1)} МБ`;
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
      tuneAvailable = result.tuneAvailable === true;
    } catch {
      aiAvailable = false;
      tuneAvailable = false;
    }
    el('ai-state').textContent = aiAvailable ? '— доступна' : '— сервер не подключён';
    const tuneButton = document.querySelector('[data-studio-fx="tune"]');
    if (tuneButton && !tuneAvailable) {
      tuneButton.title = 'TUNE пока недоступен на сервере';
    }
    syncFxButtons();
    controls();
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
  syncFxButtons();
  controls();
}
