// Pure formatting helpers — no DOM access, so they run in Node tests too.

/** @typedef {{ start: number, end: number, text: string, speaker?: string }} Segment  (ms offsets from session start) */
/** @typedef {{ id: string, startedAt: string, lang: string, title?: string, segments: Segment[] }} Session */

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** 83456 -> "00:01:23" */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}

/** 83456 -> "00:01:23,456" (SubRip) */
export function srtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  return `${clock(ms)},${pad(ms % 1000, 3)}`;
}

/** 83456 -> "00:01:23.456" (WebVTT) */
export function vttTime(ms) {
  return srtTime(ms).replace(',', '.');
}

/** Tidy one recognised utterance: trim, collapse whitespace, capitalise, end with punctuation. */
export function tidy(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t[0].toUpperCase() + t.slice(1);
  if (!/[.!?…,;:]$/.test(t)) t += '.';
  return t;
}

/** Date -> "2026-11-04_10-13-05" in local time (safe for file names). */
export function stamp(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Turn a user title into a safe file-name fragment. */
export function slug(title) {
  return String(title ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function baseName(session) {
  const s = slug(session.title);
  return `transcript-${stamp(session.startedAt)}${s ? '-' + s : ''}`;
}

export function wordCount(session) {
  return session.segments.reduce((n, seg) => n + (seg.text.match(/\S+/g)?.length ?? 0), 0);
}

export function duration(session) {
  const last = session.segments.at(-1);
  return last ? last.end : 0;
}

const said = (s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text);

export function toText(session) {
  return session.segments.map(said).join('\n') + (session.segments.length ? '\n' : '');
}

export function toMarkdown(session) {
  const started = new Date(session.startedAt);
  const head = [
    `# ${session.title?.trim() || 'Transcript'}`,
    '',
    `- **Started:** ${started.toLocaleString()}`,
    `- **Language:** ${session.lang}`,
    `- **Duration:** ${clock(duration(session))}`,
    `- **Words:** ${wordCount(session)}`,
    '',
    '---',
    '',
  ];
  const body = session.segments.map(s => `**[${clock(s.start)}]${s.speaker ? ' ' + s.speaker + ':' : ''}** ${s.text}\n`);
  return head.concat(body).join('\n');
}

export function toSrt(session) {
  return session.segments
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 500))}\n${said(s)}\n`)
    .join('\n');
}

export function toVtt(session) {
  return 'WEBVTT\n\n' + session.segments
    .map(s => `${vttTime(s.start)} --> ${vttTime(Math.max(s.end, s.start + 500))}\n${s.speaker ? `<v ${s.speaker}>` : ''}${s.text}\n`)
    .join('\n');
}

export function toJSON(session) {
  return JSON.stringify({ ...session, words: wordCount(session), durationMs: duration(session) }, null, 2) + '\n';
}

export const FORMATS = {
  md:   { label: 'Markdown', ext: 'md',   mime: 'text/markdown',    render: toMarkdown },
  txt:  { label: 'Plain text', ext: 'txt', mime: 'text/plain',      render: toText },
  srt:  { label: 'SRT subtitles', ext: 'srt', mime: 'application/x-subrip', render: toSrt },
  vtt:  { label: 'WebVTT', ext: 'vtt',    mime: 'text/vtt',         render: toVtt },
  json: { label: 'JSON', ext: 'json',     mime: 'application/json', render: toJSON },
};

// Whisper adds sound tags ("[Music]", "(laughs)", "♪") and, on near-silence,
// stock phrases learned from YouTube captions. Strip those; keep real speech.
const HALLUCINATIONS = [
  /^thanks? (you )?(so much )?for watching[.!]*$/i,
  /^(please )?(like and )?subscribe[.!]*$/i,
  /^thank you[.!]*$/i,
  /^you$/i,
  /^bye[.!]*$/i,
  /^subtitles? by .*$/i,
  /^\.+$/,
];

export function cleanWhisper(text) {
  let t = String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!t || HALLUCINATIONS.some(r => r.test(t))) return '';
  // Collapse a phrase stuck on repeat ("I'm I'm I'm I'm ..."), a classic Whisper failure.
  t = t.replace(/\b(.{2,40}?)(?:[\s,.]+\1\b){3,}/gi, '$1');
  return tidy(t);
}

/**
 * Word-overlap similarity (0–1) used to spot echo in meeting mode: when you're on
 * speakers, your mic re-hears the call and Whisper transcribes it twice.
 */
export function similarity(a, b) {
  const words = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return 0;
  const pool = new Map();
  for (const w of B) pool.set(w, (pool.get(w) || 0) + 1);
  let hit = 0;
  for (const w of A) if (pool.get(w) > 0) { hit++; pool.set(w, pool.get(w) - 1); }
  return hit / Math.min(A.length, B.length);
}

/** True when a "You" line is just the call's audio leaking into the mic. */
export function isEcho(mine, theirs, { windowMs = 4000, threshold = 0.6 } = {}) {
  if (!mine || !theirs) return false;
  const overlap = mine.start < theirs.end + windowMs && theirs.start < mine.end + windowMs;
  const shortest = Math.min(mine.text.split(/\s+/).length, theirs.text.split(/\s+/).length);
  return overlap && shortest >= 3 && similarity(mine.text, theirs.text) >= threshold;
}
