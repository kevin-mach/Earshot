// End-to-end: loads the real app in Chromium with a scripted fake speech engine
// and an in-memory folder, then checks that speech becomes saved files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../scripts/serve.mjs';

let server, browser, base;

before(async () => {
  server = await serve(0);
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); server?.close(); });

// Injected before any page script runs.
function fakes() {
  // ---- fake SpeechRecognition driven by window.__say(text) ----
  class FakeRec {
    constructor() { FakeRec.last = this; this.results = []; }
    start() { setTimeout(() => this.onstart?.(), 0); }
    stop() { setTimeout(() => this.onend?.(), 0); }
    emit(text, isFinal) {
      const alt = { transcript: text, confidence: 0.9 };
      const r = Object.assign([alt], { isFinal });
      if (isFinal) { this.results.push(r); this.onresult?.({ resultIndex: this.results.length - 1, results: this.results }); }
      else this.onresult?.({ resultIndex: this.results.length, results: [...this.results, r] });
    }
  }
  window.SpeechRecognition = FakeRec;
  window.webkitSpeechRecognition = FakeRec;
  window.__say = async (text) => {
    FakeRec.last.emit(text.split(' ').slice(0, 2).join(' '), false);
    await new Promise(r => setTimeout(r, 30));
    FakeRec.last.emit(text, true);
  };

  // ---- in-memory directory handle ----
  window.__files = {};
  const fileHandle = (name) => ({
    kind: 'file', name,
    async createWritable() { let buf = ''; return { write: async (s) => { buf += s; }, close: async () => { window.__files[name] = buf; } }; },
    async getFile() { const s = window.__files[name] ?? ''; return { size: new Blob([s]).size, lastModified: Date.now() }; },
  });
  const dir = {
    kind: 'directory', name: 'Transcripts',
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    getFileHandle: async (name) => fileHandle(name),
    async *entries() { for (const n of Object.keys(window.__files)) yield [n, fileHandle(n)]; },
  };
  window.showDirectoryPicker = async () => dir;
  // IndexedDB can't structured-clone our fake handle; keep the "persisted" one in memory.
  const origPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) { return origPut.call(this, k === 'folder' ? 'fake' : v, k); };
}

async function openApp() {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakes);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__earshot);
  return { page, ctx, errors };
}

test('speech becomes timestamped lines and autosaves to the chosen folder', async () => {
  const { page, ctx, errors } = await openApp();

  await page.click('#folderBtn');
  await page.waitForFunction(() => document.getElementById('folderLabel').textContent.includes('Transcripts'));
  await page.fill('#title', 'Demo call');

  await page.click('#recBtn');
  assert.equal(await page.getAttribute('#recBtn', 'aria-pressed'), 'true');
  await page.evaluate(() => window.__say('hello and welcome to the demo'));
  await page.evaluate(() => window.__say('this line gets saved automatically'));

  await page.waitForSelector('#transcript li:nth-child(2)');
  const lines = await page.$$eval('#transcript .text', els => els.map(e => e.textContent));
  assert.deepEqual(lines, ['Hello and welcome to the demo.', 'This line gets saved automatically.']);
  assert.equal(await page.textContent('#words'), '11 words');

  // Autosave is debounced ~900ms.
  await page.waitForFunction(() => Object.keys(window.__files).length >= 2, null, { timeout: 5000 });
  const files = await page.evaluate(() => window.__files);
  const names = Object.keys(files).sort();
  assert.ok(names.every(n => /^transcript-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-demo-call\.(md|txt)$/.test(n)), names.join());
  const md = files[names.find(n => n.endsWith('.md'))];
  assert.match(md, /^# Demo call/);
  assert.match(md, /This line gets saved automatically\./);

  // Stop, then the sidebar lists the saved files.
  await page.click('#recBtn');
  assert.equal(await page.getAttribute('#recBtn', 'aria-pressed'), 'false');
  await page.waitForFunction(() => document.querySelectorAll('#files li .name').length >= 2);

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('editing a line and enabling SRT is reflected in the next save', async () => {
  const { page, ctx, errors } = await openApp();
  await page.click('#folderBtn');
  await page.waitForFunction(() => window.__earshot.folderOk);

  await page.keyboard.press('Space'); // shortcut starts recording
  await page.evaluate(() => window.__say('teh quick brown fox'));
  await page.waitForSelector('#transcript li');
  await page.keyboard.press('Escape');
  await page.click('#recBtn');

  const text = page.locator('#transcript .text').first();
  await text.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('The quick brown fox.');
  await page.keyboard.press('Enter');

  await page.click('.formats label:has-text(".srt")');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => Object.keys(window.__files).some(n => n.endsWith('.srt')));

  const srt = await page.evaluate(() => Object.entries(window.__files).find(([n]) => n.endsWith('.srt'))[1]);
  assert.match(srt, /^1\n00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}\nThe quick brown fox\.\n$/);
  assert.match(await page.textContent('#saveStatus'), /Saved 3 files/);

  // Draft survives a reload.
  await page.reload();
  await page.waitForFunction(() => window.__earshot);
  assert.equal(await page.locator('#transcript .text').first().textContent(), 'The quick brown fox.');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('without speech support the app falls back to tab audio instead of crashing', async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__earshot);
  // Mic mode is unavailable, so the app falls back to on-device tab transcription.
  assert.equal(await page.isDisabled('[data-source="mic"]'), true);
  assert.equal(await page.getAttribute('[data-source="tab"]', 'aria-pressed'), 'true');
  assert.equal(await page.isVisible('#engineCard'), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
