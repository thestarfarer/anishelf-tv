'use strict';
const http = require('http');
const crypto = require('crypto');
const { pipeline } = require('stream');
const network = require('./network');
const { Onsen, HEADERS, HOSTS, API, id } = require('./onsen');
const { toVtt } = require('./subtitles');
const { createSkipTimes } = require('./aniskip');
const { rewriteDash } = require('./dash');
const VERSION = '0.3.0';

function rewriteHls(text, base, register) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist.');
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/\bURI="([^"]+)"/g,
      (_, uri) => `URI="${register(new URL(uri, base).href)}"`);
    return register(new URL(line.trim(), base).href);
  }).join('\n');
}
function streamFormat(url) {
  return /\.mpd(?:\?|$)/i.test(url) ? 'dash' : /\.m3u8(?:\?|$)/i.test(url) ? 'hls' : 'video';
}
function sourceError(error) {
  if (error.code === 'SOURCE_CHALLENGE') return error.message;
  if (error.status === 403) return 'AnimeOnsen refused this connection (HTTP 403). It may require browser verification.';
  if (error.status === 429) return 'AnimeOnsen is limiting requests. Wait a little, then retry.';
  return error.message || 'The source could not be reached.';
}
async function startBackend(options = {}) {
  const clearance = options.clearance || null;
  const source = options.source || new Onsen(undefined, clearance);
  const open = options.open || network.open;
  const skipTimes = options.skipTimes || createSkipTimes();
  const token = crypto.randomBytes(32).toString('hex');
  const resources = new Map(), reverse = new Map(), sockets = new Set();
  const origins = new Map(), originIds = new Map();
  let origin, base, lastError = null;
  const allowedHosts = new Set(HOSTS);
  function approveMedia(value) {
    const u = new URL(value);
    // Only media URLs supplied by the fixed AnimeOnsen API (or its manifests) can introduce a host.
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
  // DASH segment templates ($Number$, $Time$) cannot be registered one URL at a time, so an
  // approved media origin gets one opaque route that mirrors its paths.
  function route(value) {
    const u = network.checkedUrl(approveMedia(value), allowedHosts);
    let originId = originIds.get(u.origin);
    if (!originId) {
      if (origins.size >= 64) throw new Error('This playback session is too large. Close and reopen the app.');
      originId = crypto.randomBytes(12).toString('hex');
      origins.set(originId, u.origin); originIds.set(u.origin, originId);
    }
    return base + '/p/' + originId + u.pathname + u.search;
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
      const format = streamFormat(stream);
      // Video-on-demand media and image resources have opaque, session-bound URLs.
      data = { url: format === 'dash' ? route(stream) : register(stream), format,
        subtitles: result.subtitles.map(track => ({ lang: track.lang, label: track.label,
          url: register(approveMedia(track.url), 'subtitle') })) };
    } else if (op === 'image') {
      data = { url: register(`${API}/image/210x300/${encodeURIComponent(id(p.get('id')))}`, 'image') };
    } else if (op === 'skip') {
      // Optional lookup: a missing or failed AniSkip answer never becomes the source's error.
      try {
        data = { intervals: await skipTimes(p.get('mal'), Number(p.get('episode')), Number(p.get('length') || 0)) };
      } catch (error) { data = { intervals: [], unavailable: error.message || 'AniSkip could not be reached.' }; }
    } else if (op === 'status') {
      data = { source: 'AnimeOnsen', version: VERSION, lastError, loopbackOnly: true, clearance: clearance ? clearance.status() : null };
    }
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
    const fetchUpstream = () => open(resource.url, { allowedHosts, signal: controller.signal,
      headers: { ...headers, ...(clearance ? clearance.headersFor(resource.url) : {}) },
      method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
    const challenged = response => response.statusCode === 403 && response.headers['cf-mitigated'] === 'challenge';
    let upstream = await fetchUpstream();
    if (challenged(upstream) && clearance && await clearance.refresh().catch(() => false)) { upstream.resume(); upstream = await fetchUpstream(); }
    if (![200, 206, 304].includes(upstream.statusCode)) {
      upstream.resume();
      const challenge = challenged(upstream);
      const error = new Error(challenge ? 'AnimeOnsen asks this connection to pass a browser check. Choose Verify with AnimeOnsen to do it once on the TV.' : `Media request failed (HTTP ${upstream.statusCode}).`);
      error.status = upstream.statusCode; if (challenge) error.code = 'SOURCE_CHALLENGE'; throw error;
    }
    const mime = String(upstream.headers['content-type'] || 'application/octet-stream');
    const isHls = /mpegurl/i.test(mime) || /\.m3u8(?:\?|$)/i.test(resource.url);
    const isDash = /dash\+xml/i.test(mime) || /\.mpd(?:\?|$)/i.test(resource.url);
    const finalUrl = upstream.finalUrl || resource.url;
    if (isDash && resource.routed && finalUrl !== resource.url) {
      // The player resolves relative segments against the manifest's URL, so send it to the
      // route for the redirected location instead of serving the body under the old path.
      upstream.resume();
      res.writeHead(307, { Location: route(finalUrl), 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.method !== 'HEAD' && (resource.kind === 'subtitle' || isHls || isDash)) {
      const bytes = await network.collect(upstream, 8 * 1024 * 1024);
      const text = bytes.toString('utf8');
      let body, type;
      if (resource.kind === 'subtitle') { body = toVtt(text); type = 'text/vtt; charset=utf-8'; }
      else if (isDash) { body = rewriteDash(text, finalUrl, route); type = 'application/dash+xml'; }
      else { body = rewriteHls(text, finalUrl, url => register(approveMedia(url))); type = 'application/vnd.apple.mpegurl'; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body); return;
    }
    const outgoing = { 'Content-Type': mime, 'Cache-Control': resource.kind === 'image' ? 'private, max-age=600' : 'no-store' };
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'content-encoding']) {
      if (upstream.headers[h]) outgoing[h] = upstream.headers[h];
    }
    // A paused player stops reading; the connection may idle until playback resumes.
    // The upstream request still ends when the TV closes its side.
    upstream.socket?.setTimeout(0);
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
    const prefix = '/' + token + '/';
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range' });
      res.end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    try {
      if (url.pathname.startsWith(prefix + 'api/')) await handleApi(url, res);
      else if (url.pathname.startsWith(prefix + 'resource/')) {
        const resource = resources.get(url.pathname.split('/').pop().split('.')[0]);
        if (!resource) { res.writeHead(404); res.end(); return; }
        await handleResource(resource, req, res);
      } else if (url.pathname.startsWith(prefix + 'p/')) {
        const rest = url.pathname.slice(prefix.length + 2), slash = rest.indexOf('/');
        const upstreamOrigin = slash > 0 && origins.get(rest.slice(0, slash));
        if (!upstreamOrigin) { res.writeHead(404); res.end(); return; }
        const target = network.checkedUrl(upstreamOrigin + rest.slice(slash) + url.search, allowedHosts);
        if (target.origin !== upstreamOrigin) { res.writeHead(404); res.end(); return; }
        await handleResource({ url: target.href, kind: 'media', routed: true }, req, res);
      } else { res.writeHead(404); res.end(); }
    } catch (error) {
      // Seeking and page changes cancel requests all the time; those are not source failures.
      if (error.code !== 'ABORTED' && !res.destroyed) lastError = { message: sourceError(error), at: new Date().toISOString() };
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 502, { error: sourceError(error), ...(error.code === 'SOURCE_CHALLENGE' ? { code: 'SOURCE_CHALLENGE' } : {}) });
      }
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
  return { origin, base, server, register, route, approveMedia,
    close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
module.exports = { startBackend, rewriteHls, rewriteDash, sourceError, streamFormat };
