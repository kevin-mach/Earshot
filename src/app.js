import { LiveRecognizer, isSupported } from './recognizer.js';
import { TabTranscriber, canCaptureTab, MODELS } from './tab-source.js';
import * as store from './storage.js';
import { FORMATS, baseName, clock, tidy, wordCount, isEcho } from './format.js';

const $ = (id) => document.getElementById(id);
const el = {
  rec: $('recBtn'), timer: $('timer'), level: $('level'), lang: $('lang'),
  list: $('transcript'), interim: $('interim'), empty: $('empty'),
  title: $('title'), words: $('words'), segCount: $('segCount'),
  folderBtn: $('folderBtn'), folderLabel: $('folderLabel'), folderDot: $('folderDot'),
  formats: $('formats'), autosave: $('autosave'), saveBtn: $('saveBtn'), newBtn: $('newBtn'),
  saveStatus: $('saveStatus'), files: $('files'), refresh: $('refreshBtn'),
  banner: $('banner'), theme: $('themeBtn'),
  sourceBtns: document.querySelectorAll('[data-source]'), engineCard: $('engineCard'), model: $('model'),
  modelBar: $('modelBar'), modelStatus: $('modelStatus'), emptyHint: $('emptyHint'), diag: $('diag'),
};

const LANGS = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (AU)'], ['en-IN', 'English (India)'],
  ['es-ES', 'Español (España)'], ['es-MX', 'Español (México)'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'],
  ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'], ['nl-NL', 'Nederlands'], ['pl-PL', 'Polski'],
  ['ru-RU', 'Русский'], ['uk-UA', 'Українська'], ['tr-TR', 'Türkçe'], ['ar-SA', 'العربية'], ['hi-IN', 'हिन्दी'],
  ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文 (简体)'], ['zh-TW', '中文 (繁體)'], ['vi-VN', 'Tiếng Việt'],
];

// ---------- prefs (per-browser conveniences; safe if storage is blocked) ----------
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('earshot.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('earshot.' + k, JSON.stringify(v)); } catch {} },
};

// ---------- state ----------
let session = prefs.get('draft', null) ?? freshSession();
let folder = null;            // FileSystemDirectoryHandle
let folderOk = false;
let recognizer = null;
let elapsedBefore = 0;        // ms accumulated in earlier recording stretches
let runStart = 0;             // performance.now() at current stretch start
let utterStart = null;        // session offset when current utterance began
let tick = null;
let audio = null;             // { ctx, stream, raf }
let saveTimer = null;
let dirty = false;
let source = prefs.get('source', 'mic');   // 'mic' | 'tab' | 'meeting'
const usesWhisper = (s = source) => s === 'tab' || s === 'meeting';
let tab = null;               // TabTranscriber (kept between runs so the model stays loaded)
let captureBase = 0;          // session offset when the current tab capture began
let draining = false;
let echoes = 0;                // echo lines dropped this session (meeting mode)

function freshSession() {
  return { id: crypto.randomUUID(), startedAt: new Date().toISOString(), lang: prefs.get('lang', navigator.language || 'en-US'), title: '', segments: [] };
}
const recording = () => Boolean(recognizer?.wanted);
const ERRORS = {
  'share-cancelled': 'Sharing was cancelled. Press record and pick the tab that\'s playing your video.',
  'no-audio': 'No audio came with that share. Press record again, choose the "Chrome Tab" option, pick the tab, and make sure "Also share tab audio" is switched on.',
  'capture-failed': 'Couldn\'t capture that tab\'s audio.',
};
const now = () => elapsedBefore + (recording() ? performance.now() - runStart : 0);

