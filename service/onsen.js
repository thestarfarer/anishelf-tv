'use strict';
// Adapted from Yuzono's AnimeOnsen extension (Apache-2.0). See NOTICE.
const network = require('./network');
const SITE = 'https://www.animeonsen.xyz';
const API = 'https://api.animeonsen.xyz/v4';
const SEARCH = 'https://search.animeonsen.xyz';
const HOSTS = new Set(['www.animeonsen.xyz', 'animeonsen.xyz', 'api.animeonsen.xyz',
  'auth.animeonsen.xyz', 'search.animeonsen.xyz']);
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.3',
  Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
  Referer: SITE + '/', Origin: SITE,
  'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site',
};
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(value) || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(value)) {
    throw new Error('Invalid content or episode identifier.');
  }
  return value;
}
function normalize(item, preferred = 'romaji') {
  const contentId = id(String(item.content_id));
  const mal = item.mal_data && typeof item.mal_data === 'object' ? item.mal_data : {};
  return {
    id: contentId, source: 'animeonsen',
    title: (preferred === 'english' ? item.content_title_en : item.content_title) ||
      item.content_title || item.content_title_en || item.content_title_jp || contentId,
    romaji: item.content_title || item.content_title_jp || '', english: item.content_title_en || '',
    image: `${API}/image/210x300/${encodeURIComponent(contentId)}`,
    description: typeof mal.synopsis === 'string' ? mal.synopsis : '',
    genres: (mal.genres || []).map(g => String(g.name)),
    status: mal.status || '', score: mal.mean_score || null,
    studio: (mal.studios || []).map(s => s.name).join(', '),
  };
}
class Onsen {
  constructor(transport = network.request) {
    this.transport = transport;
    this.token = null;
    this.tokenUntil = 0;
    this.tokenPromise = null;
    this.searchToken = null;
    this.searchPromise = null;
  }
  async accessToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenUntil) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      // Public application credentials used by the upstream extension; not a user's account.
      const config = require('./public-client.json');
      const body = new URLSearchParams({ ...config, grant_type: 'client_credentials' }).toString();
      const text = await this.transport('https://auth.animeonsen.xyz/oauth/token', {
        method: 'POST', body, allowedHosts: HOSTS,
        headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const result = JSON.parse(text);
      if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('AnimeOnsen authentication was refused.');
      this.token = result.access_token;
      this.tokenUntil = Date.now() + Math.max(30, Number(result.expires_in) || 300) * 1000 - 15000;
      return this.token;
    })();
    try { return await this.tokenPromise; } finally { this.tokenPromise = null; }
  }
  async api(path) {
    let token;
    try { token = await this.accessToken(); } catch (_) { /* Some endpoints remain public. */ }
    const send = () => this.transport(API + path, { allowedHosts: HOSTS,
      headers: { ...HEADERS, ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
    let text;
    try { text = await send(); } catch (e) {
      if (e.status !== 401) throw e;
      token = await this.accessToken(true);
      text = await send();
    }
    try { return JSON.parse(text); } catch (_) { throw new Error('AnimeOnsen returned a webpage instead of API data.'); }
  }
  async catalog(start = 0, preferred) {
    if (!Number.isInteger(start) || start < 0 || start > 100000) throw new Error('Invalid page.');
    const data = await this.api(`/content/index?start=${start}&limit=30`);
    if (!Array.isArray(data.content)) throw new Error('AnimeOnsen catalog format has changed.');
    return { items: data.content.map(i => normalize(i, preferred)), next: data.cursor?.next?.[0] === true };
  }
  async getSearchToken(force = false) {
    if (!force && this.searchToken) return this.searchToken;
    if (!this.searchPromise) this.searchPromise = this.transport(SITE + '/', { allowedHosts: HOSTS, headers: HEADERS })
      .then(html => {
        const meta = html.match(/<meta\b[^>]*\bname\s*=\s*["']ao-search-token["'][^>]*>/i) ||
          html.match(/<meta\b[^>]*\bcontent\s*=\s*["'][^"']*["'][^>]*\bname\s*=\s*["']ao-search-token["'][^>]*>/i);
        const token = meta && meta[0].match(/\bcontent\s*=\s*["']([^"']+)["']/i);
        if (!token) throw new Error('AnimeOnsen search token was not found. Browse may still work.');
        this.searchToken = token[1];
        return this.searchToken;
      });
    try { return await this.searchPromise; } finally { this.searchPromise = null; }
  }
  async search(query, preferred) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Enter a search of 1–200 characters.');
    let token = await this.getSearchToken();
    const send = () => this.transport(SEARCH + '/indexes/content/search', {
      allowedHosts: HOSTS, method: 'POST', body: JSON.stringify({ q: query.trim() }),
      headers: { ...HEADERS, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    let text;
    try { text = await send(); } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      token = await this.getSearchToken(true); text = await send();
    }
    const data = JSON.parse(text);
    if (!Array.isArray(data.hits)) throw new Error('AnimeOnsen search format has changed.');
    return { items: data.hits.map(i => normalize(i, preferred)), next: false };
  }
  async details(contentId, preferred) { return normalize(await this.api(`/content/${id(contentId)}/extensive`), preferred); }
  async episodes(contentId, preferred = 'romaji') {
    const data = await this.api(`/content/${id(contentId)}/episodes`);
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('AnimeOnsen episode format has changed.');
    return Object.entries(data).map(([number, ep]) => ({
      id: id(number), animeId: contentId, number: Number(number),
      title: (preferred === 'english' ? ep.contentTitle_episode_en : ep.contentTitle_episode_jp) ||
        ep.contentTitle_episode_en || ep.contentTitle_episode_jp || `Episode ${number}`,
    })).sort((a, b) => (a.number - b.number) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  }
  async stream(contentId, episodeId) {
    const data = await this.api(`/content/${id(contentId)}/video/${id(episodeId)}`);
    if (!data.uri || typeof data.uri.stream !== 'string') throw new Error('AnimeOnsen did not return a video.');
    return { url: data.uri.stream, subtitles: Object.entries(data.uri.subtitles || {}).map(([lang, url]) => ({
      lang, url, label: data.metadata?.subtitles?.[lang] || lang,
    })) };
  }
}
module.exports = { Onsen, HEADERS, HOSTS, SITE, API, id, normalize };
