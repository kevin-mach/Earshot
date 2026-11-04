// Runs Whisper on-device (WebGPU when available, otherwise WebAssembly).
// Audio never leaves the machine; model weights are fetched once from the
// Hugging Face Hub and then served from the browser cache.
// transformers.min.js is the self-contained browser bundle (onnxruntime included);
// the .web builds use bare imports that need a bundler.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null;
let loadedKey = '';

async function hasWebGPU() {
  try { return Boolean(await navigator.gpu?.requestAdapter()); } catch { return false; }
}

async function load(model) {
  const device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  const key = `${model}|${device}`;
  if (asr && loadedKey === key) return device;
  asr = null;
  const progress_callback = (p) => {
    // 'progress_total' aggregates every file of the model, so the bar moves once, smoothly.
    if (p.status === 'progress_total') postMessage({ type: 'progress', progress: p.progress ?? 0, loaded: p.loaded ?? 0, total: p.total ?? 0 });
  };
  try {
    asr = await pipeline('automatic-speech-recognition', model, { device, dtype: device === 'webgpu' ? 'fp32' : 'q8', progress_callback });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // Some GPUs/drivers fail to compile the shaders; fall back to CPU.
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
    loadedKey = `${model}|wasm`;
    return 'wasm';
  }
  // Warm up so the first real chunk isn't slow.
  await asr(new Float32Array(16000), {});
  loadedKey = key;
  return device;
}

let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      if (msg.type === 'load') {
        const device = await load(msg.model);
        postMessage({ type: 'ready', device });
      } else if (msg.type === 'transcribe') {
        const opts = msg.multilingual ? { language: msg.language, task: 'transcribe' } : {};
        const t0 = performance.now();
        const out = await asr(msg.audio, opts);
        postMessage({ type: 'result', id: msg.id, text: out.text ?? '', ms: performance.now() - t0 });
      }
    } catch (err) {
      postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
    }
  });
};
