// Captures the audio of a browser tab (or the whole screen) and transcribes it
// with on-device Whisper. In meeting mode it also records the microphone as a
// second lane, so lines are labelled "Them" (the call) or "You" (your mic).
// Emits the same events as LiveRecognizer:
//   state, interim, final {text, startMs, endMs, speaker?}, error, plus level, progress, ended, warning.
import { Chunker } from './chunker.js';
import { cleanWhisper } from './format.js';

export const canCaptureTab = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export const MODELS = {
  tiny:  { label: 'Fast (tiny)',      id: 'Xenova/whisper-tiny',  size: '~40–150 MB' },
  base:  { label: 'Balanced (base)',  id: 'Xenova/whisper-base',  size: '~80–290 MB' },
  small: { label: 'Accurate (small)', id: 'Xenova/whisper-small', size: '~250 MB–1 GB' },
};

/** English gets the English-only checkpoint (more accurate); others get the multilingual one. */
export function modelFor(size, lang) {
  const base = (MODELS[size] ?? MODELS.base).id;
  const code = String(lang || 'en').slice(0, 2).toLowerCase();
  return code === 'en' ? { id: `${base}.en`, multilingual: false, code } : { id: base, multilingual: true, code };
}

// AudioWorklet that forwards raw samples to the main thread.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('earshot-tap', Tap);`;

