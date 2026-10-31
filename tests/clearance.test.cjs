'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const cdp = require('../service/cdp');
const { Clearance, withClearance, domainMatches } = require('../service/clearance');
const { startBackend } = require('../service/backend');
const { fixtureSource, fixtureOpen } = require('./fixtures.cjs');

// A small WebSocket server standing in for the TV inspector (server frames are unmasked).
function serverFrame(opcode, payload, fin = true) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, length]);
  else if (length < 65536) { header = Buffer.from([(fin ? 0x80 : 0) | opcode, 126, 0, 0]); header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, payload]);
}
function readClientFrames(buffer, onFrame) {
  for (;;) {
    if (buffer.length < 2) return buffer;
    let length = buffer[1] & 0x7f, offset = 2;
    if (length === 126) { if (buffer.length < 4) return buffer; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) return buffer; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    assert.ok(buffer[1] & 0x80, 'client frames are masked');
    if (buffer.length < offset + 4 + length) return buffer;
    const mask = buffer.subarray(offset, offset + 4), body = buffer.subarray(offset + 4, offset + 4 + length);
    onFrame(buffer[0] & 0x0f, Buffer.from(body.map((x, i) => x ^ mask[i % 4])));
    buffer = buffer.subarray(offset + 4 + length);
  }
}
async function inspector(handle) {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') { res.end(JSON.stringify([{ id: 'A', type: 'page', url: 'file:///x/com.homebrew.anishelf/index.html',
      webSocketDebuggerUrl: 'ws://10.0.0.5:9998/devtools/page/A' }])); return; }
    res.writeHead(404); res.end();
  });
  const seen = { pongs: 0, messages: [] };
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(serverFrame(0x9, Buffer.from('hi')));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = readClientFrames(Buffer.concat([buffer, chunk]), (opcode, payload) => {
        if (opcode === 0xa) { seen.pongs++; return; }
        if (opcode === 0x8) { socket.end(); return; }
        const message = JSON.parse(payload.toString()); seen.messages.push(message);
        for (const frame of handle(message)) socket.write(frame);
      });
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the DevTools client lists targets, stays on loopback, and handles large, fragmented and error replies', async () => {
  const big = 'x'.repeat(70000);
  const server = await inspector(message => {
    if (message.method === 'Echo') {
      const text = Buffer.from(JSON.stringify({ id: message.id, result: { echo: message.params.text } }));
      return [serverFrame(0x1, text.subarray(0, 10), false), serverFrame(0x0, text.subarray(10, 20000), false), serverFrame(0x0, text.subarray(20000))];
    }
    return [serverFrame(0x1, Buffer.from(JSON.stringify({ id: message.id, error: { message: 'nope' } })))];
  });
  try {
  const [target] = await cdp.list(server.port);
  // The inspector names 10.0.0.5; the client must still connect to 127.0.0.1.
  const session = await cdp.connect(server.port, target.webSocketDebuggerUrl);
  assert.equal((await session.send('Echo', { text: big })).echo, big);
  await assert.rejects(session.send('Other'), /Inspector: nope/);
  session.close();
  assert.equal(server.seen.pongs, 1);
  await assert.rejects(cdp.connect(server.port, 'ws://127.0.0.1/evil'), /unexpected target/);
  const unused = http.createServer(); await new Promise(r => unused.listen(0, '127.0.0.1', r));
  const closedPort = unused.address().port; await new Promise(r => unused.close(r));
  await assert.rejects(cdp.list(closedPort), error => error.code === 'NO_INSPECTOR');
  } finally { await server.close(); }
});

const APP = 'file:///media/developer/apps/usr/palm/applications/com.homebrew.anishelf/index.html';
const UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 WebAppManager';
function fakeInspector(script) {
  // script(step) returns { url, title, cookies } for each poll after navigation.
  const state = { url: APP, title: 'AniShelf TV', cookies: [], navigations: [], step: 0 };
  return { state, list: async () => [{ id: 'P', type: 'page', url: state.url, title: state.title, webSocketDebuggerUrl: 'ws://127.0.0.1:9998/devtools/page/P' }],
    command: async (port, target, method, params) => {
      if (method === 'Page.navigate') { state.navigations.push(params.url); state.url = params.url; state.title = ''; return {}; }
      if (method === 'Network.getCookies') {
        if (!state.url.startsWith('file:')) Object.assign(state, script(state.step++));
        return { cookies: state.cookies };
      }
      throw new Error('unexpected ' + method);
    } };
}
const cookie = (name, value, extra = {}) => ({ name, value, domain: '.animeonsen.xyz', expires: Date.now() / 1000 + 3600, ...extra });

