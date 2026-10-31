'use strict';
const Service = require('webos-service'); // Provided by the TV; never bundled from npm.
const { startBackend } = require('./backend');
const service = new Service('com.homebrew.anishelf.source');
let backendPromise;
const subscribers = new Set();
const session = service.register('session');
session.on('request', async message => {
  if (!message.isSubscription) {
    message.respond({ returnValue: false, errorText: 'A subscription is required for the playback session.' }); return;
  }
  subscribers.add(message.uniqueToken);
  try {
    if (!backendPromise) backendPromise = startBackend();
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
