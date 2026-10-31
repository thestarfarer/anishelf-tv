'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startBackend } = require('../service/backend');
const { fixtureSource, fixtureOpen } = require('./fixtures.cjs');
function request(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const parts = []; res.on('data', chunk => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }); req.on('error', reject); req.end();
  });
}
test('source server binds only loopback and refuses missing token, hostile Origin, Host, and write methods', async t => {
  const app = await startBackend({ source: fixtureSource(), open: fixtureOpen }); t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal((await request(app.origin + '/api/catalog')).status, 404);
  assert.equal((await request(app.base + '/api/catalog', { Origin: 'https://hostile.example' })).status, 403);
  assert.equal((await request(app.base + '/api/catalog', { Host: 'hostile.example' })).status, 403);
  assert.equal((await request(app.base + '/api/catalog', {}, 'POST')).status, 405);
  const response = await request(app.base + '/api/catalog', { Origin: 'null' });
  assert.equal(response.status, 200); assert.equal(response.headers['access-control-allow-origin'], 'null');
  assert.equal(JSON.parse(response.body).items.length, 6);
});
test('media URLs are opaque; stream ranges and external subtitles work through the local transport', async t => {
  const app = await startBackend({ source: fixtureSource(), open: fixtureOpen }); t.after(() => app.close());
  const stream = JSON.parse((await request(app.base + '/api/stream?id=test-1&episode=1')).body);
  assert.match(stream.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/resource\/[a-f0-9]+\.mp4$/);
  const range = await request(stream.url, { Range: 'bytes=0-31' });
  assert.equal(range.status, 206); assert.equal(range.body.length, 32); assert.match(range.headers['content-range'], /^bytes 0-31\//);
  const sub = await request(stream.subtitles[0].url); assert.equal(sub.status, 200);
  assert.match(sub.body.toString(), /^WEBVTT/); assert.match(sub.body.toString(), /Subtitle playback test/);
  assert.equal((await request(app.base + '/resource/not-registered')).status, 404);
  assert.throws(() => app.approveMedia('https://127.0.0.1/private'));
  assert.throws(() => app.register('https://unapproved.example/file'));
});
test('source failures become useful errors without exposing stack traces or credentials', async t => {
  const source = fixtureSource(); source.catalog = async () => { const e = new Error('secret implementation detail'); e.status = 403; throw e; };
  const app = await startBackend({ source, open: fixtureOpen }); t.after(() => app.close());
  const response = await request(app.base + '/api/catalog'); assert.equal(response.status, 502);
  const message = JSON.parse(response.body).error;
  assert.match(message, /HTTP 403/); assert.doesNotMatch(message, /secret|Bearer|\.js:/);
  const status = JSON.parse((await request(app.base + '/api/status')).body);
  assert.equal(status.lastError.message, message);
});
