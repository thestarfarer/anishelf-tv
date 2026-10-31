'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(path.join(output, 'tmp'), { recursive: true });
process.env.TMPDIR = path.join(output, 'tmp');
const { chromium } = require('playwright');
const { createDevelopmentServer } = require('../tools/dev-server.cjs');
const { fixtureSource, fixtureOpen } = require('./fixtures.cjs');

(async () => {
  const server = await createDevelopmentServer({ source: fixtureSource(), open: fixtureOpen });
  let browser;
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.ANISHELF_CHROMIUM || chromium.executablePath(),
    args: process.env.ANISHELF_CHROMIUM ? ['--no-zygote', '--single-process', '--disable-gpu', '--disable-software-rasterizer'] : [] }); }
  catch (error) { await server.close(); throw error; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const checks = [];
  try {
    await page.goto(server.origin);
    await page.locator('.anime-card').first().waitFor();
    assert.equal(await page.locator('.anime-card').count(), 6); checks.push('Catalog rendered with six titles');
    await page.screenshot({ path: path.join(output, 'browse-1920.png') });
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.anime-card').length === 12);
    assert.equal(await page.locator('.anime-card').count(), 12); checks.push('Catalog pagination loads additional titles');

    await page.locator('[data-route="library"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.route), 'browse');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Search anime');
    checks.push('D-pad moves between sidebar and content');

    await page.getByRole('searchbox').fill('rain'); await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.anime-card').length === 1);
    assert.match(await page.locator('.card-title').textContent(), /Signal/); checks.push('Search returns matching titles');
    await page.locator('.anime-card').first().click();
    await page.locator('[data-episode="1"]').waitFor();
    await page.getByRole('button', { name: 'Add to library', exact: true }).click();
    await page.getByRole('button', { name: 'Watching', exact: true }).click();
    await page.locator('#modal-body').getByRole('button', { name: 'Planned', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Planned', exact: true }).count(), 1);
    await page.locator('[data-mark="2"]').click();
    assert.equal(await page.locator('[data-mark="2"]').textContent(), 'Watched'); checks.push('Library categories and watched status persist');
    await page.screenshot({ path: path.join(output, 'details-1920.png') });

    await page.locator('[data-episode="1"]').click();
    await page.waitForFunction(() => {
      const v = document.getElementById('video'); return v.currentTime > .3 && !v.paused;
    }, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('subtitle-overlay').textContent.includes('Subtitle playback test'));
    checks.push('Real H.264/AAC sample video plays with converted subtitles');
    await page.getByRole('button', { name: '+10 sec', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('video').currentTime >= 10);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    assert.equal(await page.evaluate(() => document.getElementById('video').paused), true);
    await page.getByRole('button', { name: 'Subtitles', exact: true }).click();
    await page.locator('#modal-body').getByRole('button', { name: 'Off', exact: true }).click();
    assert.equal(await page.locator('#subtitle-overlay').textContent(), '');
    await page.getByRole('button', { name: 'Back to episodes', exact: true }).click();
    await page.locator('[data-episode="1"]').waitFor();
    assert.match(await page.locator('[data-episode="1"] .episode-state').textContent(), /resume/);
    checks.push('Seeking, pausing, subtitle selection and saved resume position work');
    await page.locator('[data-episode="1"]').click();
    await page.waitForFunction(() => document.getElementById('video').currentTime >= 10);
    await page.keyboard.press('Escape');
    await page.locator('[data-episode="1"]').waitFor(); checks.push('Playback resumes at saved position and Back exits');

    await page.locator('[data-route="library"]').click();
    await page.getByRole('button', { name: 'Planned', exact: true }).click();
    assert.equal(await page.locator('.anime-card').count(), 1);
    await page.reload(); await page.locator('.anime-card').first().waitFor();
    assert.equal(await page.locator('.anime-card').count(), 1); checks.push('Library survives app reload');
    await page.locator('[data-route="history"]').click();
    assert.ok(await page.locator('.history-row').count() >= 2); checks.push('Recent playback and watched episodes appear in history');

    await page.locator('[data-route="settings"]').click();
    await page.getByLabel('Title language', { exact: true }).selectOption('english');
    await page.getByRole('button', { name: 'Connection details', exact: true }).click();
    assert.match(await page.locator('.code-box').textContent(), /loopbackOnly/);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#modal').isVisible(), false);
    checks.push('Settings and diagnostic dialog are remote accessible');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('[data-route="browse"]').click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.locator('.anime-card').first().waitFor();
    await page.screenshot({ path: path.join(output, 'browse-1280.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    checks.push('Layout fits 1920×1080 and 1280×720 without horizontal overflow');
    assert.deepEqual(errors, []); checks.push('No uncaught browser errors');
    fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
    console.log(checks.map(x => 'PASS ' + x).join('\n'));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') });
    fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ ok: false, checks, errors, failure: error.message }, null, 2));
    throw error;
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
