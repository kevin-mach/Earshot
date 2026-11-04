// Zero-dependency static server. Microphone + folder APIs need a secure
// context, and http://localhost counts as one.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 5173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

export function serve(p = port) {
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path === '' || path.endsWith('/')) path += 'index.html';
    if (path.split(/[/\\]/).some(s => s === '..' || (s.startsWith('.') && s !== '.'))) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(join(root, path));
      res.writeHead(200, { 'content-type': (types[extname(path)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
    } catch { res.writeHead(404).end('Not found'); }
  });
  return new Promise(r => server.listen(p, '127.0.0.1', () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await serve();
  console.log(`Earshot running at http://localhost:${s.address().port}`);
}
