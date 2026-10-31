(function () {
  'use strict';
  const A = window.AniShelf;
  const view = document.getElementById('player'), video = document.getElementById('video');
  const controls = document.getElementById('player-controls');
  const loading = document.getElementById('player-loading'), errorBox = document.getElementById('player-error');
  const subtitleLayer = document.getElementById('subtitle-overlay'), seek = document.getElementById('seek');
  let context = null, generation = 0, pending, hideTimer, lastSave = 0, cues = [], subtitleGeneration = 0;
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
  function subtitleMenu() {
    if (!context) return;
    showControls();
    A.openModal('Subtitles', body => {
      const list = document.createElement('div'); list.className = 'modal-list';
      const tracks = [{ lang: 'off', label: 'Off' }, ...context.tracks];
      for (const track of tracks) {
        const button = document.createElement('button'); button.textContent = track.label;
        if (A.state.settings().subtitle === track.lang) button.className = 'selected';
        button.onclick = () => {
          try { A.state.setting('subtitle', track.lang); } catch (e) { A.toast(e.message); }
          selectSubtitle(track.lang === 'off' ? null : track); A.closeModal();
        };
        list.append(button);
      }
      body.append(list);
      const close = document.createElement('button'); close.textContent = 'Close'; close.className = 'subtle';
      close.style.marginTop = '20px'; close.onclick = A.closeModal; body.append(close);
    });
  }
  async function open(anime, episode, episodes, onClose) {
    if (context) save();
    pending?.abort(); pending = new AbortController();
    const requestId = ++generation;
    video.pause(); video.removeAttribute('src'); video.replaceChildren(); video.load();
    cues = []; ++subtitleGeneration; subtitleLayer.textContent = '';
    const previous = A.state.progress(anime.id, episode.id);
    context = { anime, episode, episodes, onClose, tracks: [], resume: previous && !previous.seen ? previous.position : 0 };
    view.hidden = false; document.getElementById('shell').hidden = true;
    errorBox.hidden = true; loading.hidden = false;
    document.getElementById('player-series').textContent = anime.title;
    document.getElementById('player-episode').textContent = `Episode ${episode.id} · ${episode.title}`;
    document.getElementById('next-episode').disabled = episodes.findIndex(ep => ep.id === episode.id) >= episodes.length - 1;
    showControls(true);
    try {
      const stream = await A.api.call('stream', { id: anime.id, episode: episode.id }, pending.signal);
      if (requestId !== generation) return;
      if (stream.format === 'dash') throw new Error('This episode uses DASH, which this first TV build does not support yet.');
      context.tracks = stream.subtitles;
      const preference = A.state.settings().subtitle;
      if (preference !== 'off') selectSubtitle(stream.subtitles.find(t => t.lang === preference) ||
        stream.subtitles.find(t => t.lang.split('-')[0] === preference.split('-')[0]) || stream.subtitles[0]);
      if (stream.format === 'hls') {
        // An explicit MIME type selects LG's HLS pipeline even for opaque proxy URLs.
        const source = document.createElement('source'); source.src = stream.url;
        source.type = 'application/vnd.apple.mpegurl'; video.append(source); video.load();
      } else video.src = stream.url;
      await video.play();
    } catch (e) {
      if (requestId !== generation || e.name === 'AbortError') return;
      fail(e.name === 'NotSupportedError' ? 'The TV cannot play this stream or codec.' : e.message);
    }
  }
  function close() {
    if (!context) return;
    save(); const onClose = context.onClose; context = null; ++generation; ++subtitleGeneration;
    pending?.abort(); pending = null; clearTimeout(hideTimer);
    video.pause(); video.removeAttribute('src'); video.replaceChildren(); video.load(); cues = []; subtitleLayer.textContent = '';
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
    if (context.resume > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(context.resume, Math.max(0, video.duration - 2));
    context.resume = 0;
    document.getElementById('play-duration').textContent = time(video.duration);
  });
  video.addEventListener('playing', () => { loading.hidden = true; errorBox.hidden = true; showControls(); });
  video.addEventListener('waiting', () => { if (context && !video.paused) loading.hidden = false; });
  video.addEventListener('pause', () => { document.getElementById('toggle-play').textContent = 'Play'; save(); showControls(); });
  video.addEventListener('play', () => { document.getElementById('toggle-play').textContent = 'Pause'; });
  video.addEventListener('error', () => {
    if (!context || (!video.getAttribute('src') && !video.querySelector('source'))) return;
    const descriptions = { 2: 'The stream could not be downloaded. The source may be limiting requests.',
      3: 'The TV could not decode this stream.', 4: 'This stream format or codec is not supported by the TV.' };
    fail(descriptions[video.error?.code] || 'Playback stopped unexpectedly. Try the episode again.');
  });
  video.addEventListener('timeupdate', () => {
    if (!context) return;
    document.getElementById('play-time').textContent = time(video.currentTime);
    if (document.activeElement !== seek && Number.isFinite(video.duration)) seek.value = String(video.currentTime / video.duration * 1000);
    subtitleLayer.textContent = cues.filter(c => c.start <= video.currentTime && c.end > video.currentTime).map(c => c.text).join('\n');
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
  document.addEventListener('visibilitychange', () => { if (document.hidden && context) { save(); video.pause(); } });
  window.addEventListener('pagehide', save);
  A.player = { open, close, next, parseVtt, active: () => !!context, handleKey: event => {
    const code = event.keyCode;
    if ([415, 19, 10252].includes(code) || event.key === ' ') { event.preventDefault(); toggle(); return true; }
    if (code === 413) { event.preventDefault(); close(); return true; }
    if (code === 405) { event.preventDefault(); subtitleMenu(); return true; }
    if (code === 417 || code === 412) { event.preventDefault(); seekBy(code === 417 ? 30 : -30); return true; }
    if (controls.hidden) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seekBy(event.key === 'ArrowLeft' ? -10 : 10); return true; }
      if (event.key === 'Enter') { event.preventDefault(); toggle(); showControls(true); return true; }
      if (event.key.startsWith('Arrow')) { event.preventDefault(); showControls(true); return true; }
    }
    showControls(); return false;
  } };
})();
