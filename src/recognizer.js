// Thin wrapper around the Web Speech API that survives Chrome's habit of
// ending recognition after silence or ~60 s, by transparently restarting.

const Impl = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const isSupported = () => Boolean(Impl);

export class LiveRecognizer extends EventTarget {
  constructor({ lang = 'en-US' } = {}) {
    super();
    this.lang = lang;
    this.wanted = false;   // user intent: should we be listening?
    this.rec = null;
    this.restarts = 0;
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  #build() {
    const rec = new Impl();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => this.#emit('state', 'listening');

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (r.isFinal) this.#emit('final', { text, confidence: r[0].confidence });
        else interim += text;
      }
      this.#emit('interim', interim);
    };

    rec.onerror = (e) => {
      // "no-speech" and "aborted" are routine; let onend restart us.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.wanted = false;
      this.#emit('error', e.error);
    };

    rec.onend = () => {
      if (this.wanted) {
        this.restarts++;
        // Small delay avoids a tight loop if the engine keeps failing.
        setTimeout(() => { if (this.wanted) this.#safeStart(); }, 250);
      } else {
        this.#emit('state', 'idle');
      }
    };
    return rec;
  }

  #safeStart() {
    try { this.rec = this.#build(); this.rec.start(); }
    catch (err) { this.#emit('error', err.message || String(err)); }
  }

  start() {
    if (!Impl) throw new Error('Speech recognition is not supported in this browser.');
    this.wanted = true;
    this.#safeStart();
  }

  stop() {
    this.wanted = false;
    try { this.rec?.stop(); } catch { /* already stopped */ }
  }

  setLang(lang) {
    this.lang = lang;
    if (this.wanted) { try { this.rec?.stop(); } catch {} } // onend restarts with new lang
  }
}
