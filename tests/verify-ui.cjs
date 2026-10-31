'use strict';
// End-to-end check of the in-app AnimeOnsen verification in a real Chromium, using its real
// DevTools endpoint the way the service uses the TV's inspector on port 9998. A local page under
// www.animeonsen.xyz (mapped to 127.0.0.1) plays Cloudflare's part; nothing reaches the real site.
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '..', 'test-results');
fs.mkdirSync(path.join(output, 'tmp'), { recursive: true });
process.env.TMPDIR = path.join(output, 'tmp');
const { chromium } = require('playwright');
const { createDevelopmentServer } = require('../tools/dev-server.cjs');
const { Onsen } = require('../service/onsen');
const { Clearance } = require('../service/clearance');
const { fixtureOpen, items } = require('./fixtures.cjs');

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function until(page, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await page.evaluate(fn)) return; } catch (_) { /* navigating */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out waiting for: ' + fn.toString().slice(0, 120));
}

(async () => {
  // The "Cloudflare" check: a page that sets an HttpOnly domain cookie once a person clicks.
  const site = http.createServer((req, res) => {
    if (req.url === '/pass') {
      res.writeHead(302, { 'Set-Cookie': 'cf_clearance=fake-token; Domain=animeonsen.xyz; Path=/; HttpOnly; Max-Age=3600', Location: '/' }); res.end(); return;
    }
    const passed = /cf_clearance=fake-token/.test(req.headers.cookie || '');
    res.writeHead(passed ? 200 : 403, { 'Content-Type': 'text/html', ...(passed ? {} : { 'cf-mitigated': 'challenge' }) });
    res.end(passed ? '<title>AnimeOnsen</title><h1>AnimeOnsen</h1>' : '<title>Just a moment...</title><a id="pass" href="/pass">Verify you are human</a>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const cdpPort = await freePort();

  // Upstream AnimeOnsen as the real adapter sees it: everything is challenged without the cookie.
  const seen = [];
  const transport = async (url, options) => {
    seen.push({ url, cookie: options.headers.Cookie || null, agent: options.headers['User-Agent'] });
    if (!/cf_clearance=fake-token/.test(options.headers.Cookie || '')) {
      const error = new Error('AnimeOnsen asks this connection to pass a browser check. Choose Verify with AnimeOnsen to do it once on the TV.');
      error.status = 403; error.code = 'SOURCE_CHALLENGE'; throw error;
    }
    if (url.includes('/oauth/token')) return JSON.stringify({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/content/index')) return JSON.stringify({ content: items.slice(0, 6).map(i => ({ content_id: i.id, content_title: i.title })), cursor: { next: [false] } });
    throw new Error('unexpected ' + url);
  };
  const clearance = new Clearance({ port: cdpPort, site: 'http://www.animeonsen.xyz/', interval: 300,
    cookieUrls: ['http://www.animeonsen.xyz/', 'https://api.animeonsen.xyz/', 'https://auth.animeonsen.xyz/'] });
  const server = await createDevelopmentServer({ source: new Onsen(transport, clearance), open: fixtureOpen, clearance });
  clearance.isAppUrl = url => String(url).split(/[?#]/)[0] === server.origin + '/';

  const browser = await chromium.launch({ headless: true, executablePath: process.env.ANISHELF_CHROMIUM || chromium.executablePath(),
    args: [`--remote-debugging-port=${cdpPort}`, `--host-resolver-rules=MAP www.animeonsen.xyz 127.0.0.1:${site.address().port}`,
      ...(process.env.ANISHELF_CHROMIUM ? ['--no-zygote', '--single-process', '--disable-gpu'] : [])] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [], policy = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Content.Security.Policy/i.test(message.text())) policy.push(message.text()); });
  try {
    await page.goto(server.origin);
    await page.locator('.error-title').waitFor();
    assert.equal(await page.locator('.error-title').textContent(), 'AnimeOnsen wants a quick check');
    await page.screenshot({ path: path.join(output, 'verify-prompt-1920.png') });
    checks.push('A challenged Browse offers Verify with AnimeOnsen');

    await page.getByRole('button', { name: 'Verify with AnimeOnsen', exact: true }).click();
    await page.waitForURL(/www\.animeonsen\.xyz/);
    assert.equal(await page.title(), 'Just a moment...');
    checks.push('The service opens the check page in the app window');

    await page.locator('#pass').click(); // the person passing the check
    await page.waitForURL(url => url.href.startsWith(server.origin), { timeout: 20000 });
    await page.locator('.anime-card').first().waitFor();
    assert.equal(await page.locator('.anime-card').count(), 6);
    assert.equal(await page.locator('#toast').textContent(), 'AnimeOnsen check passed.');
    assert.equal(await page.evaluate(() => location.hash), '');
    const agent = await page.evaluate(() => navigator.userAgent);
    const accepted = seen.filter(request => request.cookie);
    assert.ok(accepted.length >= 1);
    assert.ok(accepted.every(request => request.cookie.includes('cf_clearance=fake-token') && request.agent === agent));
    checks.push('After the check the app returns by itself and AnimeOnsen requests carry the cookie and browser user agent');

    await page.locator('[data-route="settings"]').click();
    await page.getByRole('button', { name: 'Connection details', exact: true }).click();
    assert.equal(JSON.parse(await page.locator('.code-box').textContent()).clearance.active, true);
    await page.keyboard.press('Escape');
    checks.push('Connection details report an active clearance');

    // Service restart: the in-memory cookie is gone, but the browser still holds it.
    clearance.cookies = []; clearance.lastRefresh = 0;
    await page.reload();
    await page.locator('.anime-card').first().waitFor();
    assert.equal(await page.locator('.error-title').count(), 0);
    checks.push('After a service restart the cookie is re-read from the browser without asking again');
    assert.deepEqual(errors, []); assert.deepEqual(policy, []);
    checks.push('No uncaught browser errors or Content-Security-Policy violations');
    fs.writeFileSync(path.join(output, 'verify-results.json'), JSON.stringify({ ok: true, checks }, null, 2));
    console.log(checks.map(x => 'PASS ' + x).join('\n'));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'verify-failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'verify-results.json'), JSON.stringify({ ok: false, checks, errors, policy, failure: error.message }, null, 2));
    throw error;
  } finally { await browser.close(); await server.close(); site.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
