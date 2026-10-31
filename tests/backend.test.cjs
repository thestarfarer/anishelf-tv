'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Readable } = require('stream');
const { startBackend, rewriteDash } = require('../service/backend');
const { createSkipTimes, parse } = require('../service/aniskip');
const { fixtureSource, fixtureOpen, fixtureSkipTimes, DASH } = require('./fixtures.cjs');
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
  const stream = JSON.parse((await request(app.base + '/api/stream?id=test-1&episode=2')).body);
  assert.equal(stream.format, 'video');
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

test('DASH streams play through an opaque origin route that keeps relative segment templates working', async t => {
  const app = await startBackend({ source: fixtureSource(), open: fixtureOpen }); t.after(() => app.close());
  const stream = JSON.parse((await request(app.base + '/api/stream?id=test-1&episode=1')).body);
  assert.equal(stream.format, 'dash');
  assert.match(stream.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/p\/[a-f0-9]{24}\/video\/mp4-dash\/test-1\/1\/manifest\.mpd$/);
  const manifest = await request(stream.url);
  assert.equal(manifest.status, 200); assert.match(manifest.headers['content-type'], /dash\+xml/);
  assert.match(manifest.body.toString(), /media="chunk-\$RepresentationID\$-\$Number%05d\$\.m4s"/);
  const init = await request(new URL('init-0.m4s', stream.url).href);
  assert.equal(init.status, 200); assert.ok(init.body.length > 100);
  const segment = await request(new URL('chunk-2-00003.m4s', stream.url).href);
  assert.equal(segment.status, 200);
  assert.equal((await request(stream.url.replace(/\/p\/[a-f0-9]+\//, '/p/000000000000000000000000/'))).status, 404);
  assert.equal((await request(app.base + '/p/')).status, 404);
  assert.throws(() => app.route('https://127.0.0.1/manifest.mpd'));
});

test('DASH manifests have absolute and host-relative URLs rerouted, and Location removed', () => {
  const routed = [];
  const out = rewriteDash(`<?xml version="1.0"?><MPD type="static"><Location>https://cdn.example/live.mpd</Location>
<BaseURL>https://media.example/base/</BaseURL><Period><AdaptationSet><Representation id="a">
<SegmentTemplate initialization="/v/init.mp4?t=1&amp;u=2" media="https://cdn.example/v/$Number%05d$.m4s" index="rel/$Number$.sidx"/>
<BaseURL>relative/</BaseURL></Representation></AdaptationSet></Period></MPD>`, 'https://cdn.example/path/manifest.mpd',
  url => { routed.push(url); return 'http://127.0.0.1:1/t/p/x' + new URL(url).pathname + new URL(url).search; });
  // Host-relative paths resolve against the MPD-level BaseURL's host, not the manifest's.
  assert.deepEqual(routed, ['https://media.example/base/', 'https://media.example/v/init.mp4?t=1&u=2', 'https://cdn.example/v/$Number%05d$.m4s']);
  assert.doesNotMatch(out, /<Location>/);
  assert.match(out, /initialization="http:\/\/127\.0\.0\.1:1\/t\/p\/x\/v\/init\.mp4\?t=1&amp;u=2"/);
  assert.match(out, /index="rel\/\$Number\$\.sidx"/); assert.match(out, /<BaseURL>relative\/<\/BaseURL>/);
  assert.throws(() => rewriteDash('<html>blocked</html>', 'https://cdn.example/a.mpd', x => x));
});

test('a redirected DASH manifest sends the player to the redirected route so segments resolve there', async t => {
  const open = async (url, options) => {
    if (url.endsWith('/manifest.mpd')) {
      const body = Readable.from([Buffer.from('<MPD><Period/></MPD>')]);
      body.statusCode = 200; body.headers = { 'content-type': 'application/dash+xml' };
      body.finalUrl = 'https://edge.animeonsen.xyz/cache/manifest.mpd?sig=1'; return body;
    }
    return fixtureOpen(url, options);
  };
  const app = await startBackend({ source: fixtureSource(), open }); t.after(() => app.close());
  app.approveMedia('https://edge.animeonsen.xyz/');
  const stream = JSON.parse((await request(app.base + '/api/stream?id=test-1&episode=1')).body);
  const response = await request(stream.url);
  assert.equal(response.status, 307);
  assert.match(response.headers.location, /\/p\/[a-f0-9]{24}\/cache\/manifest\.mpd\?sig=1$/);
});

test('AniSkip intervals are served, and a failed lookup never becomes the source error', async t => {
  let fail = false;
  const app = await startBackend({ source: fixtureSource(), open: fixtureOpen,
    skipTimes: async (...args) => { if (fail) throw new Error('AniSkip returned HTTP 500.'); return fixtureSkipTimes(...args); } });
  t.after(() => app.close());
  const ok = JSON.parse((await request(app.base + '/api/skip?mal=1000&episode=1&length=30')).body);
  assert.deepEqual(ok.intervals, [{ type: 'op', start: 3, end: 9 }]);
  fail = true;
  const failed = JSON.parse((await request(app.base + '/api/skip?mal=1000&episode=1')).body);
  assert.deepEqual(failed.intervals, []); assert.match(failed.unavailable, /500/);
  assert.equal(JSON.parse((await request(app.base + '/api/status')).body).lastError, null);
});

test('cancelled media requests are not reported as the latest source error', async t => {
  const open = async () => { const e = new Error('Request cancelled.'); e.code = 'ABORTED'; throw e; };
  const app = await startBackend({ source: fixtureSource(), open }); t.after(() => app.close());
  const stream = JSON.parse((await request(app.base + '/api/stream?id=test-1&episode=2')).body);
  assert.equal((await request(stream.url)).status, 502);
  assert.equal(JSON.parse((await request(app.base + '/api/status')).body).lastError, null);
});

test('AniSkip responses are parsed, filtered, cached, and a 404 means no times', async () => {
  const sample = JSON.stringify({ found: true, results: [
    { interval: { startTime: 1357.9, endTime: 1480 }, skipType: 'ed' },
    { interval: { startTime: 57.4, endTime: 145.7 }, skipType: 'op' },
    { interval: { startTime: 10, endTime: 10.5 }, skipType: 'op' },
    { interval: { startTime: 5, endTime: 50 }, skipType: 'unknown' }] });
  assert.deepEqual(parse(sample).map(x => x.type), ['op', 'ed']);
  let calls = 0, seen;
  const skip = createSkipTimes(async (url, options) => { calls++; seen = { url, options }; return sample; });
  await skip(1, 1, 1491.5); await skip(1, 1, 1491.5); assert.equal(calls, 1);
  assert.match(seen.url, /^https:\/\/api\.aniskip\.com\/v2\/skip-times\/1\/1\?types\[\]=op&.*episodeLength=1492$/);
  assert.deepEqual([...seen.options.allowedHosts], ['api.aniskip.com']);
  const none = createSkipTimes(async () => { const e = new Error('404'); e.status = 404; throw e; });
  assert.deepEqual(await none(5, 2, 0), []);
  await assert.rejects(skip('1; rm', 1, 0)); await assert.rejects(skip(1, -1, 0));
});

test('DASH rewriting handles single-quoted attributes and host-relative paths under a CDN-changing BaseURL', () => {
  const routed = [];
  const route = url => { routed.push(url); const u = new URL(url); return 'http://127.0.0.1:1/t/p/' + u.hostname + u.pathname + u.search; };
  const out = rewriteDash(`<MPD xmlns='urn:mpeg:dash:schema:mpd:2011'><BaseURL>https://cdn2.example/content/</BaseURL>
<Period><AdaptationSet bitstreamSwitching='true'><Representation id='v'>
<SegmentTemplate media='/seg/$Number$.m4s' initialization='https://cdn3.example/init.mp4'/></Representation></AdaptationSet></Period></MPD>`,
  'https://cdn.example/path/manifest.mpd', route);
  assert.deepEqual(routed, ['https://cdn2.example/content/', 'https://cdn2.example/seg/$Number$.m4s', 'https://cdn3.example/init.mp4']);
  assert.match(out, /media='http:\/\/127\.0\.0\.1:1\/t\/p\/cdn2\.example\/seg\/\$Number\$\.m4s'/);
  assert.match(out, /initialization='http:\/\/127\.0\.0\.1:1\/t\/p\/cdn3\.example\/init\.mp4'/);
  assert.match(out, /bitstreamSwitching='true'/);
});

test('DASH rewriting follows XML rules: comments, CDATA, entities, other schemes, and nested bases', () => {
  const routed = [];
  const route = url => { routed.push(url); const u = new URL(url); return 'http://127.0.0.1:1/t/p/' + u.hostname + u.pathname + u.search; };
  const manifest = `<?xml version="1.0"?>
<!-- <SegmentTemplate media="https://commented.example/x.m4s"/> -->
<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011" xmlns:xl="http://www.w3.org/1999/xlink">
  <mpd:PatchLocation>https://cdn.example/patch</mpd:PatchLocation>
  <mpd:BaseURL><![CDATA[https://edge.example/a/b/]]></mpd:BaseURL>
  <mpd:Period xl:href="urn:mpeg:dash:resolve-to-zero:2013"/>
  <mpd:Period>
    <mpd:AdaptationSet>
      <mpd:BaseURL>video/</mpd:BaseURL>
      <mpd:Representation id="1">
        <mpd:SegmentBase><mpd:Initialization sourceURL="data:video/mp4;base64,AAAA"/></mpd:SegmentBase>
        <mpd:SegmentTemplate media="/abs/$Number$.m4s?a=1&amp;b=&quot;2&quot;" initialization="../../../../up/init.mp4" index="seg.sidx"/>
      </mpd:Representation>
    </mpd:AdaptationSet>
  </mpd:Period>
</mpd:MPD>`;
  const out = rewriteDash(manifest, 'https://cdn.example/m/manifest.mpd', route);
  assert.deepEqual(routed, ['https://edge.example/a/b/', 'https://edge.example/abs/$Number$.m4s?a=1&b=%222%22', 'https://edge.example/up/init.mp4']);
  assert.match(out, /<!-- <SegmentTemplate media="https:\/\/commented\.example\/x\.m4s"\/> -->/);
  assert.doesNotMatch(out, /PatchLocation/);
  assert.match(out, /<mpd:BaseURL>http:\/\/127\.0\.0\.1:1\/t\/p\/edge\.example\/a\/b\/<\/mpd:BaseURL>/);
  assert.match(out, /<mpd:BaseURL>video\/<\/mpd:BaseURL>/);
  assert.match(out, /xl:href="urn:mpeg:dash:resolve-to-zero:2013"/);
  assert.match(out, /sourceURL="data:video\/mp4;base64,AAAA"/);
  assert.match(out, /media="http:\/\/127\.0\.0\.1:1\/t\/p\/edge\.example\/abs\/\$Number\$\.m4s\?a=1&amp;b=%222%22"/);
  assert.match(out, /index="seg\.sidx"/);
  for (const broken of ['<MPD><Period></MPD>', '<MPD><Period media=x/></MPD>', '<MPD></MPD><MPD></MPD>', '<html></html>', '<MPD><BaseURL>a<b/></BaseURL></MPD>']) {
    assert.throws(() => rewriteDash(broken, 'https://cdn.example/a.mpd', route), /Invalid DASH manifest/, broken);
  }
});

test('a manifest using a CDN-changing BaseURL and single-quoted host-relative templates plays its segments through the route', async t => {
  const seen = [];
  const open = async (url, options) => { seen.push(new URL(url).hostname); return fixtureOpen(url, options); };
  const app = await startBackend({ source: fixtureSource(), open }); t.after(() => app.close());
  const stream = JSON.parse((await request(app.base + '/api/stream?id=test-1&episode=3')).body);
  const manifest = (await request(stream.url)).body.toString();
  const media = manifest.match(/media='([^']+)'/)[1].replace('$RepresentationID$', '0').replace('$Number%05d$', '00002');
  assert.match(media, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/p\/[a-f0-9]{24}\//);
  assert.equal((await request(media)).status, 200);
  assert.equal(seen[seen.length - 1], 'cdn2.animeonsen.xyz');
});
