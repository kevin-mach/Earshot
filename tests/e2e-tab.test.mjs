// End-to-end for "Tab audio" mode. getDisplayMedia is replaced by a synthetic
// tab that plays bursts of tone (speech) separated by silence (pauses), and the
// Whisper worker is replaced by a stand-in that reports what audio it received.
// This exercises the real capture → AudioWorklet → chunker → worker → transcript
// → autosave path; only the neural network itself is faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../scripts/serve.mjs';

let server, browser, base;
before(async () => {
  server = await serve(0);
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
});
after(async () => { await browser?.close(); server?.close(); });

const FAKE_WORKER = `
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    for (const p of [10, 60, 100]) { postMessage({ type: 'progress', progress: p, loaded: p * 1e6, total: 100e6 }); await new Promise(r => setTimeout(r, 40)); }
    postMessage({ type: 'ready', device: 'webgpu' });
  } else if (m.type === 'transcribe') {
    await new Promise(r => setTimeout(r, 150));
    let peak = 0; for (const v of m.audio) peak = Math.max(peak, Math.abs(v));
    const sec = (m.audio.length / 16000).toFixed(1);
    postMessage({ type: 'result', id: m.id, text: m.id === 1 ? '[Music] clip one heard ' + (peak > 0.05 ? 'sound' : 'nothing') : 'clip ' + m.id + ' lasted ' + sec + ' seconds' });
  }
};`;

function fakes({ withAudio = true } = {}) {
  window.__files = {};
  const fh = (name) => ({ kind: 'file', name, async createWritable() { let b = ''; return { write: async s => { b += s; }, close: async () => { window.__files[name] = b; } }; }, async getFile() { return { size: (window.__files[name] || '').length, lastModified: Date.now() }; } });
  const dir = { kind: 'directory', name: 'Transcripts', queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFileHandle: async n => fh(n), async *entries() { for (const n of Object.keys(window.__files)) yield [n, fh(n)]; } };
  window.showDirectoryPicker = async () => dir;
  const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (v, k) { return put.call(this, k === 'folder' ? 'x' : v, k); };

  navigator.mediaDevices.getDisplayMedia = async (opts) => {
    window.__displayOpts = opts;
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator(); osc.frequency.value = 220;
    const gate = ctx.createGain(); gate.gain.value = 0;
    const t = ctx.currentTime + 0.2;
    // "speech" 2.8s, pause 1s, "speech" 2.8s, pause 1s, then speech until stopped
    gate.gain.setValueAtTime(0.5, t); gate.gain.setValueAtTime(0, t + 2.8);
    gate.gain.setValueAtTime(0.5, t + 3.8); gate.gain.setValueAtTime(0, t + 6.6);
    gate.gain.setValueAtTime(0.5, t + 7.6);
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gate).connect(dest); osc.start();
    const tracks = withAudio ? dest.stream.getAudioTracks() : [];
    const s = new MediaStream(tracks);
    window.__endShare = () => { s.getTracks().forEach(tr => { tr.stop(); tr.dispatchEvent(new Event('ended')); }); };
    return s;
  };
}

const FAILING_WORKER = `self.onmessage = (e) => { if (e.data.type === 'load') postMessage({ type: 'error', message: 'fetch failed' }); };`;

async function open(opts, worker = FAKE_WORKER) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakes, opts);
  await ctx.route('**/src/whisper-worker.js', r => r.fulfill({ contentType: 'text/javascript', body: worker }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__earshot);
  return { ctx, page, errors };
}

