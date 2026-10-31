# Validation — AniShelf TV 0.1.0

Status: **experimental first build, not a completed or hardware-verified Aniyomi port**.

## Passed

`npm test`: **13 tests passed** covering:

- Loopback-only listener, session-token requirement, Origin/Host rejection,
  rejected write methods, and opaque media resource IDs.
- HTTPS host validation and rejection of private IP destinations.
- Catalog parsing, API-token deduplication/refresh, independent search-token
  handling, numerical episode ordering, and subtitle metadata.
- HLS playlist/segment/key URL rewriting, byte-range media delivery, and
  SRT/ASS-to-VTT conversion.
- Legacy and modern Aniyomi backup decoding, gzip handling, exact 64-bit source
  IDs, millisecond conversion, skipped sources, and malformed protobuf input.
- DOM integration of catalog pagination, search, details, library categories,
  watched state, settings, serialized persistence, history, and HTTP 403 errors.
- Rendering source titles as text rather than injectable HTML.

All app/service JavaScript passed Node syntax checks. LG's official CLI produced
the install package with both app and service included. The package was opened
and its application/service file bytes compared against the source tree.

## Not verified

- **Real AnimeOnsen browsing/playback:** requests from the development network
  received HTTP 403 with `cf-mitigated: challenge`, including the website, API,
  and OAuth endpoint. This is recorded as a block, not as a passing live test.
- **Rendered browser UI and actual video playback:** a Playwright suite is
  included, but Chromium processes terminated during startup in this runtime.
  The jsdom integration tests do not replace browser rendering or codec tests.
- **LG C2 hardware:** installation, jailed-service startup, Luna subscription
  lifecycle, native HLS decoding, external-subtitle timing, Magic Remote focus,
  LG keyboard behavior, standby/resume, and native exit behavior need a TV test.
- Independent security review, comprehensive source audit, compatibility with
  every current AnimeOnsen API response, and performance on a large library.

The included test video and catalog are synthetic fixtures, not evidence that
AnimeOnsen streams have played successfully. No content-provider account or
user library was used in testing.

## First hardware check

1. Install the IPK with webOS Dev Manager and launch AniShelf TV.
2. Check whether Browse loads. If it fails, capture the exact error from
   Settings → Connection details.
3. If browsing works, search a title, add it to the library, and open an episode.
4. Test pause, seek, subtitle selection, Back, next episode, and reopening the
   same episode to check resume position.
5. Close/reopen the app and verify library and watched state.

Uninstalling AniShelf does not require undoing a Home-screen modification or a
boot hook, because this package installs neither. Preserve a library backup
before uninstalling if you want to keep its data.
