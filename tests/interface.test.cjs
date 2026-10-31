'use strict';
// DOM integration checks only. jsdom does not validate layout, codecs, or TV APIs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createDevelopmentServer } = require('../tools/dev-server.cjs');
const { fixtureSource, fixtureOpen } = require('./fixtures.cjs');
async function until(fn) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Interface condition timed out.');
}
async function load(server, seed) {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = await JSDOM.fromURL(server.origin, { resources: 'usable', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole, beforeParse(window) {
      window.fetch = (url, options) => fetch(new URL(url, server.origin), options);
      window.AbortController = AbortController;
      window.HTMLElement.prototype.scrollIntoView = function () {};
      if (seed) window.localStorage.setItem('anishelf.state.v1', seed);
    } });
  await until(() => dom.window.AniShelf?.toast && dom.window.document.querySelector('.anime-card'));
  return { dom, errors, document: dom.window.document };
}
function button(document, name, root = document) {
  const found = Array.from(root.querySelectorAll('button')).find(b => b.textContent.trim() === name);
  assert.ok(found, 'Button exists: ' + name); return found;
}
test('interface integrates catalog, search, details, library, watched state, persistence and source errors', async t => {
  const source = fixtureSource();
  const server = await createDevelopmentServer({ source, open: fixtureOpen });
  let page;
  t.after(async () => { page?.dom.window.close(); await server.close(); });
  page = await load(server);
  let d = page.document;
  assert.equal(d.querySelectorAll('.anime-card').length, 6);
  button(d, 'Load more').click(); await until(() => d.querySelectorAll('.anime-card').length === 12);
  d.querySelector('input[type="search"]').value = 'rain'; button(d, 'Search').click();
  await until(() => d.querySelectorAll('.anime-card').length === 1);
  assert.equal(d.querySelector('.card-title').textContent, 'Signal in the Rain');
  d.querySelector('.anime-card').click(); await until(() => d.querySelectorAll('[data-episode]').length === 3);
  button(d, 'Add to library').click();
  button(d, 'Watching').click(); button(d, 'Planned', d.querySelector('#modal-body')).click();
  d.querySelector('[data-mark="2"]').click();
  assert.equal(d.querySelector('[data-mark="2"]').textContent, 'Watched');
  const A = page.dom.window.AniShelf;
  assert.equal(A.state.get('test-1').category, 'Planned');
  assert.equal(A.state.progress('test-1', '2').seen, true);
  assert.throws(() => A.state.import({ version: 1, library: { bad: { id: '__proto__', title: 'Bad' } } }));
  assert.equal(A.state.list().length, 1);

  d.querySelector('[data-route="settings"]').click();
  const field = d.querySelector('button.select-field[aria-label="Subtitle language"]'); field.click();
  assert.equal(d.getElementById('modal').hidden, false);
  button(d, 'Русский', d.querySelector('#modal-body')).click();
  assert.equal(A.state.settings().subtitle, 'ru-RU');
  assert.equal(field.textContent, 'Русский'); assert.equal(d.getElementById('modal').hidden, true);
  d.querySelector('button.select-field[aria-label="Subtitle size"]').click();
  button(d, 'Large', d.querySelector('#modal-body')).click();
  assert.equal(A.state.settings().subtitleSize, 125);
  assert.equal(d.body.textContent.includes('\u2026'), false, 'no ellipsis glyphs (the TV font centres them)');
  const saved = A.state.export(); page.dom.window.close();
  page = await load(server, saved); d = page.document;
  assert.match(d.querySelector('h1').textContent, /home/);
  assert.equal(d.querySelectorAll('.anime-card').length, 1);
  assert.equal(page.dom.window.AniShelf.state.progress('test-1', '2').seen, true);
  d.querySelector('[data-route="history"]').click(); assert.equal(d.querySelectorAll('.history-row').length, 1);

  source.catalog = async () => { const error = new Error('blocked'); error.status = 403; throw error; };
  d.querySelector('[data-route="browse"]').click();
  await until(() => d.querySelector('.error-title'));
  assert.match(d.querySelector('.empty').textContent, /HTTP 403/);
  d.querySelector('[data-route="library"]').click(); assert.equal(d.querySelectorAll('.anime-card').length, 1);
  assert.deepEqual(page.errors, []);
});

test('titles from a source are rendered as text and cannot inject HTML', async t => {
  const source = fixtureSource(); source.catalog = async () => ({ items: [{ id: 'unsafe', title: '<img src=x onerror="window.pwned=true">',
    image: 'https://api.animeonsen.xyz/v4/image/210x300/unsafe', genres: [] }], next: false });
  const server = await createDevelopmentServer({ source, open: fixtureOpen });
  let page; t.after(async () => { page?.dom.window.close(); await server.close(); });
  page = await load(server); const title = page.document.querySelector('.card-title');
  assert.match(title.textContent, /<img/); assert.equal(title.querySelector('img'), null);
  assert.equal(page.dom.window.pwned, undefined); assert.deepEqual(page.errors, []);
});
