# AniShelf TV — an experimental Aniyomi adaptation

This build (0.2.0) targets the LG OLED55C2RLA running webOS 25 (10.2.1; firmware
33.22.52). It runs entirely on the TV and starts with the **AnimeOnsen** source.
It is an unofficial adaptation, with a new TV interface and a JavaScript port
of the source adapter. It is not the Android APK running inside webOS, and it
does not implement all of Aniyomi.

**Live AnimeOnsen playback is unverified.** On 2026-10-31 every AnimeOnsen host
(website, auth, API, search and CDN) answered the build machine, a datacenter
IP, with a Cloudflare challenge (`cf-mitigated: challenge`). This build does not
solve those challenges. Cloudflare usually treats home connections differently
from datacenters, but that has not been tested from a TV. If Browse shows a
verification error, installing this package has not bypassed it.

AnimeOnsen serves episodes as MPEG-DASH (`.mpd`). Version 0.1.0 refused DASH,
so no episode could have played even without the challenge. 0.2.0 plays DASH and
HLS through Shaka Player.

## Install on your already-rooted C2

1. Download `com.homebrew.anishelf_0.2.0_all.ipk` to your computer.
2. Open [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop)
   and connect using your existing rooted-TV connection.
3. Choose **Apps → Install**, select the `.ipk`, and wait for installation.
   The package includes both the app and its ordinary JavaScript service.
4. Launch **AniShelf TV** from the LG app list.
5. Check **Browse**, open an AnimeOnsen title, and try an episode. If it fails,
   **Settings → Connection details** shows the latest source error.

