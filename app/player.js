(function () {
  'use strict';
  const A = window.AniShelf;
  const view = document.getElementById('player'), video = document.getElementById('video');
  const controls = document.getElementById('player-controls');
  const loading = document.getElementById('player-loading'), errorBox = document.getElementById('player-error');
  const subtitleLayer = document.getElementById('subtitle-overlay'), seek = document.getElementById('seek');
  const skipButton = document.getElementById('skip-segment'), skipIntroButton = document.getElementById('skip-intro');
  const qualityButton = document.getElementById('quality-button'), audioButton = document.getElementById('audio-button');
  const MIME = { dash: 'application/dash+xml', hls: 'application/x-mpegurl', video: 'video/mp4' };
  const SEGMENT_NAMES = { op: 'opening', 'mixed-op': 'opening', ed: 'ending', 'mixed-ed': 'ending', recap: 'recap' };
  let context = null, generation = 0, pending, hideTimer, lastSave = 0, cues = [], subtitleGeneration = 0;
  let engine = null, engineReady = null, usingEngine = false, skips = [], skipped = new Set(), activeSkip = null;
  function time(value) {
    value = Math.max(0, Number(value) || 0);
    const hours = Math.floor(value / 3600), mins = Math.floor(value / 60) % 60, secs = Math.floor(value % 60);
    return (hours ? hours + ':' + String(mins).padStart(2, '0') : mins) + ':' + String(secs).padStart(2, '0');
  }
  function save() {
    if (!context || !Number.isFinite(video.duration) || video.duration <= 0) return;
    try { A.state.record(context.anime, context.episode, video.currentTime, video.duration,
      video.currentTime / video.duration >= .95 ? true : undefined); }
    catch (e) { A.toast(e.message); }
  }
  function showControls(focus) {
    controls.hidden = false; view.classList.add('controls-visible'); clearTimeout(hideTimer);
    if (focus) A.nav.focus(document.getElementById('toggle-play'));
    if (!video.paused) hideTimer = setTimeout(() => {
      if (!document.getElementById('modal').hidden || video.paused) return;
      controls.hidden = true; view.classList.remove('controls-visible');
      document.activeElement?.blur();
    }, 5000);
  }
  function fail(message) { loading.hidden = true; errorBox.textContent = message; errorBox.hidden = false; showControls(true); }
  function toggle() {
    if (!context || !video.currentSrc) return;
    if (video.paused) video.play().catch(e => { if (e.name !== 'AbortError') fail('Playback could not start. Try the episode again.'); });
    else video.pause();
    showControls();
  }
  function seekBy(seconds) {
    if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration - .1, video.currentTime + seconds));
    showControls();
  }
  function parseVtt(text) {
    const result = [];
    const seconds = stamp => stamp.split(':').reduce((sum, part) => sum * 60 + Number(part.replace(',', '.')), 0);
    for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const index = lines.findIndex(line => line.includes('-->'));
      if (index < 0) continue;
      const [left, right] = lines[index].split('-->');
      const start = seconds(left.trim()), end = seconds(right.trim().split(/\s/)[0]);
      const text = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) result.push({ start, end, text });
    }
    return result;
  }
  async function selectSubtitle(track) {
    const requestId = ++subtitleGeneration;
    cues = []; subtitleLayer.textContent = '';
    if (!track) return;
    try {
      const response = await fetch(track.url, { signal: pending?.signal });
      if (!response.ok) throw new Error('Subtitle download failed.');
      const parsed = parseVtt(await response.text());
      if (requestId === subtitleGeneration && context) {
        cues = parsed;
        if (!cues.length) A.toast('This subtitle file has no readable cues.');
      }
    } catch (e) { if (e.name !== 'AbortError') A.toast('Subtitles could not be loaded. Video can still play.'); }
  }
  function menu(title, options) {
    if (!context) return;
    showControls();
    A.openModal(title, body => {
      const list = document.createElement('div'); list.className = 'modal-list';
      for (const option of options) {
        const button = document.createElement('button'); button.textContent = option.label;
        if (option.note) { const note = document.createElement('span'); note.className = 'track-note'; note.textContent = option.note; button.append(note); }
        if (option.selected) button.className = 'selected';
        button.onclick = () => { A.closeModal(); try { option.action(); } catch (e) { A.toast(e.message); } };
        list.append(button);
      }
      body.append(list);
      const close = document.createElement('button'); close.textContent = 'Close'; close.className = 'subtle';
      close.style.marginTop = '20px'; close.onclick = A.closeModal; body.append(close);
    });
    A.nav.focus(document.querySelector('#modal-body .selected'));
  }
  function remember(name, value) { try { A.state.setting(name, value); } catch (e) { A.toast(e.message); } }
  function subtitleMenu() {
    if (!context) return;
    menu('Subtitles', [{ lang: 'off', label: 'Off' }, ...context.tracks].map(track => ({
      label: track.label, selected: A.state.settings().subtitle === track.lang,
      action: () => { remember('subtitle', track.lang); selectSubtitle(track.lang === 'off' ? null : track); },
    })));
  }

  // Shaka Player handles DASH and HLS through Media Source, which also exposes the qualities and
  // audio tracks inside the manifest. Without Media Source the TV's native player is used.
  function engineSupported() {
    try { return !!window.shaka && window.shaka.Player.isBrowserSupported(); } catch (_) { return false; }
  }
  function getEngine() {
    if (!engineSupported()) return Promise.resolve(null);
    if (!engineReady) engineReady = (async () => {
      window.shaka.polyfill.installAll();
      const player = new window.shaka.Player();
      await player.attach(video);
      player.configure({
        streaming: { bufferingGoal: 30, rebufferingGoal: 2, bufferBehind: 30,
          retryParameters: { maxAttempts: 4, baseDelay: 800, backoffFactor: 2, timeout: 30000 } },
        manifest: { retryParameters: { maxAttempts: 3, baseDelay: 800, backoffFactor: 2, timeout: 30000 } },
      });
      player.addEventListener('error', event => engineFailure(event.detail));
      for (const name of ['trackschanged', 'variantchanged', 'adaptation', 'abrstatuschanged']) player.addEventListener(name, updateTrackButtons);
      engine = player; return player;
    })().catch(error => { engineReady = null; throw error; });
    return engineReady;
  }
  function stopMedia() {
    video.pause();
    if (engine) return engine.unload().catch(() => {});
    video.removeAttribute('src'); video.replaceChildren(); video.load();
    return Promise.resolve();
  }
  async function describeFailure(error) {
    if (!error || typeof error.category !== 'number') {
      return error?.name === 'NotSupportedError' ? 'The TV cannot play this stream or codec.' : error?.message || 'Playback stopped unexpectedly. Try the episode again.';
    }
    if (error.category === 1) {
      // The local service knows why the source request failed (HTTP status, verification wall).
      try { const status = await A.api.call('status'); if (status.lastError?.message) return status.lastError.message; } catch (_) {}
      return 'The stream could not be downloaded. The source may be limiting requests.';
    }
    if (error.code === 4032) return 'The TV does not support the video or audio codecs in this stream.';
    if (error.category === 6) return 'This stream is protected with DRM, which AniShelf does not support.';
    if (error.category === 3) return `The TV could not decode this stream (error ${error.code}).`;
    if (error.category === 4) return `The episode's stream description could not be read (error ${error.code}).`;
    return `Playback stopped (error ${error.code}). Try the episode again.`;
  }
  function interrupted(error) { return error?.name === 'AbortError' || error?.code === 7000 || error?.code === 7001; }
  async function engineFailure(error) {
    if (!context || interrupted(error) || error?.severity === 1) return;
    const requestId = generation, message = await describeFailure(error);
    if (requestId === generation && context) fail(message);
  }
  function videoTracks() {
    if (!engine || !usingEngine) return [];
    const byHeight = new Map();
    for (const track of engine.getVideoTracks()) {
      if (!track.height) continue;
      const known = byHeight.get(track.height);
      if (!known || track.active || (!known.active && track.bandwidth > known.bandwidth)) byHeight.set(track.height, track);
    }
    return Array.from(byHeight.values()).sort((a, b) => b.height - a.height);
  }
  function languageName(code) {
    if (!code || code === 'und') return '';
    try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code; } catch (_) { return code; }
  }
  function audioLabel(track, index) {
    const name = track.label || languageName(track.language) || `Audio ${index + 1}`;
    const channels = track.channelsCount > 2 ? (track.channelsCount === 6 ? ' · 5.1' : ` · ${track.channelsCount} ch`) : '';
    const roles = (track.roles || []).filter(role => role && role !== 'main').join(', ');
    return name + channels + (roles ? ' · ' + roles : '');
  }
  function audioTracks() {
    if (engine && usingEngine) {
      return engine.getAudioTracks().map((track, i) => ({ label: audioLabel(track, i), language: track.language || '',
        active: track.active, select: () => engine.selectAudioTrack(track) }));
    }
    const list = video.audioTracks;
    if (!list || !list.length) return [];
    return Array.from(list).map((track, i) => ({ label: audioLabel({ label: track.label, language: track.language }, i),
      language: track.language || '', active: track.enabled,
      select: () => { for (const other of Array.from(list)) other.enabled = other === track; } }));
  }
  function updateTrackButtons() {
    const tracks = videoTracks(), active = tracks.find(t => t.active);
    const auto = !engine || engine.getConfiguration().abr.enabled;
    qualityButton.disabled = tracks.length < 2;
    qualityButton.textContent = active ? (auto ? `Auto · ${active.height}p` : `${active.height}p`) : 'Quality';
    audioButton.disabled = audioTracks().length < 2;
  }
  function applyQualityPreference() {
    const preference = A.state.settings().quality, tracks = videoTracks();
    if (preference === 'auto' || tracks.length < 2) return;
    const limit = Number(preference);
    const choice = tracks.find(t => t.height <= limit) || tracks[tracks.length - 1];
    engine.configure({ abr: { enabled: false } });
    engine.selectVideoTrack(choice, false);
  }
  function qualityMenu() {
    if (!context) return;
    const tracks = videoTracks();
    if (tracks.length < 2) { A.toast('This stream offers a single quality.'); return; }
    const auto = engine.getConfiguration().abr.enabled, active = tracks.find(t => t.active);
    const mbps = bits => bits ? (bits / 1e6).toFixed(bits < 1e6 ? 2 : 1) + ' Mbps' : '';
    menu('Video quality', [
      { label: 'Automatic', note: auto && active ? `now ${active.height}p` : 'adapts to your connection', selected: auto,
        action: () => { engine.configure({ abr: { enabled: true } }); remember('quality', 'auto'); updateTrackButtons(); } },
      ...tracks.map(track => ({ label: `${track.height}p`, note: mbps(track.bandwidth), selected: !auto && track.active,
        action: () => {
          engine.configure({ abr: { enabled: false } }); engine.selectVideoTrack(track, true);
          remember('quality', String(track.height)); updateTrackButtons();
        } })),
    ]);
  }
  function audioMenu() {
    if (!context) return;
    const tracks = audioTracks();
    if (tracks.length < 2) { A.toast('This episode has a single audio track.'); return; }
    menu('Audio', tracks.map(track => ({ label: track.label, selected: track.active,
      action: () => { track.select(); if (track.language) remember('audio', track.language); setTimeout(updateTrackButtons, 0); } })));
  }

  // Opening/ending times come from AniSkip, matched by MyAnimeList ID like Aniyomi's player.
  async function malIdFor(anime) {
    const known = anime.malId || A.state.get(anime.id)?.malId;
    if (known) return known;
    const full = await A.api.call('details', { id: anime.id }, pending?.signal);
    if (full.malId) { anime.malId = full.malId; try { A.state.remember(anime.id, full.malId); } catch (_) {} }
    return full.malId || null;
  }
  async function loadSkips(requestId) {
    if (A.state.settings().skip === 'off' || !context) return;
    const number = Number(context.episode.number ?? context.episode.id);
    if (!Number.isFinite(number) || number <= 0) return;
    try {
      if (!Number.isFinite(video.duration)) {
        await new Promise(resolve => { video.addEventListener('loadedmetadata', resolve, { once: true }); video.addEventListener('emptied', resolve, { once: true }); });
      }
      if (requestId !== generation) return;
      const malId = await malIdFor(context.anime);
      if (!malId || requestId !== generation) return;
      const length = Number.isFinite(video.duration) ? Math.round(video.duration) : 0;
      const result = await A.api.call('skip', { mal: malId, episode: number, length }, pending?.signal);
      if (requestId !== generation || !context) return;
      skips = result.intervals || []; updateSkip();
    } catch (_) { /* Skipping is a convenience; playback continues without it. */ }
  }
  function skipName(segment) { return SEGMENT_NAMES[segment.type] || 'segment'; }
  function skipTo(segment, announce) {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(segment.end, video.duration - .25);
    if (announce) A.toast(`Skipped the ${skipName(segment)}`);
  }
  function introLength() { return Number(A.state.settings().introLength) || 85; }
  function skipIntro() {
    if (!context) return;
    if (activeSkip) { skipTo(activeSkip, false); updateSkip(); }
    else seekBy(introLength());
  }
  function updateSkip() {
    const mode = A.state.settings().skip, at = video.currentTime;
    const current = context && mode !== 'off' ? skips.find(s => at >= s.start && at < s.end - .5) || null : null;
    if (current && mode === 'auto') {
      const key = current.type + ':' + current.start;
      if (!skipped.has(key)) { skipped.add(key); skipTo(current, true); return; }
    }
    if (current !== activeSkip) {
      activeSkip = current;
      if (!current && document.activeElement === skipButton) document.activeElement.blur();
      skipButton.hidden = !current;
      if (current) skipButton.textContent = `Skip ${skipName(current)}`;
    }
    skipIntroButton.textContent = current ? `Skip ${skipName(current)}` : `Skip ${introLength()} sec`;
  }
  function resetSkips() {
    skips = []; skipped = new Set(); activeSkip = null; skipButton.hidden = true;
    skipIntroButton.textContent = `Skip ${introLength()} sec`;
  }

  async function open(anime, episode, episodes, onClose) {
    if (context) save();
    pending?.abort(); pending = new AbortController();
    const requestId = ++generation, signal = pending.signal;
    cues = []; ++subtitleGeneration; subtitleLayer.textContent = ''; resetSkips();
    const previous = A.state.progress(anime.id, episode.id);
    context = { anime, episode, episodes, onClose, tracks: [], resume: previous && !previous.seen ? previous.position : 0 };
    view.hidden = false; document.getElementById('shell').hidden = true;
    errorBox.hidden = true; loading.hidden = false;
    document.getElementById('player-series').textContent = anime.title;
    document.getElementById('player-episode').textContent = `Episode ${episode.id} · ${episode.title}`;
    document.getElementById('next-episode').disabled = episodes.findIndex(ep => ep.id === episode.id) >= episodes.length - 1;
    usingEngine = false; updateTrackButtons();
    showControls(true);
    try {
      const player = await getEngine().catch(() => null);
      await stopMedia();
      if (requestId !== generation) return;
      const stream = await A.api.call('stream', { id: anime.id, episode: episode.id }, signal);
      if (requestId !== generation) return;
      context.tracks = stream.subtitles;
      const preference = A.state.settings().subtitle;
      if (preference !== 'off') selectSubtitle(stream.subtitles.find(t => t.lang === preference) ||
        stream.subtitles.find(t => t.lang.split('-')[0] === preference.split('-')[0]) || stream.subtitles[0]);
      if (player) {
        const settings = A.state.settings();
        player.configure({ abr: { enabled: settings.quality === 'auto' },
          preferredAudio: settings.audio ? [{ language: settings.audio, role: '', label: '', channelCount: 0, codec: '', spatialAudio: false }] : [] });
        usingEngine = true;
        const start = context.resume > 0 ? context.resume : null; context.resume = 0;
        await player.load(stream.url, start, MIME[stream.format] || MIME.video);
        if (requestId !== generation) return;
        applyQualityPreference(); updateTrackButtons();
      } else if (stream.format === 'dash') {
        throw new Error('This TV web engine lacks Media Source support, which DASH playback needs.');
      } else if (stream.format === 'hls') {
        // An explicit MIME type selects LG's HLS pipeline even for opaque proxy URLs.
        const source = document.createElement('source'); source.src = stream.url;
        source.type = 'application/vnd.apple.mpegurl'; video.append(source); video.load();
      } else video.src = stream.url;
      loadSkips(requestId);
      await video.play();
    } catch (e) {
      if (requestId !== generation || interrupted(e)) return;
      const message = await describeFailure(e);
      if (requestId === generation) fail(message);
    }
  }
  function close() {
    if (!context) return;
    save(); const onClose = context.onClose; context = null; ++generation; ++subtitleGeneration;
    pending?.abort(); pending = null; clearTimeout(hideTimer);
    stopMedia(); cues = []; subtitleLayer.textContent = ''; resetSkips(); usingEngine = false;
    view.hidden = true; document.getElementById('shell').hidden = false;
    onClose?.();
  }
  function next() {
    if (!context) return;
    const index = context.episodes.findIndex(ep => ep.id === context.episode.id);
    if (index >= 0 && context.episodes[index + 1]) open(context.anime, context.episodes[index + 1], context.episodes, context.onClose);
  }
  video.addEventListener('loadedmetadata', () => {
    if (!context) return;
    if (!usingEngine && context.resume > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(context.resume, Math.max(0, video.duration - 2));
    context.resume = 0;
    document.getElementById('play-duration').textContent = time(video.duration);
  });
  video.addEventListener('durationchange', () => { if (context) document.getElementById('play-duration').textContent = time(video.duration); });
  video.addEventListener('playing', () => { loading.hidden = true; errorBox.hidden = true; showControls(); });
  video.addEventListener('waiting', () => { if (context && !video.paused) loading.hidden = false; });
  video.addEventListener('pause', () => { document.getElementById('toggle-play').textContent = 'Play'; save(); showControls(); });
  video.addEventListener('play', () => { document.getElementById('toggle-play').textContent = 'Pause'; });
  video.addEventListener('error', () => {
    // Shaka reports its own media errors with more detail.
    if (!context || usingEngine || (!video.getAttribute('src') && !video.querySelector('source'))) return;
    const descriptions = { 2: 'The stream could not be downloaded. The source may be limiting requests.',
      3: 'The TV could not decode this stream.', 4: 'This stream format or codec is not supported by the TV.' };
    fail(descriptions[video.error?.code] || 'Playback stopped unexpectedly. Try the episode again.');
  });
  video.addEventListener('timeupdate', () => {
    if (!context) return;
    document.getElementById('play-time').textContent = time(video.currentTime);
    if (document.activeElement !== seek && Number.isFinite(video.duration)) seek.value = String(video.currentTime / video.duration * 1000);
    subtitleLayer.textContent = cues.filter(c => c.start <= video.currentTime && c.end > video.currentTime).map(c => c.text).join('\n');
    updateSkip();
    if (Date.now() - lastSave > 5000) { save(); lastSave = Date.now(); }
  });
  video.addEventListener('ended', () => { save(); if (A.state.settings().autoNext) next(); else showControls(true); });
  video.onclick = toggle;
  view.addEventListener('pointermove', () => showControls());
  seek.oninput = () => { if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value) / 1000 * video.duration; showControls(); };
  document.getElementById('player-back').onclick = close;
  document.getElementById('toggle-play').onclick = toggle;
  document.getElementById('rewind').onclick = () => seekBy(-10);
  document.getElementById('forward').onclick = () => seekBy(10);
  document.getElementById('subtitle-button').onclick = subtitleMenu;
  document.getElementById('next-episode').onclick = next;
  qualityButton.onclick = qualityMenu;
  audioButton.onclick = audioMenu;
  skipIntroButton.onclick = skipIntro;
  skipButton.onclick = () => { if (activeSkip) { skipTo(activeSkip, false); updateSkip(); } };
  document.addEventListener('visibilitychange', () => { if (document.hidden && context) { save(); video.pause(); } });
  window.addEventListener('pagehide', save);
  A.player = { open, close, next, parseVtt, active: () => !!context,
    info: () => {
      const tracks = videoTracks(), audio = audioTracks();
      return { engine: usingEngine ? 'shaka' : 'native', height: tracks.find(t => t.active)?.height || video.videoHeight || null,
        qualities: tracks.map(t => t.height), audio: audio.find(t => t.active)?.language || null,
        audioTracks: audio.map(t => t.language), auto: engine && usingEngine ? engine.getConfiguration().abr.enabled : null, skips };
    },
    handleKey: event => {
      const code = event.keyCode;
      if ([415, 19, 10252].includes(code) || event.key === ' ') { event.preventDefault(); toggle(); return true; }
      if (code === 413) { event.preventDefault(); close(); return true; }
      if (code === 403) { event.preventDefault(); skipIntro(); return true; }
      if (code === 404) { event.preventDefault(); audioMenu(); return true; }
      if (code === 405) { event.preventDefault(); subtitleMenu(); return true; }
      if (code === 406) { event.preventDefault(); qualityMenu(); return true; }
      if (code === 417 || code === 412) { event.preventDefault(); seekBy(code === 417 ? 30 : -30); return true; }
      if (controls.hidden) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seekBy(event.key === 'ArrowLeft' ? -10 : 10); return true; }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (activeSkip) { skipTo(activeSkip, false); updateSkip(); showControls(); } else { toggle(); showControls(true); }
          return true;
        }
        if (event.key.startsWith('Arrow')) { event.preventDefault(); showControls(true); return true; }
      }
      showControls(); return false;
    } };
})();