// ---------- rendering ----------
function renderSegment(seg, i, fresh = false) {
  const li = document.createElement('li');
  li.dataset.i = i;
  if (fresh) li.className = 'fresh';
  li.innerHTML = `<time></time><div class="body"><div class="text" contenteditable="plaintext-only" spellcheck="true"></div></div><button class="del" type="button" aria-label="Delete line" title="Delete line">×</button>`;
  li.querySelector('time').textContent = clock(seg.start);
  li.querySelector('.text').textContent = seg.text;
  if (seg.speaker) {
    const who = document.createElement('span');
    who.className = `who who-${seg.speaker.toLowerCase()}`;
    who.textContent = seg.speaker;
    li.querySelector('.body').prepend(who);
  }
  return li;
}

function renderAll() {
  el.list.replaceChildren(...session.segments.map((s, i) => renderSegment(s, i)));
  el.title.value = session.title || '';
  updateStats();
}

function updateStats() {
  const n = session.segments.length;
  const w = wordCount(session);
  el.words.textContent = `${w} word${w === 1 ? '' : 's'}`;
  el.segCount.textContent = `${n} line${n === 1 ? '' : 's'}`;
  el.empty.hidden = n > 0 || recording();
}

function scrollToEnd() {
  const stage = el.list.closest('.stage');
  const nearBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 160;
  if (nearBottom) stage.scrollTop = stage.scrollHeight;
}

function setTimer() { el.timer.textContent = clock(now()); }

function banner(msg) { el.banner.textContent = msg || ''; el.banner.hidden = !msg; }
function status(msg) { el.saveStatus.textContent = msg; }

// ---------- session mutations ----------
function persistDraft() { prefs.set('draft', session); }

function changed() {
  dirty = true;
  persistDraft();
  updateStats();
  if (el.autosave.checked && folderOk) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({ quiet: true }), 900);
  }
}

function addFinal(text, timing) {
  const t = tidy(text);
  if (!t) return;
  let seg;
  if (timing) seg = { start: Math.round(captureBase + timing.startMs), end: Math.round(captureBase + timing.endMs), text: t };
  else { const end = now(); seg = { start: utterStart ?? Math.max(0, end - 1500), end, text: t }; }
  utterStart = null;
  if (timing?.speaker) seg.speaker = timing.speaker;

  // Meeting mode on speakers: your mic re-hears the call. Keep the call's copy only.
  let rerender = false;
  if (seg.speaker) {
    const near = session.segments.filter(x => x.speaker && x.speaker !== seg.speaker && Math.abs(x.start - seg.start) < 20000);
    if (seg.speaker === 'You' && near.some(x => isEcho(seg, x))) { echoes++; return; }
    if (seg.speaker === 'Them') {
      const dupes = near.filter(x => isEcho(x, seg));
      if (dupes.length) { session.segments = session.segments.filter(x => !dupes.includes(x)); echoes += dupes.length; rerender = true; }
    }
  }

  // Two lanes finish out of order, so insert by start time.
  let at = session.segments.findIndex(x => x.start > seg.start);
  if (at === -1) at = session.segments.length;
  session.segments.splice(at, 0, seg);
  if (rerender || at < session.segments.length - 1) {
    renderAll();
    el.list.children[at]?.classList.add('fresh');
  } else {
    el.list.append(renderSegment(seg, at, true));
  }
  scrollToEnd();
  changed();
}

// ---------- recording ----------
async function startRecording() {
  if (draining) return;
  banner('');
  if (!session.segments.length && elapsedBefore === 0) session.startedAt = new Date().toISOString();
  session.lang = el.lang.value;
  session.source = source;
  return usesWhisper() ? startTab() : startMic();
}

function wireCommon(r) {
  const whisper = r instanceof TabTranscriber;
  r.addEventListener('final', (e) => {
    if (!whisper) el.interim.textContent = '';
    addFinal(e.detail.text, whisper ? e.detail : null);
  });
}

function setRecUI(on) {
  el.rec.setAttribute('aria-pressed', String(on));
  el.rec.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
  el.sourceBtns.forEach(b => (b.disabled = on || draining || !sourceAvailable(b.dataset.source)));
  clearInterval(tick);
  if (on) tick = setInterval(setTimer, 250);
  updateStats();
}

