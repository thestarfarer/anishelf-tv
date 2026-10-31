'use strict';
const fs = require('fs');
const path = require('path');
const { startBackend } = require('../service/backend');
const appDir = path.resolve(__dirname, '../app');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
async function createDevelopmentServer(options = {}) {
  return startBackend({ ...options, developmentHandler: async (req, res, url, session) => {
    if (url.pathname === '/__session' && req.method === 'GET') {
      // Development only. Production session tokens are delivered over the Luna bus.
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ base: session.base })); return true;
    }
    if (url.pathname.startsWith(new URL(session.base).pathname)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
    let decoded;
    try { decoded = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
    catch (_) { res.writeHead(400); res.end(); return true; }
    const filename = path.resolve(appDir, '.' + decoded);
    if (!filename.startsWith(appDir + path.sep)) { res.writeHead(403); res.end(); return true; }
    try {
      const stat = await fs.promises.stat(filename);
      if (!stat.isFile()) throw new Error('Not a file');
      res.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(filename).pipe(res);
    } catch (_) { res.writeHead(404); res.end(); }
    return true;
  } });
}
if (require.main === module) {
  createDevelopmentServer({ port: 0 }).then(app => {
    console.log('AniShelf development app: ' + app.origin);
    console.log('Local preview only. Press Ctrl+C to stop.');
    process.on('SIGINT', async () => { await app.close(); process.exit(0); });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createDevelopmentServer };
