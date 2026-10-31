(function () {
  'use strict';
  const A = window.AniShelf;
  const content = document.getElementById('content');
  let route = 'browse', history = [], currentAnime, currentEpisodes = [], request, revision = 0, toastTimer;
  let catalog = [], nextPage = false, pageStart = 0, query = '', libraryFilter = 'All', focusResults = false;
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, fn, cls) => { const b = el('button', cls, text); b.onclick = () => { try { const r = fn(); if (r?.catch) r.catch(e => A.toast(e.message)); } catch (e) { A.toast(e.message); } }; return b; };
  A.toast = message => { const toast = document.getElementById('toast'); toast.textContent = message; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 4500); };
  function begin(newRoute, push = false) {
    if (push) history.push({ route, anime: currentAnime, scroll: content.scrollTop });
    request?.abort(); request = new AbortController(); ++revision;
    route = newRoute; content.replaceChildren(); content.scrollTop = 0;
    for (const nav of document.querySelectorAll('[data-route]')) nav.classList.toggle('active', nav.dataset.route === route || (route === 'detail' && nav.dataset.route === 'browse'));
    return revision;
  }
  function header(eyebrow, title, subtitle, badge) {
    const head = el('header', 'page-header'), copy = el('div');
    copy.append(el('div', 'eyebrow', eyebrow), el('h1', '', title));
    if (subtitle) copy.append(el('p', 'page-subtitle', subtitle)); head.append(copy);
    if (badge) head.append(el('span', 'badge', badge)); content.append(head);
  }
  function loading(where = content) { const row = el('div', 'loading-row'); row.append(el('div', 'spinner'), el('span', '', 'Loading from AnimeOnsen...')); where.append(row); return row; }
  function errorState(error, retry, where = content) {
    const box = el('section', 'empty'), actions = el('div', 'actions');
    if (error.code === 'SOURCE_CHALLENGE') {
      box.append(el('h2', 'error-title', 'AnimeOnsen wants a quick check'), el('p', '', error.message));
      box.append(el('p', 'error-note', 'AniShelf opens AnimeOnsen\'s check page on the TV. Complete it with the pointer if it asks, and AniShelf comes back on its own.'));
      actions.append(button('Verify with AnimeOnsen', verifySource, 'primary'), button('Try again', retry, 'subtle'));
    } else {
      box.append(el('h2', 'error-title', 'Couldn\'t reach this source'), el('p', '', error.message));
      box.append(el('p', 'error-note', 'Your library and saved progress are still on this TV.'));
      actions.append(button('Try again', retry, 'primary'));
    }
    box.append(actions); where.append(box); return box;
  }
  async function verifySource() {
    A.toast('Opening AnimeOnsen\'s check...');
    try { await A.api.verify(); }
    catch (e) {
      A.openModal('Verification could not start', body => {
        body.append(el('p', '', e.message), button('Close', A.closeModal, 'primary'));
      });
    }
  }
  function titleOf(item) { return (A.state.settings().title === 'english' ? item.english : item.romaji) || item.title; }
  function poster(item) {
    const wrap = el('div', 'poster');
    const initials = titleOf(item).split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase();
    wrap.append(el('span', 'poster-initials', initials));
    const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.onerror = () => img.remove();
    if (item.image) img.src = item.image;
    else A.api.call('image', { id: item.id }, request.signal).then(data => { if (wrap.isConnected) img.src = data.url; }).catch(() => {});
    wrap.append(img); return wrap;
  }
  function card(item, meta) {
    const card = button('', () => detail(item, true), 'anime-card'); card.dataset.id = item.id;
    const cover = poster(item), stored = A.state.get(item.id);
    if (stored) cover.append(el('span', 'poster-tag', stored.category));
    card.append(cover, el('span', 'card-title', titleOf(item)), el('span', 'card-meta', meta || 'AnimeOnsen'));
    return card;
  }
  function grid(items, where = content) { const g = el('div', 'grid'); for (const item of items) g.append(card(item)); where.append(g); return g; }
  function empty(title, text, action, label = 'Browse AnimeOnsen') {
    const box = el('section', 'empty'); box.append(el('h2', '', title), el('p', '', text));
    if (action) box.append(button(label, action, 'primary')); content.append(box);
  }
  function firstContent() { A.nav.first(content); }
  async function browse(reset = true) {
    const rev = begin('browse');
    header('DISCOVER · ANIMEONSEN', 'Find your next watch.', 'Your familiar source, made for the big screen.', 'TV-only · Personal port');
    // webOS opens its keyboard whenever a text field gets focus. The remote therefore lands on a box
    // around the field (OK starts typing), and focus never returns to the field on its own.
    const form = el('form', 'search-form'), field = el('div', 'search-field'), input = document.createElement('input');
    field.tabIndex = 0; field.setAttribute('role', 'button'); field.setAttribute('aria-label', 'Search anime, press OK to type');
    input.type = 'search'; input.placeholder = 'Search anime...'; input.value = query; input.maxLength = 200; input.setAttribute('aria-label', 'Search anime');
    input.tabIndex = -1; field.append(input);
    field.addEventListener('keydown', event => { if (event.target === field && event.key === 'Enter') { event.preventDefault(); input.focus(); } });
    field.addEventListener('click', event => { if (event.target === field) input.focus(); });
    const submit = el('button', 'primary', 'Search'); submit.type = 'submit'; form.append(field, submit);
    if (query) form.append(button('Clear', () => { query = ''; return browse(); }, 'subtle'));
    form.onsubmit = event => {
      event.preventDefault(); query = input.value.trim();
      input.blur(); focusResults = true; // closes the keyboard; results take focus when they arrive
      browse();
    };
    content.append(form);
    const section = el('div', 'section-line'); section.append(el('h2', '', query ? 'Search results' : 'Explore the catalog')); content.append(section);
    const target = el('section'); content.append(target);
    if (!reset && catalog.length) { grid(catalog, target); pagination(target, rev); firstContent(); return; }
    const busy = loading(target); firstContent();
    const toResults = focusResults; focusResults = false;
    try {
      const result = await A.api.call(query ? 'search' : 'catalog', query ? { q: query } : { start: 0 }, request.signal);
      if (rev !== revision) return;
      catalog = result.items; nextPage = result.next; pageStart = 0; busy.remove();
      if (!catalog.length) { const box = el('div', 'empty'); box.append(el('h2', '', 'No matches yet'), el('p', '', 'Try another spelling or the Japanese title.')); target.append(box); }
      else grid(catalog, target);
      pagination(target, rev);
      if (toResults) A.nav.focus(target.querySelector('.anime-card'));
    } catch (e) { if (rev !== revision) return; busy.remove(); errorState(e.name === 'AbortError' ? new Error('The source request timed out.') : e, browse, target); }
  }
  function pagination(target, rev) {
    if (!nextPage || query) return;
    const more = button('Load more', async () => {
      more.disabled = true; more.textContent = 'Loading...';
      try {
        const result = await A.api.call('catalog', { start: pageStart + 30 }, request.signal);
        if (rev !== revision) return;
        pageStart += 30; nextPage = result.next;
        const existing = new Set(catalog.map(x => x.id)), incoming = result.items.filter(x => !existing.has(x.id));
        catalog.push(...incoming);
        const g = target.querySelector('.grid'); incoming.forEach(item => g.append(card(item)));
        const nextFocus = incoming.length ? g.querySelector(`[data-id="${incoming[0].id}"]`) : null;
        more.remove(); pagination(target, rev); A.nav.focus(nextFocus);
      } catch (e) { more.disabled = false; more.textContent = 'Retry loading more'; A.toast(e.message); }
    }, 'subtle load-more'); target.append(more);
  }
  function library() {
    begin('library'); const all = A.state.list();
    header('YOUR COLLECTION', 'Make yourself at home.', 'The shows you save, ready for another episode.', `${all.length} saved ${all.length === 1 ? 'title' : 'titles'}`);
    const filters = el('div', 'filters');
    for (const label of ['All', 'Watching', 'Planned', 'Completed']) filters.append(button(label, () => { libraryFilter = label; library(); }, 'chip' + (libraryFilter === label ? ' selected' : '')));
    content.append(filters);
    const items = all.filter(x => libraryFilter === 'All' || x.category === libraryFilter).sort((a, b) => b.addedAt - a.addedAt);
    if (items.length) grid(items);
    else empty(all.length ? 'Nothing in this shelf yet.' : 'Your next favorite belongs here.', 'Open a title in Browse and choose Add to library. Your list and watch progress stay on this TV.', browse);
    firstContent();
  }
  function showHistory() {
    begin('history'); header('PICK UP WHERE YOU LEFT OFF', 'One more episode?', 'Your recent watches and saved playback positions.');
    const records = A.state.history();
    if (!records.length) empty('A fresh start.', 'Episodes you watch will appear here, with your place saved automatically.', browse);
    for (const p of records.slice(0, 100)) {
      const anime = A.state.get(p.animeId) || { id: p.animeId, title: p.animeTitle, source: 'animeonsen' };
      const row = el('div', 'episode-row history-row');
      const play = button('', () => detail(anime, true), 'episode-play');
      const text = el('div', 'episode-copy'); text.append(el('span', 'episode-title', titleOf(anime)),
        el('span', 'episode-state', `Episode ${p.episodeId} · ${p.seen ? 'Watched' : duration(p.position) + ' watched'} · ${new Date(p.updatedAt).toLocaleDateString()}`));
      play.append(text); row.append(play); content.append(row);
    }
    firstContent();
  }
  function duration(seconds) { const m = Math.floor((Number(seconds) || 0) / 60); return m ? `${m} min` : `${Math.floor(seconds || 0)} sec`; }
  async function detail(item, push = false) {
    const rev = begin('detail', push); currentAnime = item;
    content.append(button('Back', A.back, 'back-button'));
    const hero = el('section', 'detail-hero'), cover = el('div', 'detail-cover'); cover.append(poster(item));
    const copy = el('div', 'detail-copy'); copy.append(el('div', 'eyebrow', 'ANIMEONSEN'), el('h1', '', titleOf(item)));
    const meta = el('div', 'detail-meta'), desc = el('p', 'synopsis', item.description || 'Loading title information...');
    const actions = el('div', 'actions'); copy.append(meta, desc, actions); hero.append(cover, copy); content.append(hero);
    const episodesArea = el('section'); content.append(episodesArea); const busy = loading(episodesArea);
    renderActions(actions, item, []);
    firstContent();
    // Details and episodes are independent. A failed synopsis must not stop playback.
    const detailsPromise = A.api.call('details', { id: item.id }, request.signal).then(full => {
      if (rev !== revision) return;
      currentAnime = full; copy.querySelector('h1').textContent = titleOf(full); desc.textContent = full.description || 'No synopsis provided by this source.';
      try { A.state.remember(full.id, full.malId); } catch (_) {}
      meta.textContent = [full.score ? `Score ${full.score}` : '', full.status?.replace(/_/g, ' '), ...(full.genres || [])].filter(Boolean).join(' · ');
      renderActions(actions, full, currentEpisodes);
    }).catch(e => { if (rev === revision) desc.textContent = item.description || 'Title information is unavailable. Episodes may still load.'; });
    currentEpisodes = [];
    try {
      const episodes = await A.api.call('episodes', { id: item.id }, request.signal);
      if (rev !== revision) return;
      currentEpisodes = episodes; busy.remove(); renderActions(actions, currentAnime, episodes);
      renderEpisodes(episodesArea, currentAnime, episodes);
    } catch (e) { if (rev !== revision) return; busy.remove(); errorState(e, () => detail(currentAnime), episodesArea); }
    await detailsPromise;
  }
  function resumeEpisode(anime, episodes) {
    const unfinished = A.state.history().find(p => p.animeId === anime.id && !p.seen && p.position > 0 && episodes.some(e => e.id === p.episodeId));
    return episodes.find(ep => ep.id === unfinished?.episodeId) || episodes.find(ep => !A.state.progress(anime.id, ep.id)?.seen) || episodes[0];
  }
  function startPlayer(anime, episode, episodes) { A.player.open(anime, episode, episodes, () => detail(anime)); }
  function renderActions(where, anime, episodes) {
    where.replaceChildren();
    if (episodes.length) {
      const ep = resumeEpisode(anime, episodes), p = A.state.progress(anime.id, ep.id);
      where.append(button(`${p?.position && !p.seen ? 'Resume' : 'Watch'} episode ${ep.id}`, () => startPlayer(anime, ep, episodes), 'primary'));
    }
    if (!A.state.get(anime.id)) where.append(button('Add to library', () => { A.state.add(anime); renderActions(where, anime, episodes); A.toast('Added to your library'); }, 'subtle'));
    else {
      where.append(button(A.state.get(anime.id).category, () => A.openModal('Move to a shelf', body => {
        const list = el('div', 'modal-list');
        for (const category of ['Watching', 'Planned', 'Completed']) list.append(button(category, () => {
          A.state.category(anime.id, category); A.closeModal(); renderActions(where, anime, episodes); A.nav.first(where);
        }, A.state.get(anime.id).category === category ? 'selected' : ''));
        body.append(list); body.append(button('Cancel', A.closeModal, 'subtle load-more'));
      }), 'subtle'));
      where.append(button('Remove from library', () => confirm('Remove this title?', 'Your watch progress will be kept.', () => {
        A.state.remove(anime.id); renderActions(where, anime, episodes); A.nav.first(where);
      }), 'subtle'));
    }
  }
  function renderEpisodes(where, anime, episodes) {
    where.replaceChildren();
    const head = el('div', 'section-line row-header'); head.append(el('h2', '', 'Episodes'), el('p', '', `${episodes.length} available`)); where.append(head);
    if (!episodes.length) { where.append(el('p', '', 'The source has no episodes for this title yet.')); return; }
    const list = el('div', 'episodes');
    for (const ep of episodes) {
      const p = A.state.progress(anime.id, ep.id), row = el('div', 'episode-row' + (p?.seen ? ' seen' : ''));
      const play = button('', () => startPlayer(currentAnime, ep, episodes), 'episode-play'); play.dataset.episode = ep.id;
      const copy = el('div', 'episode-copy'); copy.append(el('span', 'episode-title', ep.title),
        el('span', 'episode-state', p?.seen ? 'Watched' : p?.position ? `${duration(p.position)} watched · resume available` : 'Ready to watch'));
      play.append(el('span', 'episode-num', ep.id), copy);
      const mark = button(p?.seen ? 'Watched' : 'Mark watched', () => {
        A.state.mark(currentAnime, ep, !A.state.progress(anime.id, ep.id)?.seen); renderEpisodes(where, currentAnime, episodes);
        A.nav.focus(where.querySelector(`[data-mark="${ep.id}"]`));
      }, 'episode-mark'); mark.dataset.mark = ep.id; row.append(play, mark); list.append(row);
    }
    where.append(list);
  }
  function confirm(title, text, action) {
    A.openModal(title, body => {
      body.append(el('p', '', text)); const buttons = el('div', 'modal-actions');
      buttons.append(button('Cancel', A.closeModal, 'subtle'), button('Confirm', () => { A.closeModal(); action(); }, 'primary')); body.append(buttons);
    });
  }
  function settings() {
    begin('settings'); header('MAKE IT YOURS', 'A comfortable watch.', 'Language, playback, and your saved library.');
    const preferences = el('section', 'settings-block'); preferences.append(el('h2', '', 'Watching'));
    function select(label, note, key, choices, parse = value => value) {
      const row = el('div', 'setting-row'), text = el('div'); text.append(el('span', 'setting-label', label), el('p', '', note));
      const current = String(A.state.settings()[key]);
      if (!choices.some(([value]) => value === current)) choices = [...choices, [current, current + 'p']];
      const nameOf = value => (choices.find(([v]) => v === value) || [value, value])[1];
      const field = el('button', 'select-field'); field.type = 'button';
      field.setAttribute('aria-label', label); field.setAttribute('aria-haspopup', 'listbox'); field.dataset.value = current;
      const shown = el('span', 'select-value', nameOf(current)); field.append(shown);
      field.onclick = () => A.openDropdown(field, choices.map(([value, name]) => ({ value, label: name, selected: value === field.dataset.value })), value => {
        try { A.state.setting(key, parse(value)); field.dataset.value = value; shown.textContent = nameOf(value); A.toast('Preference saved'); } catch (e) { A.toast(e.message); }
      });
      row.append(text, field); preferences.append(row);
    }
    select('Title language', 'Use English titles when the source provides them.', 'title', [['romaji', 'Romaji'], ['english', 'English']]);
    select('Subtitle language', 'You can change this during an episode.', 'subtitle', [['off', 'Off'], ['en-US', 'English'], ['ru-RU', 'Русский'], ['ar-ME', 'العربية'], ['de-DE', 'Deutsch'], ['es-ES', 'Español'], ['es-LA', 'Español (Latin America)'], ['fr-FR', 'Français'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)']]);
    select('Subtitle size', 'You can also change it from the Subtitles menu during an episode.', 'subtitleSize', [['75', 'Small'], ['100', 'Medium'], ['125', 'Large'], ['150', 'Extra large'], ['175', 'Huge']], Number);
    select('Video player', 'The TV\'s built-in player is a fallback for streams without sound or that fail. It cannot switch quality.', 'engine', [['shaka', 'AniShelf player'], ['native', 'TV built-in player']]);
    select('Video quality', 'Automatic adapts to your connection. A fixed choice uses that height or the next lower one.', 'quality', [['auto', 'Automatic'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']]);
    select('Audio language', 'Used when an episode offers more than one audio track.', 'audio', [['ja', '日本語 (Japanese)'], ['en', 'English'], ['', 'Source default']]);
    select('Opening and ending', 'Times come from the AniSkip community database (api.aniskip.com), matched by MyAnimeList ID.', 'skip', [['button', 'Show a skip button'], ['auto', 'Skip automatically'], ['off', 'Off (no AniSkip lookups)']]);
    select('Skip intro length', 'The red button jumps this far when no opening times are known.', 'introLength', [['60', '60 sec'], ['75', '75 sec'], ['85', '85 sec'], ['90', '90 sec'], ['100', '100 sec'], ['120', '120 sec']], Number);
    const autoRow = el('div', 'setting-row'), label = el('div'); label.append(el('span', 'setting-label', 'Play the next episode'), el('p', '', 'Continue automatically when an episode ends.'));
    autoRow.append(label, button(A.state.settings().autoNext ? 'On' : 'Off', () => { A.state.setting('autoNext', !A.state.settings().autoNext); settings(); }, 'subtle')); preferences.append(autoRow); content.append(preferences);
    const backup = el('section', 'settings-block'); backup.append(el('h2', '', 'Your library'), el('p', '', 'Import or export an AniShelf JSON backup. Aniyomi backups can be converted with the tool included in the source package. File selection depends on the TV browser.'));
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    file.onchange = async () => {
      const selected = file.files[0]; if (!selected) return;
      try {
        if (selected.size > 15 * 1024 * 1024) throw new Error('Backup is too large.');
        const parsed = JSON.parse(await selected.text()); A.state.validate(parsed);
        confirm('Merge this library?', 'Saved titles will be added. Existing titles stay in place; newer episode progress wins.', () => A.toast(`${A.state.import(parsed)} titles processed`));
      } catch (e) { A.toast(e.message); }
      file.value = '';
    };
    const actions = el('div', 'actions'); actions.append(button('Import backup', () => file.click(), 'subtle'), button('Export backup', () => {
      const url = URL.createObjectURL(new Blob([A.state.export()], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'anishelf-library.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      A.toast('Backup requested. Some TV browsers do not support file downloads.');
    }, 'subtle')); backup.append(actions, file); content.append(backup);
    const about = el('section', 'settings-block'); about.append(el('h2', '', 'AniShelf TV · 0.3.2'), el('p', '', 'An unofficial adaptation of Aniyomi for webOS, starting with AnimeOnsen. This is an experimental build, not an official Aniyomi release.'));
    about.append(el('p', 'technical-note', 'AnimeOnsen browsing, episodes, library, history, subtitles, DASH/HLS playback with quality and audio selection, and AniSkip opening/ending skips. Android extension APKs, manga, downloads and tracker sync are not implemented. AnimeOnsen may require browser verification on some networks.'));
    about.append(button('Verify AnimeOnsen access', verifySource, 'subtle load-more'));
    about.append(button('Connection details', async () => {
      let text;
      // The last episode's playback readout (codecs, decoded sound) helps diagnose silent streams.
      try { text = JSON.stringify({ ...(await A.api.call('status')), playback: A.player.details() }, null, 2); } catch (e) { text = e.message; }
      A.openModal('Connection details', body => { body.append(el('pre', 'code-box', text), button('Close', A.closeModal, 'primary load-more')); });
    }, 'subtle load-more')); content.append(about); firstContent();
  }
  A.back = () => {
    const previous = history.pop();
    if (previous) {
      const render = previous.route === 'detail' ? detail(previous.anime) : navigate(previous.route, false);
      Promise.resolve(render).then(() => { content.scrollTop = previous.scroll; });
    } else if (route !== 'browse') navigate('browse', false);
    else confirm('Close AniShelf?', 'Your library and watch progress are saved.', () => window.close());
  };
  function navigate(name, clear = true) {
    if (clear) history = [];
    if (name === 'library') return library();
    if (name === 'history') return showHistory();
    if (name === 'settings') return settings();
    return browse(false);
  }
  for (const nav of document.querySelectorAll('[data-route]')) nav.onclick = () => navigate(nav.dataset.route);
  async function start() {
    // The service returns the window here after AnimeOnsen's browser check.
    const verification = (location.hash.match(/^#cf=(\w+)$/) || [])[1];
    if (verification) window.history.replaceState(null, '', location.pathname + location.search); // `history` here is the in-app back stack
    try {
      const response = await fetch('seed-library.json');
      if (response.ok) {
        const seed = await response.json();
        if (seed.library && Object.keys(seed.library).length) A.state.seed(seed);
      }
    } catch (_) {}
    if (A.state.list().length && verification !== 'verified') library(); else browse();
    if (A.storageWarning) A.toast(A.storageWarning);
    const outcomes = { verified: 'AnimeOnsen check passed.', timeout: 'The AnimeOnsen check timed out. You can try again.' };
    if (outcomes[verification]) A.toast(outcomes[verification]);
  }
  start();
})();
