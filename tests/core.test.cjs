'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { Onsen, id } = require('../service/onsen');
const { checkedUrl, publicAddress } = require('../service/network');
const { rewriteHls } = require('../service/backend');
const { toVtt } = require('../service/subtitles');
const { convert, fields } = require('../tools/import-aniyomi.cjs');

test('outbound requests reject local addresses, literal IPs, credentials, and unapproved hosts', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '172.16.3.4', '192.168.0.1', '100.64.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('1.1.1.1'), true);
  const hosts = new Set(['api.animeonsen.xyz', '127.0.0.1']);
  for (const url of ['http://api.animeonsen.xyz/a', 'https://api.animeonsen.xyz.evil.test/a', 'https://a:b@api.animeonsen.xyz/a', 'https://api.animeonsen.xyz:444/a', 'https://127.0.0.1/a']) assert.throws(() => checkedUrl(url, hosts));
  assert.equal(checkedUrl('https://api.animeonsen.xyz/a', hosts).hostname, 'api.animeonsen.xyz');
  for (const value of ['../x', '__proto__', 'constructor', 'x?z', 'a/b']) assert.throws(() => id(value));
});

test('token requests are deduplicated and a 401 refreshes only the API token', async () => {
  let auth = 0, calls = 0;
  const source = new Onsen(async (url, opts) => {
    if (url.includes('/oauth/token')) { auth++; await new Promise(r => setTimeout(r, 5)); return JSON.stringify({ access_token: 'token-' + auth, expires_in: 3600 }); }
    assert.equal(new URL(url).hostname, 'api.animeonsen.xyz');
    calls++;
    if (calls === 1) { const e = new Error('expired'); e.status = 401; throw e; }
    assert.match(opts.headers.Authorization, /^Bearer token-/);
    return JSON.stringify({ content: [{ content_id: 'demo', content_title: 'Romaji', content_title_en: 'English' }], cursor: { next: [true, 30] } });
  });
  await Promise.all([source.accessToken(), source.accessToken()]); assert.equal(auth, 1);
  const page = await source.catalog(0, 'english'); assert.equal(auth, 2); assert.equal(page.next, true); assert.equal(page.items[0].title, 'English');
  await assert.rejects(source.catalog(-1));
});

test('search reads its own token and refreshes after authorization failure', async () => {
  let pageLoads = 0, searches = 0;
  const source = new Onsen(async (url, opts) => {
    if (url === 'https://www.animeonsen.xyz/') { pageLoads++; return `<html><meta content="search-${pageLoads}" name="ao-search-token"></html>`; }
    assert.equal(url, 'https://search.animeonsen.xyz/indexes/content/search'); assert.equal(JSON.parse(opts.body).q, 'rain');
    searches++;
    if (searches === 1) { const e = new Error('expired'); e.status = 401; throw e; }
    assert.equal(opts.headers.Authorization, 'Bearer search-2');
    return JSON.stringify({ hits: [{ content_id: 'rain', content_title: 'Rain' }] });
  });
  assert.equal((await source.search(' rain ')).items[0].id, 'rain'); assert.equal(pageLoads, 2);
});

test('episode numbers sort numerically, and subtitle labels survive resolution', async () => {
  const source = new Onsen(); source.api = async path => path.endsWith('/episodes') ? {
    '10': { contentTitle_episode_en: 'Ten' }, '2': { contentTitle_episode_en: 'Two' }, '1.5': { contentTitle_episode_jp: 'Special' },
  } : { uri: { stream: 'https://cdn.example/video.m3u8', subtitles: { 'en-US': 'https://cdn.example/sub.vtt' } }, metadata: { subtitles: { 'en-US': 'English' } } };
  assert.deepEqual((await source.episodes('demo')).map(x => x.id), ['1.5', '2', '10']);
  assert.equal((await source.stream('demo', '2')).subtitles[0].label, 'English');
});