test('verification opens the site, waits for a new clearance cookie, then returns to AniShelf', async () => {
  const fake = fakeInspector(step => step < 2 ? { title: 'Just a moment...', cookies: [] }
    : { title: 'AnimeOnsen', cookies: [cookie('cf_clearance', 'new'), cookie('__cf_bm', 'bm'), cookie('pref', 'host-only', { domain: 'www.animeonsen.xyz' }), cookie('old', 'x', { expires: 1 })] });
  const clearance = new Clearance({ cdp: fake, interval: 5 });
  await assert.rejects(clearance.start({ appUrl: 'https://evil.example/', userAgent: UA }), /return to AniShelf/);
  await assert.rejects(clearance.start({ appUrl: APP }), /user agent/);
  assert.deepEqual(await clearance.start({ appUrl: APP + '#old', userAgent: UA }), { started: true });
  assert.equal(fake.state.navigations[0], 'https://www.animeonsen.xyz/');
  assert.equal(await clearance.running, 'verified');
  assert.equal(fake.state.navigations[1], APP + '#cf=verified');
  assert.deepEqual(clearance.headersFor('https://api.animeonsen.xyz/v4/content/index'), { Cookie: 'cf_clearance=new; __cf_bm=bm', 'User-Agent': UA });
  assert.equal(clearance.headersFor('https://www.animeonsen.xyz/').Cookie, 'cf_clearance=new; __cf_bm=bm; pref=host-only');
  assert.deepEqual(clearance.headersFor('https://api.aniskip.com/v2/'), {});
  assert.equal(clearance.status().active, true); assert.equal(clearance.status().lastOutcome, 'verified');
  assert.ok(domainMatches('cdn.animeonsen.xyz', '.animeonsen.xyz')); assert.ok(!domainMatches('evilanimeonsen.xyz', '.animeonsen.xyz'));
});

test('verification times out back to the app, and stops if the window already returned', async () => {
  let clock = 0;
  const slow = fakeInspector(() => ({ title: 'Just a moment...', cookies: [] }));
  const timed = new Clearance({ cdp: slow, interval: 5, now: () => (clock += 1000) });
  await timed.start({ appUrl: APP, userAgent: UA, timeout: 10000 });
  assert.equal(await timed.running, 'timeout');
  assert.equal(slow.state.navigations.pop(), APP + '#cf=timeout');
  const back = fakeInspector(() => ({ url: APP, title: 'AniShelf TV', cookies: [] }));
  const cancelled = new Clearance({ cdp: back, interval: 5 });
  await cancelled.start({ appUrl: APP, userAgent: UA });
  back.state.url = APP; // The person left the check page.
  assert.equal(await cancelled.running, 'cancelled');
  assert.deepEqual(back.state.navigations, ['https://www.animeonsen.xyz/']);
});

test('after a service restart a challenged request re-reads the browser cookie and retries once', async () => {
  let clock = 100000;
  const fake = fakeInspector(() => ({}));
  fake.state.cookies = [cookie('cf_clearance', 'stored')];
  fake.command = async (port, target, method) => { assert.equal(method, 'Network.getCookies'); return { cookies: fake.state.cookies }; };
  const clearance = new Clearance({ cdp: fake, now: () => clock });
  clearance.adoptUserAgent(UA);
  const calls = [];
  const transport = withClearance(async (url, options) => {
    calls.push(options.headers.Cookie || null);
    if (!options.headers.Cookie) { const error = new Error('challenge'); error.code = 'SOURCE_CHALLENGE'; throw error; }
    return 'ok';
  }, clearance);
  assert.equal(await transport('https://api.animeonsen.xyz/v4/x', { headers: { Accept: 'x' } }), 'ok');
  assert.deepEqual(calls, [null, 'cf_clearance=stored']);
  // A rejected clearance is not retried again within ten seconds.
  const rejecting = withClearance(async () => { const e = new Error('again'); e.code = 'SOURCE_CHALLENGE'; throw e; }, clearance);
  await assert.rejects(rejecting('https://api.animeonsen.xyz/v4/x', {}), /again/);
});

test('challenges reach the app as SOURCE_CHALLENGE, and media requests retry with a refreshed clearance', async () => {
  const source = fixtureSource();
  source.catalog = async () => { const e = new Error('AnimeOnsen asks this connection to pass a browser check.'); e.status = 403; e.code = 'SOURCE_CHALLENGE'; throw e; };
  const sent = [];
  const fakeClearance = { cookie: null, headersFor: () => fakeClearance.cookie ? { Cookie: fakeClearance.cookie } : {},
    refresh: async () => { fakeClearance.cookie = 'cf_clearance=fresh'; return true; }, status: () => ({ active: !!fakeClearance.cookie }) };
  const open = async (url, options) => {
    sent.push(options.headers.Cookie || null);
    if (url.endsWith('.mp4') && !options.headers.Cookie) {
      const blocked = Readable.from([]); blocked.statusCode = 403; blocked.headers = { 'cf-mitigated': 'challenge' }; return blocked;
    }
    return fixtureOpen(url, options);
  };
  const app = await startBackend({ source, open, clearance: fakeClearance });
  try {
  const get = url => new Promise((resolve, reject) => http.get(url, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); }).on('error', reject));
  const catalog = await get(app.base + '/api/catalog');
  assert.equal(catalog.status, 502); assert.equal(JSON.parse(catalog.body).code, 'SOURCE_CHALLENGE');
  const stream = JSON.parse((await get(app.base + '/api/stream?id=test-1&episode=2')).body);
  const media = await get(stream.url);
  assert.equal(media.status, 200); assert.deepEqual(sent.slice(-2), [null, 'cf_clearance=fresh']);
  assert.equal(JSON.parse((await get(app.base + '/api/status')).body).clearance.active, true);
  } finally { await app.close(); }
});