async function startTab() {
  if (!canCaptureTab()) { banner('This browser can\'t capture tab audio. Use Chrome or Edge on a desktop.'); return; }
  const meeting = source === 'meeting';
  if (!tab || tab.modelSize !== el.model.value) {
    tab?.dispose();
    tab = new TabTranscriber({ model: el.model.value, lang: el.lang.value, meeting });
    wireCommon(tab);
    tab.addEventListener('interim', (e) => { el.interim.textContent = e.detail; });
    tab.addEventListener('level', (e) => { el.level.style.width = Math.min(100, e.detail * 320) + '%'; });
    tab.addEventListener('progress', (e) => paintModel(e.detail));
    tab.addEventListener('error', (e) => {
      if (String(e.detail).startsWith('model-load')) {
        banner('The speech model couldn\'t be downloaded. Check your internet connection (it\'s only needed the first time) and press record again.');
        stopRecording();
        return;
      }
      if (String(e.detail).startsWith('start-failed')) { banner(`Couldn't start capturing audio (${String(e.detail).slice(14)}). Please send this message to the developer.`); return; }
      banner(ERRORS[e.detail] || `Tab transcription error: ${e.detail}`);
    });
    tab.addEventListener('ended', () => { banner('Tab sharing ended. Finishing the last few lines…'); stopRecording(); });
    tab.addEventListener('diag', (e) => paintDiag(e.detail));
    tab.addEventListener('warning', (e) => {
      if (e.detail === 'silent-call') banner(SILENT_HELP);
      if (e.detail === 'mic-unavailable') banner('Couldn\'t use your microphone, so only the other people are being transcribed. Allow the mic in the address bar, then stop and record again to include yourself.');
    });
  }
  tab.lang = el.lang.value;
  tab.meeting = meeting;   // the loaded model is reused across Tab and Meeting modes
  recognizer = tab;
  runStart = performance.now();
  let ok = false;
  try { ok = await tab.start(); }
  catch (err) { banner(`Couldn't start capturing audio (${err?.message || err}).`); }
  if (!ok || recognizer !== tab) { if (recognizer === tab) recognizer = null; setRecUI(false); return; }
  captureBase = elapsedBefore;
  runStart = performance.now();
  setRecUI(true);
}

function startMic() {
  if (!isSupported()) {
    banner('This browser has no built-in speech recognition. Use Chrome, Edge, or Safari, or switch to Tab audio.');
    return;
  }
  recognizer = new LiveRecognizer({ lang: el.lang.value });
  wireCommon(recognizer);
  recognizer.addEventListener('interim', (e) => {
    if (e.detail && utterStart == null) utterStart = now();
    el.interim.textContent = e.detail;
  });
  recognizer.addEventListener('error', (e) => {
    const map = {
      'not-allowed': 'Microphone access was blocked. Allow it in the address bar, then press record again.',
      'service-not-allowed': 'Speech service is not allowed here. Make sure you\'re on https or localhost.',
      'network': 'The speech service could not be reached. Check your connection; Earshot will keep retrying.',
      'audio-capture': 'No microphone was found.',
      'language-not-supported': 'That language is not supported by this browser\'s speech engine.',
    };
    banner(map[e.detail] || `Recognition error: ${e.detail}`);
    if (!recognizer?.wanted) stopRecording();
  });
  runStart = performance.now();
  recognizer.start();
  setRecUI(true);
  startMeter();
}

async function stopRecording() {
  const r = recognizer;
  if (!r) return;
  elapsedBefore = now();
  recognizer = null;
  setTimer();
  stopMeter();
  el.level.style.width = '0';
  if (r instanceof TabTranscriber) {
    draining = true;
    setRecUI(false);
    el.rec.disabled = true;
    await r.stop();             // waits for queued clips to finish transcribing
    draining = false;
    el.rec.disabled = false;
  } else {
    r.stop();
  }
  el.interim.textContent = '';
  setRecUI(false);
  paintDiag(null);
  if (dirty && el.autosave.checked && folderOk) save({ quiet: true });
}

