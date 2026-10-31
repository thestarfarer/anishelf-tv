# Validation — AniShelf TV 0.3.0

Status: **experimental build, not a completed or hardware-verified Aniyomi port**.

## Changes in 0.3.0

- **Verify with AnimeOnsen.** When a request is answered with Cloudflare's
  browser check (`cf-mitigated: challenge`), Browse and Settings offer to open
  AnimeOnsen's check in AniShelf's own window. The service drives that window
  through the TV's developer-app inspector (`127.0.0.1:9998`). It reads the
  `animeonsen.xyz` cookies once a new `cf_clearance` appears, and returns the
  window to AniShelf (`#cf=verified`, or `#cf=timeout` after three minutes).
  Requests to AnimeOnsen hosts then send those cookies with the browser's user
  agent. A challenged request re-reads the cookie from the browser once (for
  example after a service restart) before reporting the challenge.
- Research behind the design (2026-10-31): the challenge page sends
  `X-Frame-Options: SAMEORIGIN`, so it cannot be framed. LG enforces CORS for
  packaged apps, and the undocumented `useCORSWhitelist` needs an LG signature,
  so the requests cannot move into the page. Developer-installed apps are
  inspectable on port 9998 (webosbrew documentation).
- A minimal DevTools client (`service/cdp.js`) because Node 16 has no WebSocket.
- Fixed while testing: `app.js` shadowed `window.history` with its back stack.

## Changes in 0.2.1

Two bugs found in a review of 0.2.0, both reproduced before fixing:

- **Episode switching could corrupt watched progress.** `open()` switched to the
  new episode before the previous video finished unloading; that video's `pause`
  event then saved its position against the new episode. Switching at 29/30 s
  marked the untouched next episode as watched (reproduced with a delayed Shaka
  unload). Progress recording is now suspended from the start of a switch until
  the new stream has loaded, and an `ended` event from the outgoing video no
  longer marks or advances the incoming one.
- **Valid DASH manifests could fail.** The regex rewrite ignored single-quoted
  attributes and resolved host-relative paths against the manifest's host even
  when a `<BaseURL>` moved them to another CDN. `service/dash.js` now scans the
  XML (both quote styles, comments, CDATA, entities, namespace prefixes), follows
  the DASH BaseURL chain per element, rewrites only URL-bearing attributes on the
  elements that define them (so AdaptationSet's boolean `bitstreamSwitching` is
  left alone), leaves `urn:`/`data:` values alone, resolves `..` paths upstream,
  and removes `Location`/`PatchLocation`. The rest of the manifest is preserved
  byte for byte. One 0.2.0 test had encoded the wrong host resolution and was
  corrected.

## Changes since 0.1.0

- **DASH playback.** AnimeOnsen serves `.mpd` streams (confirmed independently by
  Manatan PR #286, April 2026, which played the same AnimeOnsen extension through
  dash.js). 0.1.0 rejected DASH in both the service and the player. 0.2.0 bundles
  Shaka Player 5.3.3 and routes manifests and segment templates through the
  loopback helper. Absolute/host-relative manifest URLs are rerouted, `<Location>`
  is dropped, and redirected manifests send the player to the redirected route.
- Video quality and audio-track selection, with remembered preferences.
- Opening/ending/recap skipping from AniSkip (by MyAnimeList ID), as a button or
  automatic, plus a fixed-length intro skip (85 s default) when no times exist.
- Backup converter: episode `lastModifiedAt` is seconds in Aniyomi (`episodes.sq`
  uses `strftime('%s')`); it was read as milliseconds and dated entries to 1970.
- Media connections no longer hit a 20-second idle timeout while playback is paused.
- Cancelled requests (seeking, leaving a page) no longer overwrite the error
  shown in Settings → Connection details.
- Left from the page content returns to the active sidebar entry.
- The UI test harness was fixed: it polls from Node, so the app's
  Content-Security-Policy stays enforced; it no longer depends on scroll position
  or on a search that a reload had cleared.

## Passed

`npm test`: **28 tests passed** (the 5 new clearance tests also pass on Node
16.20.2), adding to 0.1.0's coverage:

- 0.3.0: the DevTools client (loopback-only connection despite the URL host the
  inspector reports, 70 KB fragmented replies, ping/pong, error replies, missing
  inspector); verification outcomes (verified, timeout, cancelled), the return
  navigation, cookie domain/expiry/host-only matching, user-agent binding, and
  the single re-read-and-retry for API and media requests.

- DASH origin route: manifest, init and media segments served; unknown routes 404;
  private addresses rejected.
