// ASIQPAI AI PRO MIX staging server — static, no production API or secrets.
// Railway service start command: node preview/serve.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const routes = new Map([
  ['/', ['preview/pro-mix/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['preview/pro-mix/app.js', 'text/javascript; charset=utf-8']],
  ['/studio/audio.js', ['studio/audio.js', 'text/javascript; charset=utf-8']],
  ['/studio/pro-mix.js', ['studio/pro-mix.js', 'text/javascript; charset=utf-8']]
]);
const port = Number(process.env.PORT || 3000);
const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  const isHead = req.method === 'HEAD';
  if (req.method !== 'GET' && !isHead) {
    res.writeHead(405, {'Allow':'GET, HEAD'}).end();
    return;
  }
  const entry = routes.get(path);
  if (!entry) {
    res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}).end('Not found');
    return;
  }
  try {
    const file = await readFile(resolve(root, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self)',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"
    });
    res.end(isHead ? undefined : file);
  } catch {
    res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'}).end('Preview unavailable');
  }
});
server.listen(port, '0.0.0.0', () => {
  process.stdout.write('ASIQPAI Pro Mix static QA server is running on ' + port + '\n');
});
