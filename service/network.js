'use strict';
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

// No arbitrary hosts, local addresses, credentials, non-TLS URLs, or custom ports.
function publicAddress(address) {
  if (net.isIP(address) !== 4) return false; // IPv4 also avoids mapped-IPv6 ambiguities.
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)));
}
function checkedUrl(value, allowedHosts) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      net.isIP(u.hostname) || !allowedHosts.has(u.hostname.toLowerCase())) {
    throw new Error('The source returned an unsupported media host or address.');
  }
  return u;
}
function lookup(hostname, options, done) {
  dns.lookup(hostname, { family: 4 }, (error, address, family) => {
    if (error) return done(error);
    if (!publicAddress(address)) return done(new Error('Private network addresses are not allowed.'));
    if (options && options.all) done(null, [{ address, family }]);
    else done(null, address, family);
  });
}
function open(value, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = checkedUrl(value, options.allowedHosts); } catch (e) { reject(e); return; }
    const request = https.request(url, {
      method: options.method || 'GET', lookup,
      headers: { 'Accept-Encoding': 'identity', ...options.headers },
      timeout: options.timeout || 20000,
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 4 || !response.headers.location) return reject(new Error('Too many source redirects.'));
        const next = new URL(response.headers.location, url);
        // Never forward a bearer token across origins.
        const headers = { ...options.headers };
        if (next.origin !== url.origin) { delete headers.Authorization; delete headers.Cookie; }
        const changesMethod = response.statusCode === 303 ||
          ([301, 302].includes(response.statusCode) && options.method === 'POST');
        if (changesMethod) { delete headers['Content-Length']; delete headers['Content-Type']; }
        return open(next.href, { ...options, headers,
          method: changesMethod ? 'GET' : options.method,
          body: changesMethod ? undefined : options.body }, redirects + 1).then(resolve, reject);
      }
      response.finalUrl = url.href;
      resolve(response);
    });
    request.on('timeout', () => request.destroy(new Error(`${options.serviceName || 'AnimeOnsen'} took too long to respond.`)));
    request.on('error', reject);
    if (options.signal) {
      const abort = () => {
        const error = new Error('Request cancelled.'); error.code = 'ABORTED'; request.destroy(error);
      };
      if (options.signal.aborted) abort();
      else {
        options.signal.addEventListener('abort', abort, { once: true });
        request.on('close', () => options.signal.removeEventListener('abort', abort));
      }
    }
    request.end(options.body);
  });
}
async function collect(response, max = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > max) { response.destroy(); throw new Error('Source response is larger than expected.'); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const encoding = response.headers['content-encoding'];
  if (!encoding || encoding === 'identity') return bytes;
  const fn = encoding === 'gzip' ? zlib.gunzip : encoding === 'br' ? zlib.brotliDecompress :
    encoding === 'deflate' ? zlib.inflate : null;
  if (!fn) throw new Error('Unsupported response encoding.');
  return new Promise((resolve, reject) => fn(bytes, { maxOutputLength: max }, (e, b) => e ? reject(e) : resolve(b)));
}
async function request(value, options = {}) {
  const response = await open(value, options);
  const body = await collect(response);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const challenge = response.headers['cf-mitigated'] === 'challenge';
    const name = options.serviceName || 'AnimeOnsen';
    const error = new Error(challenge ? `${name} asks this connection to pass a browser check. Choose Verify with AnimeOnsen to do it once on the TV.` : `${name} returned HTTP ${response.statusCode}.`);
    error.status = response.statusCode;
    if (challenge) error.code = 'SOURCE_CHALLENGE';
    throw error;
  }
  return body.toString('utf8');
}
module.exports = { publicAddress, checkedUrl, open, collect, request };
