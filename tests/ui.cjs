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
const { fixtureSource, fixtureOpen, fixtureSkipTimes } = require('./fixtures.cjs');

// Polls from Node with page.evaluate, so the app's Content-Security-Policy stays enforced
// (Playwright's in-page waitForFunction polling needs eval, which that policy blocks).
async function until(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for: ' + fn.toString().slice(0, 140));
}
const info = page => page.evaluate(() => window.AniShelf.player.info());
async function choose(page, label, option) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.locator('#modal.dropdown #modal-body').getByRole('option', { name: option, exact: true }).click();
}
const now = page => page.evaluate(() => document.getElementById('video').currentTime);

(async () => {
  const server = await createDevelopmentServer({ source: fixtureSource(), open: fixtureOpen, skipTimes: fixtureSkipTimes });
  let browser;
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.ANISHELF_CHROMIUM || chromium.executablePath(),
    args: process.env.ANISHELF_CHROMIUM ? ['--no-zygote', '--single-process', '--disable-gpu', '--disable-software-rasterizer', '--autoplay-policy=no-user-gesture-required'] : ['--autoplay-policy=no-user-gesture-required'] }); }
  catch (error) { await server.close(); throw error; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [], policy = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Content.Security.Policy/i.test(message.text())) policy.push(message.text()); });
  const checks = [];
  try {
    await page.goto(server.origin);
    await page.locator('.anime-card').first().waitFor();
    assert.equal(await page.locator('.anime-card').count(), 6); checks.push('Catalog rendered with six titles');
    // First visit: focus on the first title, the search box dim (no focus ring, normal border).
    await until(page, () => document.activeElement === document.querySelector('.anime-card'));
    const searchLook = () => page.evaluate(() => {
      const box = document.querySelector('.search-field'), style = getComputedStyle(box);
      return { border: style.borderTopColor, outline: style.outlineStyle, focused: box.matches(':focus, :focus-within') };
    });
    assert.deepEqual(await searchLook(), { border: 'rgb(56, 50, 67)', outline: 'none', focused: false });
    await page.keyboard.press('ArrowUp');
    assert.deepEqual(await searchLook(), { border: 'rgb(208, 188, 255)', outline: 'none', focused: true });
    checks.push('Browse opens on the first title; the search box is dim until reached, then a single border');
    // Menu icons are drawn (SVG), not font symbols that the TV font lacks.
    const icons = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item')).map(item => {
      const svg = item.querySelector('svg.nav-icon'), box = svg && svg.getBoundingClientRect();
      return { svg: !!svg, width: box ? Math.round(box.width) : 0, symbols: /[^\x00-\x7f]/.test(item.textContent) };
    }));
    assert.deepEqual(icons, Array(4).fill({ svg: true, width: 26, symbols: false }));
    await page.locator('.sidebar').screenshot({ path: path.join(output, 'sidebar-icons.png') });
    checks.push('Menu icons are drawn shapes, not font symbols');
    await page.screenshot({ path: path.join(output, 'browse-1920.png') });
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await until(page, () => document.querySelectorAll('.anime-card').length === 12);
    checks.push('Catalog pagination loads additional titles');

    await page.locator('[data-route="library"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.route), 'browse');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#content')), true);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.route), 'browse');
    checks.push('D-pad moves into content and Left returns to the active menu entry');

    await page.getByRole('searchbox').focus();
    await page.getByRole('button', { name: 'Search', exact: true }).hover();
    await page.locator('[data-route="settings"]').hover();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Search anime');
    checks.push('Moving the pointer over buttons does not take focus from the search field');
    assert.equal(await page.evaluate(() => document.body.innerText.includes('\u2026') || document.querySelector('input[type=search]').placeholder.includes('\u2026')), false);
    // The TV opens its keyboard whenever the text field has focus: nothing may focus it except the user.
    const activeIsField = () => page.evaluate(() => document.activeElement.matches('input[type=search]'));
    await page.locator('[data-route="browse"]').click(); await page.locator('.anime-card').first().waitFor();
    assert.equal(await activeIsField(), false);
    await page.getByRole('searchbox').fill('rain'); await page.keyboard.press('Enter');
    await until(page, () => document.querySelectorAll('.anime-card').length === 1 && document.activeElement.classList.contains('anime-card'));
    assert.match(await page.locator('.card-title').textContent(), /Signal/);
    checks.push('Enter in the search field submits, leaves the field (keyboard closes) and focuses the first result');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await until(page, () => document.querySelectorAll('.anime-card').length === 1);
    assert.equal(await activeIsField(), false);
    checks.push('The Search button does not focus the text field');
    await page.locator('.search-field').focus(); await page.keyboard.press('Enter');
    assert.equal(await activeIsField(), true);
    await page.keyboard.press('Escape');
    assert.equal(await activeIsField(), false);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('search-field')), true);
    assert.equal(await page.locator('h1').textContent(), 'Find your next watch.');
    checks.push('OK on the search box starts typing; Back stops typing without leaving Browse');
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

    // Episode 1 is a DASH stream with 360p/180p video and Japanese/English audio.
    await page.locator('[data-episode="1"]').click();
    await until(page, () => { const v = document.getElementById('video'); return v.currentTime > .3 && !v.paused; });
    const dash = await info(page);
    assert.equal(dash.engine, 'shaka'); assert.deepEqual(dash.qualities, [360, 180]); assert.equal(dash.audioTracks.length, 2);
    assert.equal(dash.audio, 'ja');
    await until(page, () => document.getElementById('subtitle-overlay').textContent.includes('Subtitle playback test'));
    checks.push('DASH episode plays through Shaka with converted subtitles; Japanese audio preferred');

    await until(page, () => !document.getElementById('skip-segment').hidden);
    assert.equal(await page.locator('#skip-segment').textContent(), 'Skip opening');
    await page.screenshot({ path: path.join(output, 'player-skip-1920.png') });
    await page.locator('#skip-segment').click();
    await until(page, () => document.getElementById('video').currentTime >= 8.7);
    await until(page, () => document.getElementById('skip-segment').hidden);
    checks.push('AniSkip opening shows a skip button that jumps past it');

    await page.locator('#quality-button').click();
    const qualityOptions = await page.locator('#modal-body .modal-list button').allTextContents();
    assert.ok(qualityOptions[0].startsWith('Automatic')); assert.ok(qualityOptions.some(x => x.startsWith('360p'))); assert.ok(qualityOptions.some(x => x.startsWith('180p')));
    await page.screenshot({ path: path.join(output, 'player-quality-1920.png') });
    await page.locator('#modal-body .modal-list button', { hasText: /^180p/ }).click();
    await until(page, () => { const i = window.AniShelf.player.info(); return i.height === 180 && i.auto === false; });
    assert.match(await page.locator('#quality-button').textContent(), /^180p$/);
    checks.push('Quality menu switches to a fixed 180p rendition');

    await page.locator('#audio-button').click();
    const audioOptions = await page.locator('#modal-body .modal-list button').allTextContents();
    assert.deepEqual(audioOptions.filter(x => ['English', 'Japanese'].includes(x)).sort(), ['English', 'Japanese']);
    assert.ok(audioOptions.includes("Use the TV's built-in player"));
    assert.match(await page.locator('#modal-body .modal-note').first().textContent(), /Audio format mp4a\.40\.2/);
    await page.screenshot({ path: path.join(output, 'player-audio-1920.png') });
    await page.locator('#modal-body .modal-list button', { hasText: 'English' }).click();
    await until(page, () => window.AniShelf.player.info().audio === 'en');
    checks.push('Audio menu switches between Japanese and English tracks');

    const before = await now(page);
    await page.getByRole('button', { name: '+10 sec', exact: true }).click();
    await until(page, start => document.getElementById('video').currentTime >= start + 9, before);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    assert.equal(await page.evaluate(() => document.getElementById('video').paused), true);
    await page.getByRole('button', { name: 'Subtitles', exact: true }).click();
    await page.locator('#modal-body').getByRole('button', { name: 'Off', exact: true }).click();
    assert.equal(await page.locator('#subtitle-overlay').textContent(), '');
    const paused = await now(page);
    await page.getByRole('button', { name: 'Back to episodes', exact: true }).click();
    await page.locator('[data-episode="1"]').waitFor();
    assert.match(await page.locator('[data-episode="1"] .episode-state').textContent(), /resume/);
    checks.push('Seeking, pausing, subtitle selection and saved resume position work');

    await page.locator('[data-episode="1"]').click();
    await until(page, at => { const v = document.getElementById('video'); return v.currentTime >= at - 1 && !v.paused; }, paused);
    await until(page, () => window.AniShelf.player.info().height === 180);
    assert.equal((await info(page)).audio, 'en');
    await page.keyboard.press('Escape');
    await page.locator('[data-episode="1"]').waitFor();
    checks.push('Reopening resumes the position with the saved quality and audio choice');

    await page.locator('[data-route="settings"]').click();
    await page.getByRole('button', { name: 'Opening and ending', exact: true }).click();
    const panel = await page.evaluate(() => {
      const field = document.querySelector('[aria-label="Opening and ending"]').getBoundingClientRect();
      const body = document.getElementById('modal-body'), box = body.getBoundingClientRect();
      return { radius: getComputedStyle(body).borderTopLeftRadius, near: Math.abs(box.top - field.bottom) < 40 || Math.abs(box.bottom - field.top) < 40,
        focused: document.activeElement.textContent };
    });
    assert.equal(panel.radius, '20px'); assert.equal(panel.near, true); assert.equal(panel.focused, 'Show a skip button');
    await page.screenshot({ path: path.join(output, 'settings-dropdown-1920.png') });
    await page.locator('#modal.dropdown #modal-body').getByRole('option', { name: 'Skip automatically', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Opening and ending', exact: true }).textContent(), 'Skip automatically');
    checks.push('Settings dropdowns open as an anchored rounded list');
    await page.locator('[data-route="library"]').click();
    await page.locator('.anime-card').first().click();
    await page.locator('[data-episode="2"]').click();
    await until(page, () => document.getElementById('video').currentTime >= 8.7, undefined, 20000);
    assert.equal(await page.locator('#toast').textContent(), 'Skipped the opening');
    assert.equal((await info(page)).engine, 'shaka');
    checks.push('Automatic skip jumps the opening of a progressive MP4 episode');

    await page.getByRole('button', { name: 'Subtitles', exact: true }).click();
    await page.locator('#modal-body').getByRole('button', { name: 'Large', exact: true }).click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('subtitle-overlay')).fontSize), '42.5px');
    checks.push('Subtitle size changes from the Subtitles menu');

    await page.locator('#audio-button').click();
    await page.locator('#modal-body').getByRole('button', { name: "Use the TV's built-in player", exact: true }).click();
    await until(page, () => window.AniShelf.player.info().engine === 'native' && !document.getElementById('video').paused, undefined, 20000);
    await page.locator('#audio-button').click();
    assert.match(await page.locator('#modal-body .modal-note').first().textContent(), /built-in player/);
    await page.locator('#modal-body').getByRole('button', { name: 'Use the AniShelf player', exact: true }).click();
    await until(page, () => window.AniShelf.player.info().engine === 'shaka' && !document.getElementById('video').paused, undefined, 20000);
    assert.equal(await page.evaluate(() => window.AniShelf.state.settings().engine), 'shaka');
    checks.push("Audio menu switches to the TV's built-in player and back");
    await page.keyboard.press('Escape');
    await page.locator('[data-episode="2"]').waitFor();

    await page.locator('[data-route="library"]').click();
    await page.getByRole('button', { name: 'Planned', exact: true }).click();
    assert.equal(await page.locator('.anime-card').count(), 1);
    await page.reload(); await page.locator('.anime-card').first().waitFor();
    assert.equal(await page.locator('.anime-card').count(), 1); checks.push('Library survives app reload');
    await page.locator('[data-route="history"]').click();
    assert.ok(await page.locator('.history-row').count() >= 2); checks.push('Recent playback and watched episodes appear in history');

    // Regression: switching episodes while the previous video is still unloading must not
    // record the old position (here 29/30 s = watched) against the next, untouched episode.
    await page.locator('[data-route="browse"]').click();
    await page.locator('.anime-card[data-id="test-2"]').click();
    await page.locator('[data-episode="1"]').click();
    await until(page, () => { const v = document.getElementById('video'); return v.currentTime > .3 && !v.paused; });
    await page.evaluate(() => {
      const unload = window.shaka.Player.prototype.unload;
      window.shaka.Player.prototype.unload = function (...args) { return new Promise(r => setTimeout(r, 600)).then(() => unload.apply(this, args)); };
    });
    await page.evaluate(() => new Promise(resolve => {
      const v = document.getElementById('video');
      v.addEventListener('seeked', () => { document.getElementById('next-episode').click(); resolve(); }, { once: true });
      v.currentTime = 29;
    }));
    await until(page, () => document.getElementById('player-episode').textContent.startsWith('Episode 2') &&
      document.getElementById('video').currentTime > 0 && !document.getElementById('video').paused, undefined, 20000);
    const switched = await page.evaluate(() => ({ first: window.AniShelf.state.progress('test-2', '1'), next: window.AniShelf.state.progress('test-2', '2') }));
    assert.equal(switched.first?.seen, true, 'the finished episode is marked watched');
    assert.ok(!switched.next || (switched.next.seen === false && switched.next.position < 25), 'next episode kept clean: ' + JSON.stringify(switched.next));
    await page.keyboard.press('Escape');
    checks.push('Switching episodes during a slow unload keeps the next episode\'s progress clean');

    // Episode 3: the manifest moves to another CDN with <BaseURL> and uses single-quoted,
    // host-relative segment templates.
    await page.locator('[data-episode="3"]').click();
    await until(page, () => { const v = document.getElementById('video'); return v.currentTime > .3 && !v.paused; });
    assert.deepEqual((await info(page)).qualities, [360, 180]);
    await page.keyboard.press('Escape');
    await page.locator('[data-episode="3"]').waitFor();
    checks.push('DASH with a CDN-changing BaseURL and single-quoted templates plays');

    await page.locator('[data-route="settings"]').click();
    assert.equal(await page.getByRole('button', { name: 'Video quality', exact: true }).getAttribute('data-value'), '180');
    await choose(page, 'Title language', 'English');
    await page.screenshot({ path: path.join(output, 'settings-1920.png'), fullPage: true });
    await page.getByRole('button', { name: 'Connection details', exact: true }).click();
    const diagnostics = JSON.parse(await page.locator('.code-box').textContent());
    assert.equal(diagnostics.loopbackOnly, true); assert.ok(diagnostics.playback && 'audioDecodedBytes' in diagnostics.playback);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#modal').isVisible(), false);
    checks.push('Settings and diagnostic dialog are remote accessible');

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('[data-route="browse"]').click();
    await page.locator('.anime-card').first().waitFor();
    await page.screenshot({ path: path.join(output, 'browse-1280.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.locator('[data-route="library"]').click();
    await page.locator('.anime-card').first().click();
    await page.locator('[data-episode="1"]').click();
    await until(page, () => { const v = document.getElementById('video'); return v.currentTime > 0 && !v.paused; });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const fits = await page.evaluate(() => Array.from(document.querySelectorAll('#player-controls button')).every(b => {
      const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    }));
    await page.screenshot({ path: path.join(output, 'player-1280.png') });
    assert.equal(fits, true);
    await page.keyboard.press('Escape');
    checks.push('Layout and player controls fit 1920×1080 and 1280×720');
    assert.deepEqual(errors, []); assert.deepEqual(policy, []); checks.push('No uncaught browser errors or Content-Security-Policy violations');
    fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
    console.log(checks.map(x => 'PASS ' + x).join('\n'));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') });
    fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ ok: false, checks, errors, policy, failure: error.message }, null, 2));
    throw error;
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