Use your existing SSH key if Dev Manager needs an SSH connection. This app does
not require Telnet, a root-execution API, a startup hook, or a replacement Home
screen. Do not install LG's official Developer Mode app on a rooted TV;
[webOS Homebrew documents that conflict](https://www.webosbrew.org/pages/sdk-configuration).
No connection to your TV was made while building this package.

## Implemented in this build

- AnimeOnsen catalog pagination, title search, details and episodes.
- Remote and pointer navigation, with a TV layout for 1920×1080 and 1280×720.
- A saved library with Watching, Planned and Completed shelves.
- Watched status, viewing history, and saved playback positions.
- DASH and HLS playback through the bundled Shaka Player (Media Source), plus
  direct MP4. The TV's native player is the fallback for HLS/MP4 if Media Source
  is unavailable.
- Video quality selection: Automatic (adaptive) or a fixed rendition, remembered
  as a preferred height for later episodes.
- Audio track selection when an episode has more than one, with a preferred
  audio language (Japanese by default).
- Opening, ending and recap skipping using AniSkip times matched by MyAnimeList
  ID, as in Aniyomi: a skip button (default) or automatic skipping. Without
  AniSkip times, the Skip intro button and red key jump a configurable length
  (85 seconds by default, as in Aniyomi).
- External VTT, SRT and basic ASS subtitles, including a language selector.
- Optional automatic next episode, off by default.
- AniShelf JSON backup merge/export and an offline Aniyomi backup converter.

Not implemented: Android extension APK loading, other source adapters, manga,
downloads, tracker sync, DRM, Cloudflare challenge solving, the AnimeOnsen genre
filter, advanced ASS styling or simultaneous phone/TV library synchronization. File pickers/downloads depend on the TV web
engine; use the seed-library method below if they are unavailable.

## Remote controls

| Control | Action |
| --- | --- |
| Arrows | Move between controls and titles |
| OK / wheel click | Activate the focused control |
| Back | Close a dialog, leave playback, or return to the previous page |
| Play / Pause | Toggle playback |
| Left / Right with player controls hidden | Seek 10 seconds |
| OK while "Skip opening" is shown | Skip the opening/ending |
| Red during playback | Skip the opening (or the intro length) |
| Green during playback | Audio track selection |
| Yellow during playback | Subtitle selection |
| Blue during playback | Video quality selection |
| Fast-forward / Rewind | Seek 30 seconds |
| Next episode button | Open the next available episode |

The system Home button keeps its usual LG behavior. Leaving the app pauses
video and saves progress. Local app storage holds the library; uninstalling the
app or clearing its data can erase it.

## Bring over an Aniyomi backup

Keep your original backup. The converter does not modify it. On a computer with
Node.js 20 or newer, from this project directory:

```sh
node tools/import-aniyomi.cjs /path/to/backup.proto.gz anishelf-library.json
```

The converter handles modern and legacy gzip/protobuf Aniyomi backups. It
imports **AnimeOnsen** favorites, watched flags, playback position, duration,
and viewing timestamps. Other sources are skipped and counted. Android APKs,
accounts, tracker tokens, custom categories, and extension preferences are not
imported. Positions are converted from Aniyomi's milliseconds to seconds.

To include that library in the TV installer, avoiding the TV file picker:

```sh
npm ci --ignore-scripts
node tools/import-aniyomi.cjs /path/to/backup.proto.gz --seed
npm run package
```

Install the resulting package from `dist/`. The bundled library is merged once
on the first launch with a non-empty seed. Existing titles are kept; newer
episode progress wins. Keep the resulting personalized installer private,
because it now includes your watch library. The supplied public build has an
empty seed.

## Build and test

```sh
npm ci --ignore-scripts
npm test
npx playwright install chromium
npm run test:ui
npm run package
npm run verify
```

`npm run verify` unpacks the built IPK, checks every packaged file against the
source tree, and rewrites `dist/SHA256SUMS.txt` and `dist/source-verification.json`.
`app/vendor/shaka-player.compiled.js` is the unmodified file from the pinned
`shaka-player` npm package; `npm run vendor` copies it again after an update.

`npm run dev` runs a localhost preview with the real source adapter. It is a
development tool, not a required companion server. UI tests instead use
fictional catalog entries and generated test media in `tests/fixtures/`: an
MP4 and a 30-second DASH stream with 360p/180p video and Japanese/English audio
tracks. They never download anime episodes. For an existing Chromium installation,
set `ANISHELF_CHROMIUM` to its executable path before running the UI tests.

The packager preserves JavaScript source without minification. Runtime code
uses Node.js 16 APIs, matching webOS 25's documented service runtime. Build-only
dependencies are locked in `package-lock.json` and excluded from the TV package.
See `VALIDATION.md` for what was actually tested and what still needs hardware.

## Network and permissions

The app's service runs in the ordinary webOS JavaScript service jail. The
frontend calls its own `com.homebrew.anishelf.source/session` method; it never
calls Homebrew's root command service, launches a shell, or changes system
settings. It requests no privileged system API permissions.

Media and API requests go through a helper bound to **127.0.0.1 only**, on a
random port, with a random 256-bit session token. Images, subtitles and HLS
playlists use opaque per-URL IDs. DASH segment templates cannot be listed in
advance, so each approved media origin gets one opaque route that mirrors its
paths. The helper exists while the
app holds a service subscription. It is not accessible to other machines on
your LAN. This is a design restriction, not an independent security audit.

Outbound source requests use HTTPS and normal certificate verification.
Bearer tokens go only to the matching API/search hosts and are not forwarded
across origins. Media hosts must come from AnimeOnsen's API or from manifests it
returned; literal IPs, private-address DNS results, embedded credentials and
nonstandard ports are rejected. The helper does not accept arbitrary URLs or
shell commands from the frontend. There is no telemetry, remote JavaScript
loader, or automatic updater.

Opening/ending skipping asks `api.aniskip.com` for the MyAnimeList ID, episode
number and episode length of what you are watching. Choose **Settings → Opening
and ending → Off** to make no AniSkip requests.

The public application client credentials in `service/public-client.json`
come from the existing open-source AnimeOnsen adapter. They are not credentials
for your Aniyomi account. Source authentication and API formats can change;
those changes may require an updated adapter.

## Provenance and licensing

`NOTICE`, `LICENSE` and `licenses/Aniyomi.txt` record the pinned upstream
revisions and Apache-2.0 notices. The app name and icon differ from Aniyomi's to
avoid suggesting an official release. Relevant references:

- [Aniyomi source](https://github.com/aniyomiorg/aniyomi)
- [AnimeOnsen extension source](https://github.com/yuzono/anime-extensions/tree/d41cdf3a47a5bd7e44cd71d184b6f662d6434d2d/src/all/animeonsen)
- [LG JavaScript services](https://webostv.developer.lge.com/develop/guides/js-service-usage)
- [LG service runtime versions](https://webostv.developer.lge.com/develop/guides/js-service-basics)
