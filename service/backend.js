'use strict';
const http = require('http');
const crypto = require('crypto');
const { pipeline } = require('stream');
const network = require('./network');
const { Onsen, HEADERS, HOSTS, API, id } = require('./onsen');
const { toVtt } = require('./subtitles');

function rewriteHls(text, base, register) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist.');
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/\bURI="([^"]+)"/g,
      (_, uri) => `URI="${register(new URL(uri, base).href)}"`);
    return register(new URL(line.trim(), base).href);
  }).join('\n');
}
function sourceError(error) {
  if (error.code === 'SOURCE_CHALLENGE') return error.message;
  if (error.status === 403) return 'AnimeOnsen refused this connection (HTTP 403). It may require browser verification.';
  if (error.status === 429) return 'AnimeOnsen is limiting requests. Wait a little, then retry.';
  return error.message || 'The source could not be reached.';
}
async function startBackend(options = {}) {
  const source = options.source || new Onsen();
  const open = options.open || network.open;
  const token = crypto.randomBytes(32).toString('hex');
  const resources = new Map(), reverse = new Map(), sockets = new Set();
  let origin, base, lastError = null;
  const allowedHosts = new Set(HOSTS);
  function approveMedia(value) {
    const u = new URL(value);
    // Only media URLs supplied by the fixed AnimeOnsen API can introduce a host.
    const hosts = new Set([u.hostname.toLowerCase()]);
    network.checkedUrl(u.href, hosts);
    allowedHosts.add(u.hostname.toLowerCase());
    return u.href;
  }
  function register(value, kind = 'media') {
    const url = network.checkedUrl(value, allowedHosts).href;
    const key = kind + ':' + url;
    const extension = kind === 'subtitle' ? '.vtt' : (new URL(url).pathname.match(/\.(m3u8|mp4|m4s|ts|webm|aac|mpd)$/i)?.[0] || '');
    if (reverse.has(key)) return base + '/resource/' + reverse.get(key) + extension;
    if (resources.size >= 20000) throw new Error('This playback session is too large. Close and reopen the app.');
    const resourceId = crypto.randomBytes(12).toString('hex');
    resources.set(resourceId, { url, kind }); reverse.set(key, resourceId);
    return base + '/resource/' + resourceId + extension;
  }
  function decorate(item) { return { ...item, image: register(item.image, 'image') }; }
  function sendJson(res, code, object) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(object));
  }
  async function handleApi(url, res) {
    const op = url.pathname.split('/').pop();
    const p = url.searchParams;
    const title = p.get('title') === 'english' ? 'english' : 'romaji';
    let data;
    if (op === 'catalog') {
      data = await source.catalog(Number(p.get('start') || 0), title);
      data.items = data.items.map(decorate);
    } else if (op === 'search') {
      data = await source.search(p.get('q'), title); data.items = data.items.map(decorate);
    } else if (op === 'details') data = decorate(await source.details(id(p.get('id')), title));
    else if (op === 'episodes') data = await source.episodes(id(p.get('id')), title);
    else if (op === 'stream') {
      const result = await source.stream(id(p.get('id')), id(p.get('episode')));
      const stream = approveMedia(result.url);
      // Video-on-demand media and image resources have opaque, session-bound URLs.
      data = { url: register(stream),
        format: /\.mpd(?:\?|$)/i.test(stream) ? 'dash' : /\.m3u8(?:\?|$)/i.test(stream) ? 'hls' : 'video',
        subtitles: result.subtitles.map(track => ({ lang: track.lang, label: track.label,
          url: register(approveMedia(track.url), 'subtitle') })) };
    } else if (op === 'image') {
      data = { url: register(`${API}/image/210x300/${encodeURIComponent(id(p.get('id')))}`, 'image') };
    } else if (op === 'status') data = { source: 'AnimeOnsen', version: '0.1.0', lastError, loopbackOnly: true };
    else { sendJson(res, 404, { error: 'Unknown method.' }); return; }
    sendJson(res, 200, data);
  }
  async function handleResource(resource, req, res) {
    const headers = { ...HEADERS };
    if (req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range)) headers.Range = req.headers.range;
    if (new URL(resource.url).hostname === 'api.animeonsen.xyz' && typeof source.accessToken === 'function') {
      try { headers.Authorization = 'Bearer ' + await source.accessToken(); } catch (_) {}
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const upstream = await open(resource.url, { allowedHosts, headers, signal: controller.signal,
      method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
    if (![200, 206, 304].includes(upstream.statusCode)) {
      upstream.resume();
      const error = new Error(`Media request failed (HTTP ${upstream.statusCode}).`);
      error.status = upstream.statusCode; throw error;
    }
    const mime = String(upstream.headers['content-type'] || 'application/octet-stream');
    const isHls = /mpegurl/i.test(mime) || /\.m3u8(?:\?|$)/i.test(resource.url);
    if (req.method !== 'HEAD' && (resource.kind === 'subtitle' || isHls)) {
      const bytes = await network.collect(upstream, 8 * 1024 * 1024);
      const text = resource.kind === 'subtitle' ? toVtt(bytes.toString('utf8')) :
        rewriteHls(bytes.toString('utf8'), upstream.finalUrl || resource.url, url => register(approveMedia(url)));
      res.writeHead(200, { 'Content-Type': resource.kind === 'subtitle' ? 'text/vtt; charset=utf-8' :
        'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      res.end(text); return;
    }
    if (/dash\+xml/i.test(mime) || /\.mpd(?:\?|$)/i.test(resource.url)) {
      upstream.resume(); throw new Error('This source returned DASH. This first TV build supports HLS and direct video.');
    }
    const outgoing = { 'Content-Type': mime, 'Cache-Control': resource.kind === 'image' ? 'private, max-age=600' : 'no-store' };
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'content-encoding']) {
      if (upstream.headers[h]) outgoing[h] = upstream.headers[h];
    }
    res.writeHead(upstream.statusCode, outgoing);
    pipeline(upstream, res, () => {});
  }
  const server = http.createServer(async (req, res) => {
    // Requests addressed through a non-loopback Host are rejected too (DNS rebinding).
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== 'null' && requestOrigin !== origin) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader('Access-Control-Allow-Origin', requestOrigin === origin ? origin : 'null');
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, origin);
    if (options.developmentHandler && await options.developmentHandler(req, res, url, { origin, base })) return;
    if (!url.pathname.startsWith('/' + token + '/')) { res.writeHead(404); res.end(); return; }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range' });
      res.end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    try {
      if (url.pathname.startsWith('/' + token + '/api/')) await handleApi(url, res);
      else if (url.pathname.startsWith('/' + token + '/resource/')) {
        const resource = resources.get(url.pathname.split('/').pop().split('.')[0]);
        if (!resource) { res.writeHead(404); res.end(); return; }
        await handleResource(resource, req, res);
      } else { res.writeHead(404); res.end(); }
    } catch (error) {
      lastError = { message: sourceError(error), at: new Date().toISOString() };
      if (!res.headersSent) sendJson(res, 502, { error: lastError.message });
      else res.destroy();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  base = origin + '/' + token;
  return { origin, base, server, register, approveMedia,
    close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
module.exports = { startBackend, rewriteHls, sourceError };