const toggle = () => (recording() ? stopRecording() : startRecording());

// Visual input meter (independent of recognition; failure is harmless).
async function startMeter() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      el.level.style.width = Math.min(100, Math.sqrt(sum / buf.length) * 320) + '%';
      audio.raf = requestAnimationFrame(loop);
    };
    audio = { ctx, stream, raf: 0 };
    if (!recording()) return stopMeter();
    loop();
  } catch { /* meter is decorative */ }
}
function stopMeter() {
  if (!audio) return;
  cancelAnimationFrame(audio.raf);
  audio.stream.getTracks().forEach(t => t.stop());
  audio.ctx.close();
  audio = null;
  el.level.style.width = '0';
}

// ---------- saving ----------
function selectedFormats() {
  return [...el.formats.querySelectorAll('input:checked')].map(i => i.value);
}

async function save({ quiet = false } = {}) {
  if (!session.segments.length) { if (!quiet) status('Nothing to save yet.'); return; }
  const fmts = selectedFormats();
  if (!fmts.length) { status('Pick at least one format.'); return; }
  const base = baseName(session);

  if (folder && !folderOk && !quiet) folderOk = (await store.permission(folder, true)) === 'granted';

  if (folderOk) {
    try {
      for (const f of fmts) await store.writeFile(folder, `${base}.${FORMATS[f].ext}`, FORMATS[f].render(session));
      dirty = false;
      status(`Saved ${fmts.length} file${fmts.length > 1 ? 's' : ''} · ${new Date().toLocaleTimeString()}`);
      refreshFiles();
    } catch (err) {
      folderOk = false; paintFolder();
      status(`Couldn't write to the folder (${err.name}). Click the folder chip to reconnect.`);
    }
    return;
  }
  if (quiet) return;
  // No folder access: download instead.
  for (const f of fmts) store.download(`${base}.${FORMATS[f].ext}`, FORMATS[f].render(session), FORMATS[f].mime);
  dirty = false;
  status(store.canPickFolder() ? 'Downloaded. Choose a folder to save automatically.' : 'Downloaded to your Downloads folder.');
}

function newSession() {
  if (recording() || draining) { status('Stop recording first.'); return; }
  if (dirty && session.segments.length && !confirm('This session has unsaved changes. Start a new one anyway?')) return;
  session = freshSession();
  session.lang = el.lang.value;
  elapsedBefore = 0; utterStart = null; dirty = false; echoes = 0;
  setTimer(); renderAll(); persistDraft(); status('');
  el.title.focus();
}

// ---------- folder ----------
function paintFolder() {
  if (!store.canPickFolder()) {
    el.folderLabel.textContent = 'Saves to Downloads';
    el.folderBtn.title = 'This browser can\'t write to a chosen folder; files are downloaded instead.';
    el.folderDot.className = 'dot';
    return;
  }
  if (!folder) { el.folderLabel.textContent = 'Choose folder'; el.folderDot.className = 'dot'; return; }
  el.folderLabel.textContent = folderOk ? `📁 ${folder.name}` : `Reconnect ${folder.name}`;
  el.folderDot.className = 'dot ' + (folderOk ? 'ok' : 'warn');
}

async function chooseFolder() {
  if (!store.canPickFolder()) return;
  try {
    if (folder && !folderOk) {
      folderOk = (await store.permission(folder, true)) === 'granted';
      if (folderOk) { paintFolder(); refreshFiles(); if (dirty) save({ quiet: true }); return; }
    }
    folder = await store.pickFolder();
    folderOk = (await store.permission(folder, true)) === 'granted';
    paintFolder(); refreshFiles();
    if (dirty) save({ quiet: true });
  } catch (err) {
    if (err.name !== 'AbortError') status(`Folder error: ${err.message}`);
  }
}