export class TabTranscriber extends EventTarget {
  constructor({ model = 'base', lang = 'en-US', meeting = false, workerUrl = new URL('./whisper-worker.js', import.meta.url) } = {}) {
    super();
    Object.assign(this, { modelSize: model, lang, meeting, workerUrl });
    this.lanes = [];
    this.wanted = false;
    this.nextId = 0;
    this.inflight = new Map();   // id -> chunk timing
    this.drainWaiters = [];
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get backlog() { return this.inflight.size; }

  /** Never throws: any failure is cleaned up and reported as an 'error' event. */
  async start() {
    try {
      return await this.#start();
    } catch (err) {
      const wasWanted = this.wanted;
      this.wanted = false;
      this.#teardown();
      if (wasWanted) this.#emit('error', `start-failed: ${err?.name || 'Error'}: ${err?.message || err}`);
      return false;
    }
  }

  #teardown() {
    clearInterval(this.diagTimer); this.diagTimer = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.micStream?.getTracks().forEach(t => t.stop());
    this.stream = this.micStream = null;
    try { this.lanes.forEach(l => l.tap.disconnect()); } catch {}
    this.lanes = [];
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  async #start() {
    this.wanted = true;
    this.sent = 0; this.done = 0; this.silentWarned = false;
    this.#emit('state', 'starting');

    // 1. Ask the user to share a tab. Chrome requires video in the request; we ignore it.
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        preferCurrentTab: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
      });
    } catch (err) {
      this.wanted = false;
      this.#emit('error', err?.name === 'NotAllowedError' ? 'share-cancelled' : (err?.message || 'capture-failed'));
      return false;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach(t => t.stop());
      this.wanted = false;
      this.#emit('error', 'no-audio');
      return false;
    }
    this.stream = stream;
    track.addEventListener('ended', () => { if (this.wanted) this.#emit('ended'); });
    stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (this.wanted) this.#emit('ended'); }));

    // 2. Start the model loading in parallel with audio capture.
    const { id, multilingual, code } = modelFor(this.modelSize, this.lang);
    this.multilingual = multilingual; this.code = code;
    if (!this.worker || this.workerModel !== id) {
      this.worker?.terminate();
      this.worker = new Worker(this.workerUrl, { type: 'module' });
      this.worker.onmessage = (e) => this.#onWorker(e.data);
      this.worker.onerror = (e) => this.#emit('error', `model-worker: ${e.message || 'failed to start'}`);
      this.workerModel = id;
      this.ready = false;
      this.worker.postMessage({ type: 'load', model: id });
      this.#emit('progress', { progress: 0, loading: true });
    }

    // 3. Pipe audio at 16 kHz into the chunker.
    // stop() can run while we await below (e.g. the model fails to load, or the
    // user stops sharing instantly); bail out instead of reviving a dead session.
    const ctx = this.ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } catch (err) { if (this.wanted) throw err; }
    URL.revokeObjectURL(url);
    if (!this.wanted || this.ctx !== ctx) { if (ctx.state !== 'closed') ctx.close().catch(() => {}); return false; }
    this.t0 = performance.now();
    this.#addLane(track, this.meeting ? 'Them' : null);

    // 4. Meeting mode: add your microphone as a second, separately transcribed lane.
    if (this.meeting) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!this.wanted || this.ctx !== ctx) { mic.getTracks().forEach(t => t.stop()); return false; }
        this.micStream = mic;
        this.#addLane(mic.getAudioTracks()[0], 'You');
      } catch (err) {
        if (!this.wanted) return false;
        this.#emit('warning', 'mic-unavailable');
      }
    }

    // Live audio check: lets the UI show what each lane is actually receiving,
    // and warns when a share arrives with a track but no sound in it.
    this.diagTimer = setInterval(() => this.#diag(), 500);
    this.#emit('state', 'listening');
    this.#status();
    return true;
  }

  #diag() {
    const lanes = this.lanes.map(l => {
      const out = { speaker: l.speaker || 'Tab', label: l.label, level: l.recent, peak: l.peak };
      l.recent = 0;
      return out;
    });
    this.#emit('diag', { lanes, sent: this.sent, done: this.done, ready: !!this.ready });
    const call = this.lanes[0];
    if (call && !this.silentWarned && performance.now() - this.t0 > 6000 && call.peak < 0.0005) {
      this.silentWarned = true;
      this.#emit('warning', 'silent-call');
    }
  }

  #addLane(track, speaker) {
    const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const tap = new AudioWorkletNode(this.ctx, 'earshot-tap');
    const mute = this.ctx.createGain(); mute.gain.value = 0;   // keep the graph pulling without double playback
    src.connect(tap).connect(mute).connect(this.ctx.destination);
    // Lanes can start a moment apart; offset keeps both on the same clock.
    const lane = { speaker, tap, level: 0, recent: 0, peak: 0, label: track.label || '', offsetMs: performance.now() - this.t0, chunker: new Chunker({ sampleRate: this.ctx.sampleRate }) };
    tap.port.onmessage = (e) => this.#onAudio(lane, e.data);
    this.lanes.push(lane);
  }

  #onAudio(lane, samples) {
    let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    lane.level = Math.sqrt(s / samples.length);
    lane.recent = Math.max(lane.recent, lane.level);
    lane.peak = Math.max(lane.peak, lane.level);
    this.#emit('level', Math.max(...this.lanes.map(l => l.level)));
    for (const c of lane.chunker.push(samples)) this.#send(c, lane);
  }

  #send(chunk, lane) {
    normalize(chunk.audio);
    this.sent++;
    const id = ++this.nextId;
    this.inflight.set(id, { startMs: chunk.startMs + lane.offsetMs, endMs: chunk.endMs + lane.offsetMs, ...(lane.speaker ? { speaker: lane.speaker } : {}) });
    if (!this.worker) { this.inflight.delete(id); return; }
    this.worker.postMessage({ type: 'transcribe', id, audio: chunk.audio, language: this.code, multilingual: this.multilingual }, [chunk.audio.buffer]);
    this.#status();
  }

  #onWorker(m) {
    if (m.type === 'progress') this.#emit('progress', { ...m, loading: true });
    else if (m.type === 'ready') { this.ready = true; this.device = m.device; this.#emit('progress', { progress: 100, loading: false, device: m.device }); this.#status(); }
    else if (m.type === 'error' && m.id === undefined) {
      // The model itself failed to load: drop the worker so the next start retries the download.
      this.worker?.terminate(); this.worker = null; this.workerModel = null; this.ready = false;
      this.inflight.clear(); this.drainWaiters.splice(0).forEach(r => r());
      this.#emit('progress', { loading: false, failed: true });
      this.#emit('error', `model-load: ${m.message}`);
    }
    else if (m.type === 'result' || m.type === 'error') {
      const timing = this.inflight.get(m.id);
      this.inflight.delete(m.id);
      this.done++;
      if (m.type === 'error') this.#emit('error', `model: ${m.message}`);
      else if (timing) {
        const text = cleanWhisper(m.text);
        if (text) this.#emit('final', { text, ...timing });
      }
      this.#status();
      if (!this.inflight.size) this.drainWaiters.splice(0).forEach(r => r());
    }
  }

  #status() {
    if (!this.wanted && !this.inflight.size) return this.#emit('interim', '');
    const parts = [];
    if (!this.ready) parts.push('Loading speech model…');
    else if (this.wanted) parts.push(this.meeting ? (this.lanes.length > 1 ? 'Listening to the call and your mic…' : 'Listening to the call (no mic)…') : 'Listening to tab audio…');
    if (this.inflight.size) parts.push(`transcribing ${this.inflight.size} clip${this.inflight.size > 1 ? 's' : ''}`);
    this.#emit('interim', parts.join(' · '));
  }

  /** Stop capturing; resolves once already-captured audio has been transcribed. */
  async stop() {
    if (!this.wanted && !this.stream && !this.micStream) return;
    this.wanted = false;
    for (const lane of this.lanes) for (const c of lane.chunker.flush()) this.#send(c, lane);
    this.#teardown();
    if (this.inflight.size) await new Promise(r => this.drainWaiters.push(r));
    this.#emit('interim', '');
    this.#emit('state', 'idle');
  }

  dispose() { this.worker?.terminate(); this.worker = null; }
}

/** Boost quiet clips (e.g. low system volume) toward a healthy peak; Whisper copes better. */
export function normalize(audio, target = 0.9, maxGain = 20) {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) { const a = Math.abs(audio[i]); if (a > peak) peak = a; }
  if (peak <= 0 || peak >= target) return audio;
  const g = Math.min(maxGain, target / peak);
  for (let i = 0; i < audio.length; i++) audio[i] *= g;
  return audio;
}
