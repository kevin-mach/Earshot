import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, srtTime, vttTime, tidy, stamp, slug, baseName, wordCount, duration, toText, toMarkdown, toSrt, toVtt, toJSON } from '../src/format.js';

const session = {
  id: 'x', startedAt: new Date(2026, 10, 4, 9, 5, 7).toISOString(), lang: 'en-US', title: 'Team Sync: Q4 — Café',
  segments: [
    { start: 0, end: 2100, text: 'Hello everyone.' },
    { start: 2500, end: 83456, text: 'Let us get started.' },
  ],
};

test('clock formats hh:mm:ss and clamps negatives', () => {
  assert.equal(clock(0), '00:00:00');
  assert.equal(clock(83456), '00:01:23');
  assert.equal(clock(3_600_000 * 2 + 61_000), '02:01:01');
  assert.equal(clock(-50), '00:00:00');
});

test('srt / vtt timestamps include milliseconds', () => {
  assert.equal(srtTime(83456), '00:01:23,456');
  assert.equal(vttTime(83456), '00:01:23.456');
  assert.equal(srtTime(5), '00:00:00,005');
});

test('tidy capitalises, collapses whitespace and adds terminal punctuation', () => {
  assert.equal(tidy('  hello   world '), 'Hello world.');
  assert.equal(tidy('is this working?'), 'Is this working?');
  assert.equal(tidy(''), '');
  assert.equal(tidy(null), '');
});

test('stamp and slug produce filesystem-safe names', () => {
  assert.equal(stamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02_03-04-05');
  assert.equal(slug('Team Sync: Q4 — Café!'), 'team-sync-q4-cafe');
  assert.equal(slug(''), '');
  assert.equal(baseName(session), 'transcript-2026-11-04_09-05-07-team-sync-q4-cafe');
  assert.equal(baseName({ ...session, title: '' }), 'transcript-2026-11-04_09-05-07');
});

test('stats', () => {
  assert.equal(wordCount(session), 6);
  assert.equal(duration(session), 83456);
  assert.equal(duration({ segments: [] }), 0);
});

test('plain text export', () => {
  assert.equal(toText(session), 'Hello everyone.\nLet us get started.\n');
  assert.equal(toText({ segments: [] }), '');
});

test('markdown export has header and timestamped lines', () => {
  const md = toMarkdown(session);
  assert.match(md, /^# Team Sync: Q4 — Café\n/);
  assert.match(md, /\*\*Duration:\*\* 00:01:23/);
  assert.match(md, /\*\*Words:\*\* 6/);
  assert.match(md, /\*\*\[00:00:02\]\*\* Let us get started\./);
});

test('srt export is numbered with arrow ranges', () => {
  assert.equal(toSrt(session),
    '1\n00:00:00,000 --> 00:00:02,100\nHello everyone.\n\n' +
    '2\n00:00:02,500 --> 00:01:23,456\nLet us get started.\n');
});

test('vtt export starts with header and enforces a minimum cue length', () => {
  const vtt = toVtt({ segments: [{ start: 1000, end: 1000, text: 'Hi.' }] });
  assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:01.500\nHi.\n');
});

test('json export round-trips and adds derived fields', () => {
  const parsed = JSON.parse(toJSON(session));
  assert.equal(parsed.words, 6);
  assert.equal(parsed.durationMs, 83456);
  assert.deepEqual(parsed.segments, session.segments);
});

// ---------- tab audio: chunker, Whisper cleanup, model choice ----------
import { Chunker } from '../src/chunker.js';
import { cleanWhisper } from '../src/format.js';
import { modelFor } from '../src/tab-source.js';

const SR = 16000;
const tone = (sec, amp = 0.2) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin(i / 8));
const quiet = (sec) => new Float32Array(Math.round(sec * SR));
const feed = (ch, arr, step = 128) => { const out = []; for (let i = 0; i < arr.length; i += step) out.push(...ch.push(arr.subarray(i, i + step))); return out; };
const join = (...a) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

test('chunker cuts at a natural pause and reports accurate times', () => {
  const ch = new Chunker();
  const out = feed(ch, join(quiet(2), tone(3), quiet(1), tone(3), quiet(1)));
  assert.equal(out.length, 2);
  // First utterance starts at ~2s (with ≤0.3s pre-roll) and ends shortly after 5s.
  assert.ok(out[0].startMs >= 1650 && out[0].startMs <= 2050, `start ${out[0].startMs}`);
  assert.ok(out[0].endMs >= 5000 && out[0].endMs <= 5600, `end ${out[0].endMs}`);
  assert.ok(out[1].startMs >= 5000 && out[1].startMs <= 6100, `start2 ${out[1].startMs}`);
});

test('chunker force-cuts long unbroken speech at maxSec', () => {
  const ch = new Chunker({ maxSec: 5 });
  const out = feed(ch, tone(16));
  assert.equal(out.length, 3);
  assert.ok(out.every(c => c.audio.length <= 5 * SR + ch.frame));
});

test('chunker drops pure silence and blips (prevents Whisper hallucinations)', () => {
  const ch = new Chunker();
  assert.equal(feed(ch, quiet(20)).length, 0);
  assert.equal(feed(ch, join(tone(0.1), quiet(4))).length, 0);
  assert.equal(ch.flush().length, 0);
});

test('chunker flush emits trailing speech on stop', () => {
  const ch = new Chunker();
  assert.equal(feed(ch, join(quiet(1), tone(1.5))).length, 0);
  const [c] = ch.flush();
  assert.ok(c && c.endMs > 2000);
});

test('cleanWhisper strips sound tags and stock hallucinations', () => {
  assert.equal(cleanWhisper(' [Music] '), '');
  assert.equal(cleanWhisper('Thanks for watching!'), '');
  assert.equal(cleanWhisper('(upbeat music) so today we are building a robot'), 'So today we are building a robot.');
  assert.equal(cleanWhisper('♪ la la ♪'), 'La la.');
  assert.equal(cleanWhisper('Thank you for coming tonight'), 'Thank you for coming tonight.');
  assert.equal(cleanWhisper('I think, I think, I think, I think, I think we should go'), 'I think we should go.');
});

test('modelFor picks English-only checkpoints for English', () => {
  assert.deepEqual(modelFor('base', 'en-GB'), { id: 'Xenova/whisper-base.en', multilingual: false, code: 'en' });
  assert.deepEqual(modelFor('tiny', 'fr-FR'), { id: 'Xenova/whisper-tiny', multilingual: true, code: 'fr' });
  assert.equal(modelFor('nope', 'de-DE').id, 'Xenova/whisper-base');
});