test('tab audio is captured, split at pauses, transcribed in order and autosaved', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#folderBtn');
  await page.waitForFunction(() => window.__earshot.folderOk);

  await page.click('[data-source="tab"]');
  assert.equal(await page.isVisible('#engineCard'), true);
  assert.match(await page.textContent('#emptyHint'), /Also share tab audio/);
  await page.fill('#title', 'Lecture');

  await page.click('#recBtn');
  await page.waitForFunction(() => document.getElementById('modelStatus').textContent.includes('GPU'));
  const opts = await page.evaluate(() => window.__displayOpts);
  assert.equal(opts.audio.suppressLocalAudioPlayback, false, 'user must keep hearing the video');
  assert.equal(await page.isDisabled('[data-source="mic"]'), true, 'source locked while recording');

  // Two pauses → two lines while still recording.
  await page.waitForFunction(() => document.querySelectorAll('#transcript li').length >= 2, null, { timeout: 15000 });
  // Stop mid-utterance: the trailing clip must still be transcribed before we finish.
  await page.waitForTimeout(1500);
  await page.click('#recBtn');
  await page.waitForFunction(() => !window.__earshot.draining && document.querySelectorAll('#transcript li').length >= 3, null, { timeout: 10000 });

  const seg = await page.evaluate(() => window.__earshot.session.segments);
  assert.equal(seg[0].text, 'Clip one heard sound.', 'sound tag stripped, real audio reached the model');
  assert.match(seg[1].text, /^Clip 2 lasted (2\.[89]|3\.[0-4]) seconds\.$/);
  assert.match(seg[2].text, /^Clip 3 lasted \d\.\d seconds\.$/);
  // Timestamps come from the audio itself and are in order.
  assert.ok(seg[0].start < 1000 && seg[1].start > 3000 && seg[1].start < 4500, JSON.stringify(seg.map(s => s.start)));
  assert.ok(seg[0].end <= seg[1].start && seg[1].end <= seg[2].start);
  assert.equal(await page.evaluate(() => window.__earshot.session.source), 'tab');

  await page.waitForFunction(() => Object.values(window.__files).some(t => t.includes('Clip 3 lasted')), null, { timeout: 5000 });
  const md = Object.entries(await page.evaluate(() => window.__files)).find(([n]) => n.endsWith('-lecture.md'))[1];
  assert.match(md, /\*\*\[00:00:0\d\]\*\* Clip one heard sound\./);
  assert.equal(await page.isDisabled('[data-source="mic"]'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('closing the shared tab stops recording and keeps the last line', async () => {
  const { ctx, page, errors } = await open();
  await page.click('[data-source="tab"]');
  await page.click('#recBtn');
  await page.waitForFunction(() => document.querySelectorAll('#transcript li').length >= 1, null, { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__endShare());
  await page.waitForFunction(() => document.getElementById('recBtn').getAttribute('aria-pressed') === 'false' && !window.__earshot.draining, null, { timeout: 8000 });
  assert.match(await page.textContent('#banner'), /sharing ended/i);
  assert.ok((await page.evaluate(() => window.__earshot.session.segments.length)) >= 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('sharing without audio explains how to turn tab audio on', async () => {
  const { ctx, page, errors } = await open({ withAudio: false });
  await page.click('[data-source="tab"]');
  await page.click('#recBtn');
  await page.waitForFunction(() => !document.getElementById('banner').hidden);
  assert.match(await page.textContent('#banner'), /Also share tab audio/);
  assert.equal(await page.getAttribute('#recBtn', 'aria-pressed'), 'false');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a failed model download stops recording with a clear message', async () => {
  const { ctx, page, errors } = await open({}, FAILING_WORKER);
  // Make audio setup slow so the model error always lands mid-start (a race seen on fast CI machines).
  await page.evaluate(() => { const orig = AudioWorklet.prototype.addModule; AudioWorklet.prototype.addModule = async function (...a) { await new Promise(r => setTimeout(r, 400)); return orig.apply(this, a); }; });
  await page.click('[data-source="tab"]');
  await page.click('#recBtn');
  await page.waitForFunction(() => /couldn.t be downloaded/.test(document.getElementById('banner').textContent));
  await page.waitForFunction(() => document.getElementById('recBtn').getAttribute('aria-pressed') === 'false' && !window.__earshot.draining);
  assert.match(await page.textContent('#modelStatus'), /retry/);
  assert.equal(await page.isDisabled('#recBtn'), false);
  await page.waitForTimeout(800);   // and it must stay stopped once the slow setup finishes
  assert.equal(await page.getAttribute('#recBtn', 'aria-pressed'), 'false', 'must not revive after setup completes');
  assert.deepEqual(errors, []);
  await ctx.close();
});
