'use strict';
// Opening/ending times from the community AniSkip database, as used by Aniyomi's player.
const network = require('./network');
const API = 'https://api.aniskip.com/v2/skip-times';
const HOSTS = new Set(['api.aniskip.com']);
const TYPES = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'];
function parse(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('AniSkip returned an unexpected response.'); }
  if (!data || !data.found || !Array.isArray(data.results)) return [];
  return data.results.map(item => ({
    type: String(item.skipType || ''),
    start: Number(item.interval?.startTime), end: Number(item.interval?.endTime),
  })).filter(item => TYPES.includes(item.type) && Number.isFinite(item.start) && Number.isFinite(item.end) &&
    item.start >= 0 && item.end > item.start + 1).sort((a, b) => a.start - b.start);
}
function createSkipTimes(transport = network.request) {
  const cache = new Map();
  return async function skipTimes(malId, episode, length) {
    if (!/^\d{1,9}$/.test(String(malId))) throw new Error('Invalid MyAnimeList ID.');
    if (!Number.isFinite(episode) || episode <= 0 || episode > 100000) throw new Error('Invalid episode number.');
    const seconds = Number.isFinite(length) && length > 0 ? Math.round(length) : 0;
    const key = `${malId}/${episode}/${seconds}`;
    if (cache.has(key)) return cache.get(key);
    const query = TYPES.map(type => 'types[]=' + type).join('&') + '&episodeLength=' + seconds;
    let intervals;
    try {
      intervals = parse(await transport(`${API}/${malId}/${episode}?${query}`, {
        allowedHosts: HOSTS, serviceName: 'AniSkip', timeout: 10000,
        headers: { 'User-Agent': 'AniShelf-TV/0.2.0', Accept: 'application/json' },
      }));
    } catch (error) {
      if (error.status !== 404) throw error;
      intervals = []; // AniSkip answers 404 when nobody has submitted times for this episode.
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, intervals);
    return intervals;
  };
}
module.exports = { createSkipTimes, parse, TYPES };
