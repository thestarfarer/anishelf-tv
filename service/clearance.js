'use strict';
// Cloudflare clearance from the TV's own browser engine, the webOS counterpart of Aniyomi's
// WebView cookie handoff.
//
// The person passes AnimeOnsen's check in AniShelf's own window. The service drives that window
// through the TV's inspector for developer apps (127.0.0.1:9998): it opens the site, watches for
// the clearance cookie, reads it (an HttpOnly cookie that page scripts cannot see), and returns
// the window to AniShelf. AnimeOnsen requests then carry those cookies and the same browser user
// agent, which the cookie is bound to. Nothing runs as root and no page script is injected.
const cdp = require('./cdp');
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|один момент|einen moment|un instant|un momento|um momento|しばらくお待ちください/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function domainMatches(host, cookieDomain) {
  const domain = String(cookieDomain || '').toLowerCase();
  if (!domain) return false;
  return domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
}
class Clearance {
  constructor(options = {}) {
    this.port = options.port || 9998;
    this.domain = options.domain || 'animeonsen.xyz';
    this.site = options.site || `https://www.${this.domain}/`;
    this.cookieUrls = options.cookieUrls || [this.site, `https://${this.domain}/`,
      ...['api', 'auth', 'search', 'cdn'].map(host => `https://${host}.${this.domain}/`)];
    this.isAppUrl = options.isAppUrl || (url => /^file:\/\/\/.+\/com\.homebrew\.anishelf\/index\.html$/.test(String(url).split(/[?#]/)[0]));
    this.cdp = options.cdp || cdp;
    this.now = options.now || Date.now;
    this.interval = options.interval || 1500;
    this.cookies = []; this.userAgent = null; this.running = null; this.lastRefresh = 0; this.lastOutcome = null;
  }
  adoptUserAgent(value) {
    if (typeof value === 'string' && value.length > 10 && value.length < 512 && /^[\x20-\x7e]+$/.test(value)) this.userAgent = value;
  }
  onSite(url) {
    try { const host = new URL(url).hostname.toLowerCase(); return host === this.domain || host.endsWith('.' + this.domain); } catch (_) { return false; }
  }
  live() {
    const now = this.now() / 1000;
    return this.cookies.filter(cookie => cookie.session || !(cookie.expires > 0) || cookie.expires > now);
  }
  clearanceValue() { return (this.live().find(cookie => cookie.name === 'cf_clearance') || {}).value || null; }
  active() { return !!this.clearanceValue(); }
  headersFor(url) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return {}; }
    if (!this.userAgent || !(host === this.domain || host.endsWith('.' + this.domain))) return {};
    const cookies = this.live().filter(cookie => domainMatches(host, cookie.domain));
    if (!cookies.some(cookie => cookie.name === 'cf_clearance')) return {};
    return { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'User-Agent': this.userAgent };
  }
  status() {
    const cookie = this.live().find(item => item.name === 'cf_clearance');
    return { active: !!cookie, expires: cookie && cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : null,
      verifying: !!this.running, lastOutcome: this.lastOutcome };
  }
  async appPage() {
    const targets = await this.cdp.list(this.port);
    return targets.find(target => target.type === 'page' && this.isAppUrl(target.url)) || null;
  }
  async read(target) {
    const result = await this.cdp.command(this.port, target, 'Network.getCookies', { urls: this.cookieUrls });
    this.cookies = (result.cookies || []).filter(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' &&
      this.onSite('https://' + String(cookie.domain || '').replace(/^\./, '') + '/'));
    return this.active();
  }
  // The browser keeps the cookie across service restarts. Re-read it when a request is challenged;
  // true only when that produced a different clearance worth retrying with.
  async refresh() {
    if (this.running || this.now() - this.lastRefresh < 10000) return false;
    this.lastRefresh = this.now();
    const before = this.clearanceValue();
    const page = await this.appPage().catch(() => null);
    if (!page) return false;
    await this.read(page).catch(() => false);
    const after = this.clearanceValue();
    return !!after && after !== before;
  }
  async start({ appUrl, userAgent, timeout = 180000 } = {}) {
    if (typeof appUrl !== 'string' || !this.isAppUrl(appUrl)) throw new Error('Verification must return to AniShelf.');
    if (this.running) return { started: true, alreadyRunning: true };
    this.adoptUserAgent(userAgent);
    if (!this.userAgent) throw new Error('The TV browser did not report its user agent.');
    const page = await this.appPage();
    if (!page) throw new Error('The TV inspector does not list AniShelf, so the verification cannot be read.');
    await this.read(page).catch(() => false);
    const previous = this.clearanceValue();
    await this.cdp.command(this.port, page, 'Page.navigate', { url: this.site });
    this.running = this.watch(page, appUrl.split('#')[0], previous, timeout)
      .then(outcome => { this.lastOutcome = outcome; return outcome; })
      .finally(() => { this.running = null; });
    return { started: true };
  }
  async watch(page, appUrl, previous, timeout) {
    const startedAt = this.now(), deadline = startedAt + timeout;
    let outcome = 'timeout', current = page;
    while (this.now() < deadline) {
      await sleep(this.interval);
      let targets;
      try { targets = await this.cdp.list(this.port); } catch (_) { continue; }
      current = targets.find(target => target.id === page.id);
      if (!current) { outcome = 'closed'; break; }
      if (this.isAppUrl(current.url)) { outcome = 'cancelled'; break; }
      if (!this.onSite(current.url)) continue;
      try { await this.read(current); } catch (_) { continue; }
      const value = this.clearanceValue();
      // A new cookie means the check was passed. An unchanged, still-valid cookie counts once the
      // site has loaded without showing a check.
      if (value && (value !== previous || (!CHALLENGE_TITLE.test(current.title || '') && this.now() - startedAt > 4000))) {
        outcome = 'verified'; break;
      }
    }
    if (outcome !== 'closed' && outcome !== 'cancelled') {
      try { await this.cdp.command(this.port, current || page, 'Page.navigate', { url: `${appUrl}#cf=${outcome}` }); } catch (_) {}
    }
    return outcome;
  }
}
// Adds clearance headers to AnimeOnsen requests, and retries once with a re-read cookie when a
// request is challenged (for example after the service restarted).
function withClearance(transport, clearance) {
  if (!clearance) return transport;
  const decorate = (url, options = {}) => ({ ...options, headers: { ...options.headers, ...clearance.headersFor(url) } });
  return async (url, options) => {
    try { return await transport(url, decorate(url, options)); } catch (error) {
      if (error.code !== 'SOURCE_CHALLENGE' || !(await clearance.refresh().catch(() => false))) throw error;
      return transport(url, decorate(url, options));
    }
  };
}
module.exports = { Clearance, withClearance, domainMatches, CHALLENGE_TITLE };