- DASH manifest rewriting (absolute BaseURL, host-relative and absolute segment
  templates, `&amp;` handling, `<Location>` removal) and redirected manifests (307).
- AniSkip parsing, filtering, caching, 404 = no times, input validation; a failed
  AniSkip lookup never becomes the source error.
- Cancelled media requests do not set the reported source error.
- Converter: second-based `lastModifiedAt` becomes milliseconds.
- 0.2.1: single-quoted attributes, host-relative paths under a CDN-changing
  BaseURL, comments/CDATA/entities, `urn:`/`data:` values, `..` paths, malformed
  XML rejection, and a served CDN-switch manifest whose segments route correctly.

`npm run test:ui` in Chromium 1208 (headless, Playwright 1.52): **19 checks
passed**, with the app's Content-Security-Policy enforced and no violations.
`tests/verify-ui.cjs` adds **6 checks**. It uses Chromium's real DevTools port
and a local check page under `www.animeonsen.xyz` (host-mapped to 127.0.0.1)
that sets an HttpOnly domain cookie when clicked. The real adapter only gets
data with that cookie. Checked: the challenged Browse offers verification, the
window opens the check page, it returns by itself after the click, requests
carry the cookie and the browser's user agent, Connection details show the
clearance, and after a simulated service restart the cookie is re-read without
asking again. 0.2.1 checks:

- 0.2.1: switching to the next episode at 29/30 s during a deliberately slowed
  unload leaves the next episode unwatched; a DASH episode whose manifest
  switches CDN via BaseURL with single-quoted, host-relative templates plays.

- Synthetic DASH episode (360p/180p H.264, Japanese/English AAC) plays through
  Shaka with converted SRT subtitles, preferring Japanese audio.
- AniSkip skip button appears during the opening and jumps past it; automatic
  skipping works on a progressive MP4 episode.
- Quality menu switches to fixed 180p; audio menu switches Japanese → English;
  both preferences persist and apply when the episode is reopened at its saved
  position.
- Catalog, pagination, D-pad movement, search, library shelves, watched state,
  history, reload persistence, settings, diagnostics, and 1920×1080 / 1280×720
  layouts (including all player controls) without horizontal overflow.

Live checks from the build machine on 2026-10-31:

- `api.aniskip.com` answered through the service's own network layer (HTTPS,
  host allow-list, public-address DNS check) with real opening/ending times.
- Every AnimeOnsen host (`www`, `auth`, `api`, `search`, `cdn`) answered HTTP 403
  with `cf-mitigated: challenge`. The app shows: "AnimeOnsen requires browser
  verification on this connection. This TV build cannot complete that challenge."

The package was rebuilt with LG's CLI and `npm run verify` confirmed that every
packaged app/service file is byte-identical to the source tree.

## Not verified

- **The verification on the TV:** whether webOS 25 exposes the inspector to the
  jailed service on 127.0.0.1:9998 for this app, whether WAM allows the app
  window to navigate to AnimeOnsen and back, and whether Cloudflare accepts the
  cookie from the service (it is sent with the browser's user agent but not the
  browser's TLS fingerprint).
- **Real AnimeOnsen browsing/playback.** The build machine is a datacenter IP and
  was challenged on every host. The real manifests' codecs, segment layout and
  CDN header requirements have not been observed. The service sends the same
  headers as the upstream extension (User-Agent, Referer, Origin), which is all
  Manatan needed for the CDN.
- **LG C2 hardware:** installation, jailed-service startup, Luna subscription
  lifecycle, Shaka/Media Source on webOS 25, codec support for AnimeOnsen's
  streams, external-subtitle timing, colour-key delivery, Magic Remote focus,
  standby/resume, and native exit behaviour.
- Independent security review and performance on a large library.

## First hardware check

1. Install the IPK with webOS Dev Manager and launch AniShelf TV.
2. Check whether Browse loads. If it fails, note the exact message in
   Settings → Connection details. A "browser verification" message means
   Cloudflare challenges the TV's connection too.
3. If browsing works, open a title and an episode. Check that it plays, and
   that Quality (blue) lists more than one rendition.
4. Test pause, seek, subtitles (yellow), audio (green), skipping (red / the Skip
   opening button), Back, next episode, and reopening an episode to resume.
5. Close and reopen the app and check the library and watched state.

Uninstalling AniShelf does not require undoing a Home-screen modification or a
boot hook, because this package installs neither. Preserve a library backup
before uninstalling if you want to keep its data.
