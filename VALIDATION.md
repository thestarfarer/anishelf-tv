# Validation — AniShelf TV 0.2.0

Status: **experimental build, not a completed or hardware-verified Aniyomi port**.

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

`npm test`: **20 tests passed**, adding to 0.1.0's coverage:

- DASH origin route: manifest, init and media segments served; unknown routes 404;
  private addresses rejected.
- DASH manifest rewriting (absolute BaseURL, host-relative and absolute segment
  templates, `&amp;` handling, `<Location>` removal) and redirected manifests (307).
- AniSkip parsing, filtering, caching, 404 = no times, input validation; a failed
  AniSkip lookup never becomes the source error.
- Cancelled media requests do not set the reported source error.
- Converter: second-based `lastModifiedAt` becomes milliseconds.

`npm run test:ui` in Chromium 1208 (headless, Playwright 1.52): **17 checks
passed**, with the app's Content-Security-Policy enforced and no violations:

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
