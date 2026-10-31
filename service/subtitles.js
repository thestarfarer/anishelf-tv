'use strict';
function plain(text) {
  return String(text).replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')
    .replace(/<[^>]*>/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function stamp(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3]}.${match[4].padEnd(3, '0')}`;
}
function toVtt(text) {
  text = String(text).replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (/^WEBVTT(?:\s|$)/.test(text)) return text;
  const cues = [];
  if (/^\[Events\]/mi.test(text)) {
    let fields = null, events = false;
    for (const line of text.split('\n')) {
      if (/^\[/.test(line)) { events = /^\[Events\]/i.test(line); continue; }
      if (!events) continue;
      if (/^Format:/i.test(line)) fields = line.slice(7).split(',').map(x => x.trim().toLowerCase());
      if (!/^Dialogue:/i.test(line)) continue;
      const names = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = line.slice(9).trimStart().split(',');
      const row = {};
      names.forEach((name, i) => { row[name] = i === names.length - 1 ? parts.slice(i).join(',') : parts[i]; });
      const start = stamp(row.start), end = stamp(row.end);
      if (start && end && row.text) cues.push(`${start} --> ${end}\n${plain(row.text)}`);
    }
  } else {
    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const i = lines.findIndex(x => x.includes('-->'));
      if (i < 0) continue;
      const pair = lines[i].split('-->');
      const start = stamp(pair[0]), end = stamp(pair[1].trim().split(/\s/)[0]);
      if (start && end) cues.push(`${start} --> ${end}\n${plain(lines.slice(i + 1).join('\n'))}`);
    }
  }
  if (!cues.length) throw new Error('Subtitle format is not supported (expected VTT, SRT, or ASS).');
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}
module.exports = { toVtt, stamp };
