import { MAX_SECONDS, analyse, encodeWav, renderMix, PRESETS } from './audio.js';

export function mountStudio({ apiUrl }) {
  const el = id => document.getElementById(`studio-${id}`);
  if (!el('beat')) return;
  let ctx, beat, vocal, serverVocal, serverVocalSignature = '', recorder, stream, backing, recordingTimer;
  let busy = false, recording = false, disposed = false, elapsed = 0, mixBlob, beatName = 'demo';
  let aiAvailable = false, tuneAvailable = false, initialized = false, backgroundInterrupted = false;
  let sourceVocal = null, vocalSegments = [], editorCursor = 0, selectedSegmentId = null, editorDrag = null, segmentSeq = 0;
  let effectState = { ...PRESETS.dry.defaults };
  let bypassAll = false;
  const urls = new Map();
  const status = (message, error = false) => { el('status').textContent = message; el('status').classList.toggle('error', error); };
  const lyricsStorageKey = 'asiqpai-vocal-ai-lyrics-v1';
  function syncTeleprompterText() {
    const input = el('lyrics-input'), view = el('teleprompter-text');
    if (view) view.textContent = input?.value || '';
  }
  function setTeleprompter(open) {
    const panel = el('teleprompter');
    if (!panel) return;
    syncTeleprompterText();
    panel.hidden = !open;
    if (open) requestAnimationFrame(() => panel.scrollTop = 0);
  }
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
    if (el('lyrics-input')) el('lyrics-input').readOnly = busy || recording;
    if (el('lyrics-clear')) el('lyrics-clear').disabled = busy || recording;
    for (const id of ['editor-reset','editor-split','editor-auto','editor-left50','editor-left10','editor-right10','editor-right50','editor-delete','editor-bpm','editor-snap','editor-zoom']) {
      if (el(id)) el(id).disabled = busy || recording || !sourceVocal;
    }
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
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.OfflineAudioContext) throw new Error('Этот браузер не поддерживает студию. Попробуйте Safari или Chrome.');
    ctx ||= new AC();
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
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

  const segmentId = () => `seg-${++segmentSeq}`;
  const editorOffset = () => Number(el('offset')?.value || 0);
  const editorBpm = () => Math.max(70, Math.min(200, Number(el('editor-bpm')?.value || 120)));
  function editorSnap(time) {
    const division = Number(el('editor-snap')?.value || 0);
    if (!division) return Math.max(0, time);
    const beatSeconds = 60 / editorBpm();
    const step = beatSeconds * (4 / division);
    return Math.max(0, Math.round(time / step) * step);
  }
  function timelineDuration() {
    const offset = editorOffset();
    const segmentEnd = vocalSegments.reduce((max, s) => Math.max(max, offset + s.at + (s.srcEnd - s.srcStart)), 0);
    const beatEnd = beat ? Math.min(MAX_SECONDS, beat.duration) : 0;
    return Math.max(8, Math.min(MAX_SECONDS, Math.max(beatEnd, segmentEnd + 2, sourceVocal?.duration || 0)));
  }
  function drawBufferRange(g, buffer, x0, x1, y, height, sourceStart = 0, sourceEnd = buffer?.duration || 0, fill = '#777b87') {
    if (!buffer || x1 <= x0 || sourceEnd <= sourceStart) return;
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const px = Math.max(1, Math.floor(x1 - x0));
    g.fillStyle = fill;
    for (let i = 0; i < px; i++) {
      const a = sourceStart + (i / px) * (sourceEnd - sourceStart);
      const b = sourceStart + ((i + 1) / px) * (sourceEnd - sourceStart);
      const from = Math.max(0, Math.floor(a * sr));
      const to = Math.min(data.length, Math.max(from + 1, Math.floor(b * sr)));
      let peak = 0;
      const stride = Math.max(1, Math.floor((to - from) / 12));
      for (let n = from; n < to; n += stride) peak = Math.max(peak, Math.abs(data[n]));
      const h = Math.max(1, peak * height);
      g.fillRect(x0 + i, y - h / 2, 1, h);
    }
  }
  function renderEditor() {
    const canvas = el('editor-canvas');
    if (!canvas || !sourceVocal) return;
    const duration = timelineDuration();
    const zoom = Number(el('editor-zoom')?.value || 3);
    const width = Math.min(7200, Math.max(900, Math.ceil(duration * 4 * zoom)));
    if (canvas.width !== width) canvas.width = width;
    const g = canvas.getContext('2d');
    const h = canvas.height;
    const pps = width / duration;
    g.clearRect(0, 0, width, h);
    g.fillStyle = '#090a0d'; g.fillRect(0, 0, width, h);
    g.fillStyle = '#15171d'; g.fillRect(0, 4, width, 63);
    g.fillStyle = '#11141a'; g.fillRect(0, 78, width, 66);

    const bpm = editorBpm();
    const beatStep = 60 / bpm;
    g.lineWidth = 1;
    for (let t = 0, i = 0; t < duration; t += beatStep, i++) {
      const x = t * pps;
      g.strokeStyle = i % 4 === 0 ? '#4b4330' : '#262a31';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      if (i % 4 === 0) {
        g.fillStyle = '#797364'; g.font = '9px sans-serif';
        g.fillText(String(i / 4 + 1), x + 3, 12);
      }
    }

    if (beat) drawBufferRange(g, beat, 0, Math.min(width, Math.min(beat.duration, duration) * pps), 37, 42, 0, Math.min(beat.duration, duration), '#5d6270');
    g.fillStyle = '#8b8e98'; g.font = '10px sans-serif'; g.fillText('BEAT', 8, 62);
    g.fillStyle = '#c7aa5d'; g.fillText('VOCAL', 8, 139);

    const offset = editorOffset();
    for (const seg of vocalSegments) {
      const start = offset + seg.at;
      const len = seg.srcEnd - seg.srcStart;
      const end = start + len;
      if (end <= 0 || start >= duration) continue;
      const x0 = Math.max(0, start * pps), x1 = Math.min(width, end * pps);
      const selected = seg.id === selectedSegmentId;
      g.fillStyle = selected ? 'rgba(231,197,107,.18)' : 'rgba(113,118,132,.14)';
      g.fillRect(x0, 82, Math.max(2, x1 - x0), 57);
      g.strokeStyle = selected ? '#e7c56b' : '#5d6270';
      g.lineWidth = selected ? 2 : 1;
      g.strokeRect(x0 + .5, 82.5, Math.max(1, x1 - x0 - 1), 56);
      drawBufferRange(g, sourceVocal, x0, x1, 110, 43, seg.srcStart, seg.srcEnd, selected ? '#efd47f' : '#b1b5c0');
    }

    const cx = Math.max(0, Math.min(width, editorCursor * pps));
    g.strokeStyle = '#ff7f88'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke();
    const cursorLabel = el('editor-cursor');
    if (cursorLabel) cursorLabel.textContent = `Курсор ${editorCursor.toFixed(2)} с`;
    const selected = vocalSegments.find(s => s.id === selectedSegmentId);
    const selectedLabel = el('editor-selected');
    if (selectedLabel) selectedLabel.textContent = selected
      ? `Фрагмент ${(vocalSegments.indexOf(selected) + 1)} · ${(selected.srcEnd - selected.srcStart).toFixed(2)} с · позиция ${(offset + selected.at).toFixed(2)} с`
      : 'Фрагмент не выбран';
  }
  function renderEditedVocal() {
    if (!sourceVocal || !vocalSegments.length) return null;
    const sr = sourceVocal.sampleRate;
    const maxEnd = vocalSegments.reduce((m, s) => Math.max(m, s.at + (s.srcEnd - s.srcStart)), 0);
    const frames = Math.max(1, Math.min(Math.floor(MAX_SECONDS * sr), Math.ceil(maxEnd * sr)));
    const outBuffer = ctx.createBuffer(1, frames, sr);
    const out = outBuffer.getChannelData(0);
    const input = sourceVocal.getChannelData(0);
    const fade = Math.max(1, Math.floor(sr * 0.006));
    for (const seg of vocalSegments) {
      const from = Math.max(0, Math.floor(seg.srcStart * sr));
      const to = Math.min(input.length, Math.floor(seg.srcEnd * sr));
      const dest = Math.max(0, Math.floor(seg.at * sr));
      const count = Math.min(to - from, out.length - dest);
      for (let i = 0; i < count; i++) {
        let gain = 1;
        if (i < fade) gain = i / fade;
        if (count - i < fade) gain = Math.min(gain, (count - i) / fade);
        out[dest + i] += input[from + i] * gain;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    return outBuffer;
  }
  function commitEditor(message = 'Монтаж вокала обновлён.') {
    const edited = renderEditedVocal();
    vocal = edited; serverVocal = null; serverVocalSignature = ''; invalidate();
    if (edited) {
      wave(edited);
      el('voice-preview').src = setURL('voice-preview', encodeWav(edited));
      const stats = analyse(edited);
      el('vocal-info').textContent = `Вокал: ${edited.duration.toFixed(1)} с · ${vocalSegments.length} фрагм. · MONO / CENTER${stats.peak >= 0.999 ? ' · Есть перегруз.' : ''}`;
    } else {
      el('voice-preview').removeAttribute('src'); el('voice-preview').load();
      el('vocal-info').textContent = 'Все фрагменты удалены. Сбросьте монтаж или добавьте новый голос.';
    }
    renderEditor(); controls(); status(message);
  }
  function resetEditor(buffer) {
    sourceVocal = buffer;
    vocalSegments = [{ id: segmentId(), srcStart: 0, srcEnd: buffer.duration, at: 0 }];
    selectedSegmentId = vocalSegments[0].id;
    editorCursor = 0;
    if (el('editor')) el('editor').hidden = false;
    commitEditor('Голос добавлен. Можно подогнать фразы в Vocal Slicer.');
  }
  function splitAtCursor() {
    if (!sourceVocal) return;
    const offset = editorOffset();
    const seg = vocalSegments.find(s => {
      const start = offset + s.at, end = start + (s.srcEnd - s.srcStart);
      return editorCursor > start + 0.025 && editorCursor < end - 0.025;
    });
    if (!seg) { status('Поставьте курсор внутри фрагмента, который хотите разрезать.', true); return; }
    const local = editorCursor - offset - seg.at;
    const sourceCut = seg.srcStart + local;
    const right = { id: segmentId(), srcStart: sourceCut, srcEnd: seg.srcEnd, at: seg.at + local };
    seg.srcEnd = sourceCut;
    const index = vocalSegments.indexOf(seg);
    vocalSegments.splice(index + 1, 0, right);
    selectedSegmentId = right.id;
    commitEditor('Фраза разрезана. Перетащите нужный кусок по биту.');
  }
  function nudgeSelected(delta) {
    const seg = vocalSegments.find(s => s.id === selectedSegmentId);
    if (!seg) { status('Сначала выберите фрагмент на дорожке VOCAL.', true); return; }
    const minAt = Math.max(0, -editorOffset());
    seg.at = Math.max(minAt, Math.min(MAX_SECONDS - (seg.srcEnd - seg.srcStart), seg.at + delta));
    commitEditor(`Фрагмент сдвинут ${delta > 0 ? '+' : ''}${Math.round(delta * 1000)} мс.`);
  }
  function autoSplitSilence() {
    if (!sourceVocal) return;
    const data = sourceVocal.getChannelData(0), sr = sourceVocal.sampleRate;
    const frame = Math.max(64, Math.floor(sr * 0.02));
    const gapFrames = Math.max(4, Math.floor(0.18 / (frame / sr)));
    const stats = analyse(sourceVocal);
    const threshold = Math.max(0.004, stats.rms * 0.22);
    const voiced = [];
    for (let from = 0; from < data.length; from += frame) {
      const to = Math.min(data.length, from + frame);
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      voiced.push(Math.sqrt(sum / Math.max(1, to - from)) >= threshold);
    }
    const regions = [];
    let start = null, last = -1;
    for (let i = 0; i < voiced.length; i++) {
      if (!voiced[i]) continue;
      if (start === null || i - last > gapFrames) {
        if (start !== null) regions.push([start, last + 1]);
        start = i;
      }
      last = i;
    }
    if (start !== null) regions.push([start, last + 1]);
    if (regions.length < 2) { status('Длинных пауз для авто-нарезки не найдено.', true); return; }
    vocalSegments = regions.map(([a,b]) => {
      const srcStart = Math.max(0, a * frame / sr - 0.015);
      const srcEnd = Math.min(sourceVocal.duration, b * frame / sr + 0.015);
      return { id: segmentId(), srcStart, srcEnd, at: srcStart };
    });
    selectedSegmentId = vocalSegments[0]?.id || null;
    editorCursor = editorOffset() + (vocalSegments[0]?.at || 0);
    commitEditor(`Авто-нарезка: найдено ${vocalSegments.length} фраз.`);
  }
  function editorTimeFromEvent(event) {
    const canvas = el('editor-canvas'), rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
    return Math.max(0, Math.min(timelineDuration(), x / (canvas.width / timelineDuration())));
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
    el('offset').value = '0';
    resetEditor(centered);
    const stats = analyse(centered);
    if (stats.rms < 0.001) status('Запись очень тихая. Проверьте микрофон.', true);
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
    renderEditor();
    status('Бит готов. Запишите голос в наушниках или загрузите отдельную вокальную дорожку.');
  }));
  el('upload').addEventListener('change', () => action(async () => {
    const file = el('upload').files[0]; if (!file) return;
    status('Читаем вокал…');
    const buffer = await decode(file); acceptVoice(buffer); el('offset').value = '0';
    el('upload').value = '';
  }));
  const lyricsInput = el('lyrics-input');
  if (lyricsInput) {
    try { lyricsInput.value = localStorage.getItem(lyricsStorageKey) || ''; } catch {}
    syncTeleprompterText();
    lyricsInput.addEventListener('input', () => {
      syncTeleprompterText();
      try { localStorage.setItem(lyricsStorageKey, lyricsInput.value); } catch {}
    });
  }
  el('teleprompter-toggle')?.addEventListener('click', () => setTeleprompter(el('teleprompter')?.hidden !== false));
  el('teleprompter-close')?.addEventListener('click', () => setTeleprompter(false));
  el('lyrics-clear')?.addEventListener('click', () => {
    if (!lyricsInput) return;
    lyricsInput.value = '';
    syncTeleprompterText();
    try { localStorage.removeItem(lyricsStorageKey); } catch {}
  });

  const editorCanvas = el('editor-canvas');
  editorCanvas?.addEventListener('pointerdown', event => {
    if (!sourceVocal || busy || recording) return;
    const time = editorTimeFromEvent(event);
    editorCursor = time;
    const rect = editorCanvas.getBoundingClientRect();
    const y = (event.clientY - rect.top) * (editorCanvas.height / Math.max(1, rect.height));
    if (y >= 76) {
      const offset = editorOffset();
      const hit = [...vocalSegments].reverse().find(s => time >= offset + s.at && time <= offset + s.at + (s.srcEnd - s.srcStart));
      if (hit) {
        selectedSegmentId = hit.id;
        editorDrag = { pointerId: event.pointerId, id: hit.id, delta: time - (offset + hit.at) };
        try { editorCanvas.setPointerCapture(event.pointerId); } catch {}
      }
    }
    renderEditor();
  });
  editorCanvas?.addEventListener('pointermove', event => {
    if (!editorDrag || editorDrag.pointerId !== event.pointerId || busy || recording) return;
    const seg = vocalSegments.find(s => s.id === editorDrag.id);
    if (!seg) return;
    const absolute = editorSnap(editorTimeFromEvent(event) - editorDrag.delta);
    const offset = editorOffset();
    const duration = seg.srcEnd - seg.srcStart;
    seg.at = Math.max(0 - offset, Math.min(MAX_SECONDS - duration - offset, absolute - offset));
    editorCursor = Math.max(0, offset + seg.at);
    renderEditor();
  });
  const endEditorDrag = event => {
    if (!editorDrag || (event && editorDrag.pointerId !== event.pointerId)) return;
    editorDrag = null;
    commitEditor('Фрагмент перемещён по биту.');
  };
  editorCanvas?.addEventListener('pointerup', endEditorDrag);
  editorCanvas?.addEventListener('pointercancel', endEditorDrag);
  el('editor-split')?.addEventListener('click', splitAtCursor);
  el('editor-auto')?.addEventListener('click', autoSplitSilence);
  el('editor-left50')?.addEventListener('click', () => nudgeSelected(-0.05));
  el('editor-left10')?.addEventListener('click', () => nudgeSelected(-0.01));
  el('editor-right10')?.addEventListener('click', () => nudgeSelected(0.01));
  el('editor-right50')?.addEventListener('click', () => nudgeSelected(0.05));
  el('editor-delete')?.addEventListener('click', () => {
    if (!selectedSegmentId) { status('Сначала выберите фрагмент.', true); return; }
    vocalSegments = vocalSegments.filter(s => s.id !== selectedSegmentId);
    selectedSegmentId = vocalSegments[0]?.id || null;
    commitEditor('Фрагмент удалён.');
  });
  el('editor-reset')?.addEventListener('click', () => {
    if (!sourceVocal) return;
    vocalSegments = [{ id: segmentId(), srcStart: 0, srcEnd: sourceVocal.duration, at: 0 }];
    selectedSegmentId = vocalSegments[0].id; editorCursor = 0; el('offset').value = '0';
    commitEditor('Монтаж сброшен к исходной записи.');
  });
  for (const id of ['editor-bpm','editor-snap','editor-zoom']) el(id)?.addEventListener('input', renderEditor);
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    clearInterval(recordingTimer);
    try { backing?.stop(); } catch {}
    backing = null; stream?.getTracks().forEach(track => track.stop()); stream = null;
    recording = false;
    el('teleprompter')?.classList.remove('recording');
  }
  el('record').addEventListener('click', () => action(async () => {
    backgroundInterrupted = false;
    if (el('lyrics-input')?.value.trim()) setTeleprompter(true);
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
      const wasBackgroundInterrupted = backgroundInterrupted;
      backgroundInterrupted = false;
      busy = true; stopRecording(); controls(); status('Сохраняем дубль…');
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const buffer = await decode(blob, MAX_SECONDS + 2);
        // Timer/codec padding may add a fraction of a second at the limit.
        const count = Math.min(buffer.length, Math.floor(MAX_SECONDS * buffer.sampleRate));
        const trimmed = ctx.createBuffer(buffer.numberOfChannels, count, buffer.sampleRate);
        for (let c = 0; c < buffer.numberOfChannels; c++) trimmed.copyToChannel(buffer.getChannelData(c).subarray(0, count), c);
        acceptVoice(trimmed); el('offset').value = '0';
        if (wasBackgroundInterrupted) status('Запись сохранена до момента сворачивания. На iPhone микрофон останавливается при переходе в другое приложение — используйте встроенный телесуфлер.', true);
      } catch (e) { status(`Не удалось сохранить запись: ${e.message}`, true); }
      finally { busy = false; controls(); }
    };
    recorder.onstart = () => {
      el('teleprompter')?.classList.add('recording');
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
    if (id === 'offset') renderEditor();
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recording) {
      backgroundInterrupted = true;
      stopRecording();
    }
  });
  window.addEventListener('pagehide', () => {
    disposed = true; if (recording) stopRecording(); stream?.getTracks().forEach(t => t.stop());
    for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear();
  });
  syncFxButtons();
  controls();
}
