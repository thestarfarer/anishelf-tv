'use strict';
// A minimal Chrome DevTools Protocol client for the TV's own app inspector on 127.0.0.1
// (webOS serves it on port 9998 for developer-installed apps). RFC 6455 text frames only;
// Node 16, the webOS 25 service runtime, has no WebSocket client.
const http = require('http');
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

function inspectorError(port, error) {
  if (error && error.code === 'ECONNREFUSED') {
    const missing = new Error(`The TV's developer inspector (127.0.0.1:${port}) is not running, so AniShelf cannot read the verification.`);
    missing.code = 'NO_INSPECTOR'; return missing;
  }
  return error;
}
function getJson(port, path, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error('The inspector sent too much data.')); else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error(`The inspector answered HTTP ${response.statusCode}.`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new Error('The inspector returned unexpected data.')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('The TV inspector did not answer.')));
    request.on('error', error => reject(inspectorError(port, error)));
  });
}
const list = port => getJson(port, '/json/list');

class Session {
  constructor(socket, head) {
    this.socket = socket; this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.nextId = 1; this.pending = new Map(); this.fragments = [];
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.read(); });
    socket.on('close', () => this.fail(new Error('The inspector connection closed.')));
    socket.on('error', () => {});
    if (this.buffer.length) this.read();
  }
  read() {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f, offset = 2;
      if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) { this.socket.destroy(); return; }
        length = Number(big); offset = 10;
      }
      const maskAt = offset; if (masked) offset += 4;
      if (b.length < offset + length) return;
      let payload = b.subarray(offset, offset + length);
      if (masked) { const mask = b.subarray(maskAt, maskAt + 4); payload = Buffer.from(payload.map((x, i) => x ^ mask[i % 4])); }
      this.buffer = b.subarray(offset + length);
      if (opcode === 0x8) { this.socket.end(); return; }
      if (opcode === 0x9) { this.frame(0xa, payload); continue; }
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      this.fragments.push(payload);
      if (this.fragments.reduce((sum, part) => sum + part.length, 0) > MAX_MESSAGE) { this.socket.destroy(); return; }
      if (fin) { const text = Buffer.concat(this.fragments).toString('utf8'); this.fragments = []; this.message(text); }
    }
  }
  message(text) {
    let message;
    try { message = JSON.parse(text); } catch (_) { return; }
    const waiting = this.pending.get(message.id);
    if (!waiting) return; // Events are not used.
    this.pending.delete(message.id); clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error('Inspector: ' + (message.error.message || 'command failed')));
    else waiting.resolve(message.result || {});
  }
  frame(opcode, payload) {
    const length = payload.length, mask = crypto.randomBytes(4);
    let header;
    if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
    else if (length < 65536) { header = Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]); header.writeUInt16BE(length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); }
    const body = Buffer.alloc(length);
    for (let i = 0; i < length; i++) body[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  send(method, params = {}, timeout = 5000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The inspector did not answer ${method}.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.frame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    });
  }
  fail(error) {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
  }
  close() {
    try { this.frame(0x8, Buffer.alloc(0)); } catch (_) {}
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
}
// Only the path of the inspector's WebSocket URL is used; the connection always stays on loopback.
function connect(port, webSocketUrl, timeout = 5000) {
  let path;
  try { path = new URL(webSocketUrl).pathname; } catch (_) { path = ''; }
  if (!/^\/devtools\/(?:page|browser)\/[\w.-]+$/.test(path)) return Promise.reject(new Error('The inspector listed an unexpected target.'));
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const request = http.request({ host: '127.0.0.1', port, path, timeout, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    request.on('upgrade', (response, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (response.headers['sec-websocket-accept'] !== expected) { socket.destroy(); reject(new Error('The inspector handshake failed.')); return; }
      socket.setTimeout(0);
      resolve(new Session(socket, head));
    });
    request.on('response', response => { response.resume(); reject(new Error(`The inspector refused the connection (HTTP ${response.statusCode}).`)); });
    request.on('timeout', () => request.destroy(new Error('The TV inspector did not answer.')));
    request.on('error', error => reject(inspectorError(port, error)));
    request.end();
  });
}
async function command(port, target, method, params) {
  const session = await connect(port, target.webSocketDebuggerUrl);
  try { return await session.send(method, params); } finally { session.close(); }
}
module.exports = { list, connect, command, getJson };
