(function () {
  'use strict';
  const A = window.AniShelf = window.AniShelf || {};
  const KEY = 'anishelf.state.v1';
  const defaults = () => ({ version: 1, library: {}, progress: {}, settings: {
    title: 'romaji', subtitle: 'en-US', autoNext: false,
  }, importedSeed: false });
  function safeId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(value) &&
      !['.', '..', '__proto__', 'prototype', 'constructor'].includes(value);
  }
  function entry(item) {
    if (!item || !safeId(item.id)) throw new Error('Invalid title in library data.');
    return { id: item.id, source: 'animeonsen', title: String(item.title || item.id).slice(0, 500),
      romaji: String(item.romaji || '').slice(0, 500), english: String(item.english || '').slice(0, 500),
      description: String(item.description || '').slice(0, 10000),
      genres: Array.isArray(item.genres) ? item.genres.slice(0, 50).map(x => String(x).slice(0, 100)) : [],
      status: String(item.status || ''), score: Number(item.score) || null,
      category: ['Watching', 'Planned', 'Completed'].includes(item.category) ? item.category : 'Watching',
      addedAt: Number(item.addedAt) || Date.now() };
  }
  function validate(value) {
    if (!value || value.version !== 1 || typeof value.library !== 'object' || !value.library) {
      throw new Error('This is not an AniShelf library backup.');
    }
    const result = defaults();
    const items = Object.values(value.library);
    if (items.length > 5000) throw new Error('This backup contains too many titles.');
    for (const item of items) { const clean = entry(item); result.library[clean.id] = clean; }
    const records = Object.values(value.progress || {});
    if (records.length > 60000) throw new Error('This backup contains too many episodes.');
    for (const p of records) {
      if (!p || !safeId(p.animeId) || !safeId(p.episodeId)) continue;
      const key = p.animeId + '/' + p.episodeId;
      result.progress[key] = { animeId: p.animeId, episodeId: p.episodeId,
        episodeTitle: String(p.episodeTitle || '').slice(0, 500), animeTitle: String(p.animeTitle || '').slice(0, 500),
        position: Math.max(0, Math.min(1e7, Number(p.position) || 0)),
        duration: Math.max(0, Math.min(1e7, Number(p.duration) || 0)),
        seen: p.seen === true, updatedAt: Math.max(0, Number(p.updatedAt) || 0) };
    }
    if (value.settings) {
      result.settings.title = value.settings.title === 'english' ? 'english' : 'romaji';
      result.settings.subtitle = typeof value.settings.subtitle === 'string' ? value.settings.subtitle.slice(0, 30) : 'en-US';
      result.settings.autoNext = value.settings.autoNext === true;
    }
    result.importedSeed = value.importedSeed === true;
    return result;
  }
  let data;
  try { const raw = localStorage.getItem(KEY); data = raw ? validate(JSON.parse(raw)) : defaults(); }
  catch (_) { data = defaults(); A.storageWarning = 'Saved library could not be read. Your stored data has not been overwritten.'; }
  function update(fn) {
    const next = JSON.parse(JSON.stringify(data)); fn(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); }
    catch (_) { throw new Error('TV storage is full or unavailable. This change could not be saved.'); }
    data = next;
  }
  A.state = {
    data: () => data,
    settings: () => data.settings,
    get: id => data.library[id],
    list: () => Object.values(data.library),
    progress: (anime, ep) => data.progress[anime + '/' + ep],
    history: () => Object.values(data.progress).filter(p => p.updatedAt > 0).sort((a, b) => b.updatedAt - a.updatedAt),
    add: item => update(d => { d.library[item.id] = entry(item); }),
    remove: id => update(d => { delete d.library[id]; }),
    category: (id, category) => update(d => { if (d.library[id]) d.library[id].category = category; }),
    setting: (name, value) => update(d => { d.settings[name] = value; }),
    record: (anime, ep, position, duration, seen) => update(d => {
      const old = d.progress[anime.id + '/' + ep.id];
      d.progress[anime.id + '/' + ep.id] = { animeId: anime.id, animeTitle: anime.title, episodeId: ep.id,
        episodeTitle: ep.title, position: Number.isFinite(position) ? Math.max(0, position) : (old?.position || 0),
        duration: Number.isFinite(duration) ? Math.max(0, duration) : (old?.duration || 0),
        seen: typeof seen === 'boolean' ? seen : old?.seen || false, updatedAt: Date.now() };
    }),
    mark: (anime, ep, seen) => update(d => {
      const old = d.progress[anime.id + '/' + ep.id] || {};
      d.progress[anime.id + '/' + ep.id] = { ...old, animeId: anime.id, animeTitle: anime.title,
        episodeId: ep.id, episodeTitle: ep.title, seen, position: seen ? old.duration || 0 : 0,
        duration: old.duration || 0, updatedAt: Date.now() };
    }),
    import: value => {
      const incoming = validate(value);
      update(d => {
        for (const [key, item] of Object.entries(incoming.library)) if (!d.library[key]) d.library[key] = item;
        for (const [key, p] of Object.entries(incoming.progress)) {
          const previous = d.progress[key];
          if (!previous || p.updatedAt > previous.updatedAt) d.progress[key] = p;
        }
      });
      return Object.keys(incoming.library).length;
    },
    seed: value => {
      if (data.importedSeed) return;
      A.state.import(value); update(d => { d.importedSeed = true; });
    },
    export: () => JSON.stringify(data, null, 2), validate, safeId,
  };
})();
