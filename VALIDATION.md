# Validation — AniShelf TV 0.3.3

Status: **experimental build, not a completed or hardware-verified Aniyomi port**.

## Changes in 0.3.3

- The TV's on-screen keyboard: Enter did not close it and pressing Search opened
  it, because after a search focus returned to the text field and webOS opens its
  keyboard whenever a text field has focus. The remote now lands on a box around
  the field (OK starts typing); Enter submits, leaves the field and focuses the
  first result; Back while typing closes the keyboard without leaving Browse.
- Opening Browse no longer focuses the search box (it was drawn "selected" with a
  double outline). Focus lands on the first title; a reached search box shows a
  single border, as while typing. Results never take focus from someone typing.
- README: a Browse screenshot captured on the LG C2, the AI-generated warning and
  the one tested TV.

## Changes in 0.3.2

- Sound on the TV works: the 0.3.1 "no sound" report was the TV's audio output
  being switched off. The always-available Audio menu stays (track choice, the
  format/decoded-sound readout and the built-in-player fallback are still useful
  with a single track).
- The sidebar icons were font symbols (`▤ ⌕ ◷ ≡`); the TV font has no `⌕`/`◷`
  (drawn as boxes) and draws the others as bare lines. They are inline SVG
  icons now (library, magnifier, clock, gear). The `−` minus sign in "-10 sec"
  is now an ASCII hyphen for the same reason. The browser suite checks that the
  menu icons are drawn shapes.

## Changes in 0.3.1

First TV report (LG C2, webOS 25): browsing and video playback work; no sound.
Fixed or addressed:

- **No sound.** The cause is not known yet (the stream's audio format cannot be
  fetched from the build machine). The Audio button is now always available; its
  menu shows the audio format, whether the TV's Media Source supports it, and how
  much sound has been decoded, and offers the TV's built-in player (webOS has basic
  on-demand DASH support) as a fallback, remembered in Settings → Video player.
  Track buttons refresh once the video has loaded, and the element is unmuted
  defensively. Connection details include the readout of the last episode.
- The search field lost focus (closing the TV keyboard) when the Magic Remote
  pointer crossed a button; pointer focus now never leaves a text field.
- Subtitle size: Small to Huge (75–175 %), in Settings and the Subtitles menu.
- The TV's fallback font draws `…` as centred dots: every ellipsis (text, CSS
  truncation, line clamps) and curly apostrophe is gone.
- Settings dropdowns are a custom control: the arrow sits clear of the border,
  and the list opens as a rounded panel anchored to its field, remote-navigable.

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

`npm test`: **28 tests passed** (the 5 clearance tests also pass on Node 16.20.2;
0.3.1 updates the interface test for the dropdown, subtitle size and the absence
of ellipsis glyphs), adding to 0.1.0's coverage:

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

`npm run test:ui` in Chromium 1208 (headless, Playwright 1.52): **28 checks
passed** (0.3.3 adds four search-box checks: Enter submits and leaves the field,
Search does not focus it, OK starts and Back stops typing, and Browse opens dim
on the first title; 0.3.2 adds the drawn-menu-icon check; 0.3.1 adds: pointer focus keeps the search field, anchored rounded
dropdowns, subtitle size from the Subtitles menu, switching to the TV's built-in
player and back from the Audio menu, and the playback readout in Connection details), with the app's Content-Security-Policy enforced and no violations.
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

## Verified on the TV

On the LG OLED55C2RLA (webOS 25, firmware 33.22.52): installation, the service,
AnimeOnsen browsing (no Cloudflare challenge on a home connection), and DASH
episode playback with video and sound through Shaka Player.

## Not verified

- **The in-app Cloudflare check** on a real challenge (the TV was not challenged).
- Colour-key delivery, standby/resume and exit behaviour, other TV models and
  webOS versions, an independent security review, and performance on a large
  library.

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
