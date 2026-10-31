(function () {
  'use strict';
  const A = window.AniShelf;
  let base, connecting, bridge, verifyBridge;
  async function connect() {
    if (base) return base;
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      if (typeof window.PalmServiceBridge === 'function') {
        const timer = setTimeout(() => { bridge?.cancel(); reject(new Error('The TV source service did not respond. Reinstall the package including its service.')); }, 15000);
        bridge = new window.PalmServiceBridge();
        bridge.onservicecallback = raw => {
          clearTimeout(timer);
          try {
            const message = JSON.parse(raw);
            if (!message.returnValue || !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(message.base)) {
              throw new Error(message.errorText || 'The source service could not start.');
            }
            base = message.base; resolve(base);
          } catch (e) { reject(e); }
        };
        // The user agent is what a Cloudflare clearance from this browser is bound to.
        bridge.call('luna://com.homebrew.anishelf.source/session', JSON.stringify({ subscribe: true, userAgent: navigator.userAgent }));
      } else {
        // This endpoint exists only in the optional desktop development server.
        fetch('/__session').then(r => { if (!r.ok) throw new Error('Open the installed TV app or start the supplied development server.'); return r.json(); })
          .then(data => { base = data.base; resolve(base); }).catch(reject);
      }
    });
    try { return await connecting; } finally { connecting = undefined; }
  }
  async function call(method, params = {}, signal) {
    await connect();
    const query = new URLSearchParams({ ...params, title: A.state.settings().title });
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    if (signal?.aborted) timeout.abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => timeout.abort(), 55000);
    try {
      const response = await fetch(base + '/api/' + method + '?' + query.toString(), { signal: timeout.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) { const failure = new Error(result.error || 'The source request failed.'); failure.code = result.code; throw failure; }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error instanceof TypeError) { base = undefined; bridge?.cancel(); throw new Error('The local source service disconnected. Please retry.'); }
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  // Starts AnimeOnsen's browser check in this window. The service brings the app back afterwards.
  function verify() {
    const appUrl = location.href.split('#')[0], userAgent = navigator.userAgent;
    if (typeof window.PalmServiceBridge !== 'function') {
      // This endpoint exists only in the optional desktop development server.
      return fetch('/__verify?' + new URLSearchParams({ appUrl, userAgent }), { cache: 'no-store' }).then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.started) throw new Error(data.error || 'Verification could not start.');
        return data;
      });
    }
    return new Promise((resolve, reject) => {
      verifyBridge = new window.PalmServiceBridge();
      const timer = setTimeout(() => reject(new Error('The TV source service did not respond.')), 15000);
      verifyBridge.onservicecallback = raw => {
        clearTimeout(timer);
        try {
          const message = JSON.parse(raw);
          if (message.returnValue) resolve(message); else reject(new Error(message.errorText || 'Verification could not start.'));
        } catch (e) { reject(e); }
      };
      verifyBridge.call('luna://com.homebrew.anishelf.source/verify', JSON.stringify({ appUrl, userAgent }));
    });
  }
  A.api = { call, connect, verify };
  window.addEventListener('pagehide', () => bridge?.cancel());
})();
