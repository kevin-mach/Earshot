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
