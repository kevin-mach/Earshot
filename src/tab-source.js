// Captures the audio of a browser tab (or the whole screen) and transcribes it
// with on-device Whisper. Emits the same events as LiveRecognizer:
//   state, interim, final {text, startMs, endMs}, error, plus level, progress, ended.
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
  constructor({ model = 'base', lang = 'en-US', workerUrl = new URL('./whisper-worker.js', import.meta.url) } = {}) {
    super();
    Object.assign(this, { modelSize: model, lang, workerUrl });
    this.wanted = false;
    this.nextId = 0;
    this.inflight = new Map();   // id -> chunk timing
    this.drainWaiters = [];
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get backlog() { return this.inflight.size; }

  async start() {
    this.wanted = true;
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
    const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.tap = new AudioWorkletNode(this.ctx, 'earshot-tap');
    const mute = this.ctx.createGain(); mute.gain.value = 0;   // keep the graph pulling without double playback
    src.connect(this.tap).connect(mute).connect(this.ctx.destination);
    this.chunker = new Chunker({ sampleRate: this.ctx.sampleRate });
    this.tap.port.onmessage = (e) => this.#onAudio(e.data);

    this.#emit('state', 'listening');
    this.#status();
    return true;
  }

  #onAudio(samples) {
    let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    this.#emit('level', Math.sqrt(s / samples.length));
    for (const c of this.chunker.push(samples)) this.#send(c);
  }

  #send(chunk) {
    const id = ++this.nextId;
    this.inflight.set(id, { startMs: chunk.startMs, endMs: chunk.endMs });
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
    else if (this.wanted) parts.push('Listening to tab audio…');
    if (this.inflight.size) parts.push(`transcribing ${this.inflight.size} clip${this.inflight.size > 1 ? 's' : ''}`);
    this.#emit('interim', parts.join(' · '));
  }

  /** Stop capturing; resolves once already-captured audio has been transcribed. */
  async stop() {
    if (!this.wanted && !this.stream) return;
    this.wanted = false;
    if (this.chunker) for (const c of this.chunker.flush()) this.#send(c);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    try { this.tap?.disconnect(); await this.ctx?.close(); } catch {}
    this.ctx = null;
    if (this.inflight.size) await new Promise(r => this.drainWaiters.push(r));
    this.#emit('interim', '');
    this.#emit('state', 'idle');
  }

  dispose() { this.worker?.terminate(); this.worker = null; }
}
