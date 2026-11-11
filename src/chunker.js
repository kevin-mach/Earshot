// Splits a live 16 kHz mono stream into utterance-sized chunks for Whisper.
// Pure logic (no Web Audio), so it is unit-tested in Node.
//
// A chunk is cut when it is at least `minSec` long and the last `silenceSec`
// were quiet (a natural pause), or when it reaches `maxSec`. Chunks with almost
// no voiced audio are dropped: Whisper "hallucinates" text ("Thank you.") on silence.

export class Chunker {
  constructor({ sampleRate = 16000, minSec = 2.5, maxSec = 12, silenceSec = 0.6, frameMs = 30, threshold = 0.012, minVoicedSec = 0.4 } = {}) {
    Object.assign(this, { sampleRate, minSec, maxSec, silenceSec, threshold, minVoicedSec });
    this.minThreshold = threshold / 4;   // adaptive floor: never more sensitive than this
    this.floor = threshold;
    this.frame = Math.round(sampleRate * frameMs / 1000);
    this.reset();
  }

  reset(atSample = 0) {
    this.parts = [];          // Float32Array frames of the current chunk
    this.len = 0;             // samples in current chunk
    this.voiced = 0;          // voiced samples in current chunk
    this.quietRun = 0;        // trailing quiet samples
    this.startSample = atSample;
    this.total = atSample;    // samples consumed since start
    this.pending = new Float32Array(0);
  }

  /** Feed samples; returns any completed chunks. */
  push(samples) {
    const out = [];
    let buf = this.pending.length ? concat([this.pending, samples]) : samples;
    let i = 0;
    for (; i + this.frame <= buf.length; i += this.frame) {
      const f = buf.subarray(i, i + this.frame);
      const level = rms(f);
      // Track the background noise floor (drops instantly, rises slowly) so quiet
      // sources such as low-volume system audio still register as speech.
      this.floor = level < this.floor ? level : this.floor + (level - this.floor) * 0.002;
      const loud = level >= Math.max(this.minThreshold, Math.min(this.threshold, this.floor * 4));
      this.total += f.length;

      if (!this.voiced && !loud) {
        // Still in leading silence: keep only a short pre-roll so start times stay accurate.
        this.parts.push(f.slice()); this.len += f.length;
        const keep = Math.round(this.sampleRate * 0.3);
        while (this.len - this.parts[0].length >= keep) { this.len -= this.parts.shift().length; }
        this.startSample = this.total - this.len;
        continue;
      }

      this.parts.push(f.slice()); this.len += f.length;
      if (loud) { this.voiced += f.length; this.quietRun = 0; } else this.quietRun += f.length;

      const sec = this.len / this.sampleRate;
      if ((sec >= this.minSec && this.quietRun / this.sampleRate >= this.silenceSec) || sec >= this.maxSec) {
        const c = this.#cut();
        if (c) out.push(c);
      }
    }
    this.pending = buf.slice(i);
    return out;
  }

  /** Emit whatever is buffered (e.g. when the user presses stop). */
  flush() {
    const c = this.voiced ? this.#cut() : null;
    this.reset(this.total);
    return c ? [c] : [];
  }

  #cut() {
    // Trim most of the trailing silence, keeping a little tail.
    const tail = Math.min(this.quietRun, Math.max(0, this.quietRun - Math.round(this.sampleRate * 0.2)));
    const audio = concat(this.parts).subarray(0, this.len - tail);
    const chunk = {
      audio,
      startMs: (this.startSample / this.sampleRate) * 1000,
      endMs: ((this.startSample + audio.length) / this.sampleRate) * 1000,
    };
    const voicedSec = this.voiced / this.sampleRate;
    const nextStart = this.total;
    this.parts = []; this.len = 0; this.voiced = 0; this.quietRun = 0; this.startSample = nextStart;
    return voicedSec >= this.minVoicedSec ? chunk : null;
  }
}

export function rms(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / (f.length || 1));
}

function concat(arrs) {
  const n = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