async function refreshFiles() {
  if (!folder || !folderOk) {
    el.files.innerHTML = `<li class="muted small">${folder ? 'Reconnect the folder to see files.' : 'No folder chosen yet.'}</li>`;
    return;
  }
  try {
    const items = await store.listTranscripts(folder);
    if (!items.length) { el.files.innerHTML = '<li class="muted small">No transcripts yet.</li>'; return; }
    el.files.replaceChildren(...items.slice(0, 50).map(f => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="name"></span><span class="muted"></span>';
      li.firstChild.textContent = f.name; li.firstChild.title = f.name;
      li.lastChild.textContent = f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`;
      return li;
    }));
  } catch { el.files.innerHTML = '<li class="muted small">Couldn\'t read folder.</li>'; }
}

// ---------- wiring ----------
function setupFormats() {
  const chosen = new Set(prefs.get('formats', ['md', 'txt']));
  el.formats.replaceChildren(...Object.entries(FORMATS).map(([k, f]) => {
    const lab = document.createElement('label');
    lab.title = f.label;
    lab.innerHTML = `<input type="checkbox" value="${k}"><span>.${f.ext}</span>`;
    lab.firstChild.checked = chosen.has(k);
    return lab;
  }));
  el.formats.addEventListener('change', () => prefs.set('formats', selectedFormats()));
}

function setupLangs() {
  const want = session.lang || prefs.get('lang', 'en-US');
  const opts = LANGS.some(([c]) => c === want) ? LANGS : [[want, want], ...LANGS];
  el.lang.replaceChildren(...opts.map(([c, n]) => new Option(n, c, false, c === want)));
  el.lang.addEventListener('change', () => {
    prefs.set('lang', el.lang.value);
    session.lang = el.lang.value;
    if (recognizer instanceof LiveRecognizer) recognizer.setLang(el.lang.value);
  });
}

const SILENT_HELP = 'Earshot is connected but hearing silence. If you shared your Entire screen, check "Share system audio" was on. In Discord, set User Settings → Voice & Video → Output Device to "Default", and make sure your headset is the Windows default output (speaker icon in the taskbar).';

const bars = (lvl) => {
  // RMS → 0–5 bars on a dB scale (-60 dB … -10 dB).
  const db = lvl > 0 ? 20 * Math.log10(lvl) : -100;
  const n = Math.max(0, Math.min(5, Math.round((db + 60) / 10)));
  return '▮'.repeat(n) + '▯'.repeat(5 - n);
};

function paintDiag(d) {
  if (!d) { el.diag.hidden = true; return; }
  el.diag.hidden = false;
  const names = { Them: 'Call audio', You: 'Your mic', Tab: 'Tab audio' };
  const lanes = d.lanes.map(l => `<span title="${(l.label || '').replace(/"/g, '&quot;')}">${names[l.speaker] || l.speaker} <b class="bars">${bars(l.level)}</b></span>`);
  el.diag.innerHTML = `${lanes.join('')}<span>${d.sent} clip${d.sent === 1 ? '' : 's'} heard · ${d.done} transcribed</span>`;
}

function paintModel(p) {
  const m = MODELS[el.model.value];
  if (p?.loading) {
    el.modelBar.hidden = false;
    el.modelBar.value = Math.round(p.progress || 0);
    const mb = p.total ? ` (${(p.loaded / 1048576).toFixed(0)} / ${(p.total / 1048576).toFixed(0)} MB)` : '';
    el.modelStatus.textContent = p.progress ? `Downloading model… ${Math.round(p.progress)}%${mb}` : 'Preparing model…';
  } else if (p?.failed) {
    el.modelBar.hidden = true;
    el.modelStatus.textContent = 'Download failed. It will retry when you press record.';
  } else if (p?.device) {
    el.modelBar.hidden = true;
    el.modelStatus.textContent = `Ready · running on ${p.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)'}`;
  } else {
    el.modelBar.hidden = true;
    el.modelStatus.textContent = `Downloads ${m.size} once, then works offline. Audio never leaves your computer.`;
  }
}

function sourceAvailable(s) { return s === 'mic' ? isSupported() : canCaptureTab(); }

function setSource(next) {
  if (recording() || draining) return;
  source = next;
  prefs.set('source', source);
  el.sourceBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === source)));
  el.engineCard.hidden = !usesWhisper();
  el.emptyHint.innerHTML = {
    tab: 'Press record, pick the tab playing your video, and keep <b>“Also share tab audio”</b> on. Lines appear a few seconds behind the video and autosave to your folder.',
    meeting: 'Join your call in a browser tab and <b>wear headphones</b>. Press record, pick the call\'s tab with <b>“Also share tab audio”</b> on, then allow the microphone. Lines are tagged <b>You</b> or <b>Them</b>.',
    mic: 'Lines appear here as you speak. Click any line to fix it. Everything autosaves to your folder.',
  }[source];
}

