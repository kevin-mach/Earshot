// Local-folder persistence via the File System Access API.
// The chosen directory handle is kept in IndexedDB so it survives reloads;
// the browser re-prompts for permission once per session when needed.

const DB = 'live-transcribe';
const STORE = 'kv';

export const canPickFolder = () => typeof globalThis.showDirectoryPicker === 'function';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const kvGet = (k) => kv('readonly', s => s.get(k)).catch(() => undefined);
export const kvSet = (k, v) => kv('readwrite', s => s.put(v, k)).catch(() => undefined);
export const kvDel = (k) => kv('readwrite', s => s.delete(k)).catch(() => undefined);

export async function pickFolder() {
  const handle = await showDirectoryPicker({ id: 'live-transcribe', mode: 'readwrite', startIn: 'documents' });
  await kvSet('folder', handle);
  return handle;
}

export async function savedFolder() {
  return (await kvGet('folder')) ?? null;
}

export async function forgetFolder() { await kvDel('folder'); }

/** Returns 'granted' | 'prompt' | 'denied'. Pass request=true from a user gesture to prompt. */
export async function permission(handle, request = false) {
  if (!handle?.queryPermission) return 'denied';
  const opts = { mode: 'readwrite' };
  let state = await handle.queryPermission(opts);
  if (state !== 'granted' && request) state = await handle.requestPermission(opts);
  return state;
}

export async function writeFile(dir, name, contents) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}

/** List transcript files in the folder, newest first. */
export async function listTranscripts(dir) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'file' && name.startsWith('transcript-')) {
      const f = await h.getFile();
      out.push({ name, size: f.size, modified: f.lastModified });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** Fallback for browsers without folder access: trigger a normal download. */
export function download(name, contents, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([contents], { type: `${mime};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
