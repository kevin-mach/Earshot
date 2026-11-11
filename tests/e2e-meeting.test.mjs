// End-to-end for Meeting mode: the call's tab is a synthetic 220 Hz "voice",
// the microphone a 880 Hz one. The stand-in model estimates the pitch of each
// clip it receives, so these tests prove each lane's audio is routed, labelled
// ("Them"/"You"), ordered by time and saved, with only the neural net faked.
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

// Pitch → words. With echo=true it ignores pitch, mimicking a mic that re-hears the call.
const worker = (echo) => `
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') return postMessage({ type: 'ready', device: 'wasm' });
  let z = 0; for (let i = 1; i < m.audio.length; i++) if ((m.audio[i - 1] < 0) !== (m.audio[i] < 0)) z++;
  const hz = z / 2 / (m.audio.length / 16000);
  const text = ${echo} || hz < 500 ? 'the call says we should ship the release on friday' : 'my microphone says friday works for me';
  setTimeout(() => postMessage({ type: 'result', id: m.id, text }), 60);
};`;

function fakes() {
  window.__files = {};
  const fh = (n) => ({ kind: 'file', name: n, async createWritable() { let x = ''; return { write: async v => { x += v; }, close: async () => { window.__files[n] = x; } }; }, async getFile() { return { size: (window.__files[n] || '').length, lastModified: Date.now() }; } });
  window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'Calls', queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFileHandle: async n => fh(n), async *entries() { for (const n of Object.keys(window.__files)) yield [n, fh(n)]; } });
  const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (v, k) { return put.call(this, k === 'folder' ? 'x' : v, k); };

  // A synthetic voice: a tone switched on during the given [start, end] windows (seconds).
  const voice = async (hz, windows) => {
    const c = new AudioContext(); await c.resume();
    const o = c.createOscillator(); o.frequency.value = hz;
    const g = c.createGain(); g.gain.value = 0;
    const t = c.currentTime + 0.1;
    for (const [a, b] of windows) { g.gain.setValueAtTime(0.4, t + a); g.gain.setValueAtTime(0, t + b); }
    const d = c.createMediaStreamDestination(); o.connect(g).connect(d); o.start();
    return d.stream;
  };
  // Call speaks, then you answer, then the call speaks again.
  navigator.mediaDevices.getDisplayMedia = async () => voice(220, [[0.1, 2.9], [7.0, 9.8]]);
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__micConstraints = c;
    if (window.__denyMic) throw new DOMException('denied', 'NotAllowedError');
    return voice(880, [[3.6, 6.4]]);
  };
}

async function open(echo = false, init = '') {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakes);
  if (init) await ctx.addInitScript(init);
  await ctx.route('**/src/whisper-worker.js', r => r.fulfill({ contentType: 'text/javascript', body: worker(echo) }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__earshot);
  return { ctx, page, errors };
}

test('meeting mode transcribes the call and your mic as labelled, time-ordered lines', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#folderBtn');
  await page.waitForFunction(() => window.__earshot.folderOk);
  await page.click('[data-source="meeting"]');
  assert.equal(await page.isVisible('#engineCard'), true);
  assert.match(await page.textContent('#emptyHint'), /headphones/);
  await page.fill('#title', 'Standup');

  await page.click('#recBtn');
  await page.waitForFunction(() => window.__earshot.session.segments.length >= 3, null, { timeout: 20000 });
  await page.click('#recBtn');
  await page.waitForFunction(() => !window.__earshot.draining);

  const segs = await page.evaluate(() => window.__earshot.session.segments);
  assert.deepEqual(segs.map(s => s.speaker), ['Them', 'You', 'Them'], JSON.stringify(segs));
  assert.match(segs[0].text, /^The call says/);
  assert.match(segs[1].text, /^My microphone says/);
  assert.ok(segs[0].start < segs[1].start && segs[1].start < segs[2].start);
  assert.ok(segs[1].start > 3000 && segs[1].start < 4500, `You line at ${segs[1].start}ms`);

  // Mic is opened with echo cancellation; tags render in the transcript.
  assert.equal((await page.evaluate(() => window.__micConstraints)).audio.echoCancellation, true);
  assert.deepEqual(await page.$$eval('#transcript .who', els => els.map(e => e.textContent)), ['Them', 'You', 'Them']);

  await page.waitForFunction(() => Object.values(window.__files).some(t => t.includes('You: My microphone')));
  const txt = Object.entries(await page.evaluate(() => window.__files)).find(([n]) => n.endsWith('-standup.txt'))[1];
  assert.match(txt, /^Them: The call says.*\nYou: My microphone says.*\nThem: The call says/);
  assert.equal(await page.evaluate(() => window.__earshot.session.source), 'meeting');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('when the mic re-hears the call (no headphones), the echo is dropped', async () => {
  const { ctx, page, errors } = await open(true);
  await page.click('[data-source="meeting"]');
  await page.click('#recBtn');
  await page.waitForFunction(() => window.__earshot.session.segments.length >= 2, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.click('#recBtn');
  await page.waitForFunction(() => !window.__earshot.draining);
  const segs = await page.evaluate(() => window.__earshot.session.segments);
  assert.ok(segs.length >= 2);
  assert.ok(segs.every(s => s.speaker === 'Them'), JSON.stringify(segs.map(s => s.speaker)));
  assert.ok((await page.evaluate(() => window.__earshot.echoes)) >= 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('if the mic is blocked, the call is still transcribed and you are told why', async () => {
  const { ctx, page, errors } = await open(false, 'window.__denyMic = true;');
  await page.click('[data-source="meeting"]');
  await page.click('#recBtn');
  await page.waitForFunction(() => /Couldn.t use your microphone/.test(document.getElementById('banner').textContent));
  await page.waitForFunction(() => window.__earshot.session.segments.length >= 1, null, { timeout: 20000 });
  assert.equal(await page.getAttribute('#recBtn', 'aria-pressed'), 'true', 'keeps recording the call');
  await page.click('#recBtn');
  await page.waitForFunction(() => !window.__earshot.draining);
  const segs = await page.evaluate(() => window.__earshot.session.segments);
  assert.ok(segs.every(s => s.speaker === 'Them'));
  assert.deepEqual(errors, []);
  await ctx.close();
});
