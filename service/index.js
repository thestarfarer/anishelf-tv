'use strict';
const Service = require('webos-service'); // Provided by the TV; never bundled from npm.
const { startBackend } = require('./backend');
const { Clearance } = require('./clearance');
const service = new Service('com.homebrew.anishelf.source');
const clearance = new Clearance();
let backendPromise;
const subscribers = new Set();
const session = service.register('session');
session.on('request', async message => {
  if (!message.isSubscription) {
    message.respond({ returnValue: false, errorText: 'A subscription is required for the playback session.' }); return;
  }
  clearance.adoptUserAgent(message.payload && message.payload.userAgent);
  subscribers.add(message.uniqueToken);
  try {
    if (!backendPromise) backendPromise = startBackend({ clearance });
    const backend = await backendPromise;
    if (subscribers.has(message.uniqueToken)) message.respond({ returnValue: true, subscribed: true, base: backend.base });
  } catch (_) {
    backendPromise = undefined;
    subscribers.delete(message.uniqueToken);
    message.respond({ returnValue: false, errorText: 'The local playback service could not start.' });
  }
});
session.on('cancel', async message => {
  subscribers.delete(message.uniqueToken);
  if (!subscribers.size && backendPromise) {
    const old = backendPromise; backendPromise = undefined;
    try { (await old).close(); } catch (_) {}
  }
});
// Opens AnimeOnsen's check in the app window and brings the app back once it is passed. The app's
// page (and its session subscription) is gone meanwhile, so an activity keeps the service running.
const verify = service.register('verify');
verify.on('request', async message => {
  const payload = message.payload || {};
  let activity = null;
  const release = () => { try { if (activity) service.activityManager.complete(activity, () => {}); } catch (_) {} activity = null; };
  try { service.activityManager.create('com.homebrew.anishelf.verify', created => { activity = created; }); } catch (_) {}
  try {
    const result = await clearance.start({ appUrl: payload.appUrl, userAgent: payload.userAgent });
    if (clearance.running) clearance.running.then(release, release); else release();
    message.respond({ returnValue: true, ...result });
  } catch (error) {
    release();
    message.respond({ returnValue: false, errorText: error.message || 'Verification could not start.' });
  }
});