function setupSource() {
  el.model.replaceChildren(...Object.entries(MODELS).map(([k, m]) => new Option(m.label, k)));
  el.model.value = prefs.get('model', 'base');
  el.model.addEventListener('change', () => { prefs.set('model', el.model.value); paintModel(); });
  el.sourceBtns.forEach(b => b.addEventListener('click', () => setSource(b.dataset.source)));
  for (const b of el.sourceBtns) {
    if (sourceAvailable(b.dataset.source)) continue;
    b.disabled = true;
    b.title = b.dataset.source === 'mic' ? 'This browser has no built-in speech recognition.' : 'Tab audio capture needs Chrome or Edge on a desktop.';
  }
  setSource(sourceAvailable(source) ? source : canCaptureTab() ? 'tab' : 'mic');
  paintModel();
}

function setupTheme() {
  const apply = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  apply(prefs.get('theme', null));
  el.theme.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    apply(next); prefs.set('theme', next);
  });
}

function setupEditing() {
  el.list.addEventListener('input', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    session.segments[+li.dataset.i].text = e.target.textContent;
    changed();
  });
  el.list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('text')) { e.preventDefault(); e.target.blur(); }
  });
  el.list.addEventListener('click', (e) => {
    if (!e.target.classList.contains('del')) return;
    session.segments.splice(+e.target.closest('li').dataset.i, 1);
    renderAll(); changed();
  });
  el.title.addEventListener('input', () => { session.title = el.title.value; changed(); });
}

function setupKeys() {
  addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, select, textarea, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
  });
  addEventListener('beforeunload', (e) => { if (dirty && !folderOk && session.segments.length) e.preventDefault(); });
}

async function init() {
  setupFormats(); setupLangs(); setupSource(); setupTheme(); setupEditing(); setupKeys();
  el.autosave.checked = prefs.get('autosave', true);
  el.autosave.addEventListener('change', () => prefs.set('autosave', el.autosave.checked));
  el.rec.addEventListener('click', toggle);
  el.saveBtn.addEventListener('click', () => save());
  el.newBtn.addEventListener('click', newSession);
  el.folderBtn.addEventListener('click', chooseFolder);
  el.refresh.addEventListener('click', refreshFiles);

  elapsedBefore = session.segments.at(-1)?.end ?? 0;
  renderAll(); setTimer();

  if (!isSupported() && !canCaptureTab()) banner('Live transcription needs Chrome, Edge, or Safari. You can still open and edit drafts here.');
  else if (!isSecureContext) banner('The microphone only works over https:// or on localhost.');

  if (store.canPickFolder()) {
    folder = await store.savedFolder();
    if (folder) folderOk = (await store.permission(folder)) === 'granted';
  }
  paintFolder(); refreshFiles();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // Test hook — lets the browser test inspect state without reaching into closures.
  window.__earshot = { get session() { return session; }, save, toggle, get folderOk() { return folderOk; }, get draining() { return draining; }, get echoes() { return echoes; } };
}

init();