test('HLS rewrite covers segment lines, keys, and relative variant URLs', () => {
  const found = [];
  const output = rewriteHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key?k=1"\n#EXT-X-MAP:URI="init.mp4"\nsegment.ts?signature=abc\n',
    'https://media.animeonsen.xyz/path/master.m3u8', url => { found.push(url); return 'local/' + found.length; });
  assert.deepEqual(found, ['https://media.animeonsen.xyz/key?k=1', 'https://media.animeonsen.xyz/path/init.mp4', 'https://media.animeonsen.xyz/path/segment.ts?signature=abc']);
  assert.match(output, /URI="local\/1"/); assert.match(output, /local\/3/);
  assert.throws(() => rewriteHls('<html>Error</html>', '', () => ''));
});

test('SRT and ASS subtitles are converted without executing markup', () => {
  const srt = toVtt('1\n00:01:02,345 --> 00:01:04,500\n<b>Hello</b> & goodbye.\n');
  assert.match(srt, /00:01:02\.345 --> 00:01:04\.500/); assert.match(srt, /Hello &amp; goodbye/);
  const ass = toVtt('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.40,Default,,0,0,0,,{\\i1}Hello, world!\\NSecond line\n');
  assert.match(ass, /00:00:01\.200 --> 00:00:03\.400/); assert.match(ass, /Hello, world!\nSecond line/);
  assert.throws(() => toVtt('<html>not subtitles</html>'));
});

function vint(value) { let n = BigInt(value), out = []; do { let v = Number(n & 127n); n >>= 7n; if (n) v |= 128; out.push(v); } while (n); return Buffer.from(out); }
function field(number, value) { const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : null; return bytes ? Buffer.concat([vint(number * 8 + 2), vint(bytes.length), bytes]) : Buffer.concat([vint(number * 8), vint(value)]); }
function backupFixture(modern) {
  const ep = Buffer.concat([field(1, 'demo/video/2'), field(2, 'Episode two'), field(6, 123000), field(16, 1440000)]);
  const h = Buffer.concat([field(1, 'demo/video/2'), field(2, 1700000000000)]);
  const anime = Buffer.concat([field(1, 8542735178285060053n), field(2, 'demo'), field(3, 'Imported title'), field(16, ep), field(104, h)]);
  const other = Buffer.concat([field(1, 5), field(2, 'other'), field(3, 'Different source')]);
  return Buffer.concat([field(modern ? 501 : 3, anime), field(modern ? 501 : 3, other)]);
}
test('Aniyomi import handles both schemas and gzip, preserves 64-bit source IDs, and converts milliseconds', () => {
  for (const modern of [false, true]) {
    const result = convert(zlib.gzipSync(backupFixture(modern)));
    assert.equal(result.stats.importedTitles, 1); assert.equal(result.stats.skippedSources, 1);
    assert.equal(result.output.library.demo.category, 'Watching');
    assert.equal(result.output.progress['demo/2'].position, 123);
    assert.equal(result.output.progress['demo/2'].duration, 1440);
    assert.equal(result.output.progress['demo/2'].updatedAt, 1700000000000);
  }
});
test('episode lastModifiedAt (seconds) becomes milliseconds when no history entry exists', () => {
  const ep = Buffer.concat([field(1, 'demo/video/3'), field(2, 'Episode three'), field(4, 1), field(11, 1700000000)]);
  const anime = Buffer.concat([field(1, 8542735178285060053n), field(2, 'demo'), field(3, 'Imported title'), field(16, ep)]);
  const result = convert(Buffer.concat([field(501, anime)]));
  assert.equal(result.output.progress['demo/3'].updatedAt, 1700000000000);
  assert.equal(result.output.library.demo.category, 'Completed');
});
test('backup reader rejects truncation and runaway lengths', () => {
  assert.throws(() => fields(Buffer.from([10, 255, 255])));
  assert.throws(() => fields(Buffer.from([0])));
  assert.throws(() => fields(Buffer.from([10, 100, 1])));
});
module.exports = { backupFixture };
