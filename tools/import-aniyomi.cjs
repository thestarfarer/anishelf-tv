'use strict';
// Schema adapted from Aniyomi's Backup*.kt models (Apache-2.0). See NOTICE.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { id: validId } = require('../service/onsen');
const KNOWN_SOURCE = '8542735178285060053';
function varint(buffer, cursor) {
  let value = 0n;
  for (let count = 0; count < 10; count++) {
    if (cursor.offset >= buffer.length) throw new Error('Truncated protobuf value.');
    const byte = buffer[cursor.offset++];
    if (count === 9 && byte > 1) throw new Error('Oversized protobuf value.');
    value |= BigInt(byte & 127) << BigInt(count * 7);
    if (!(byte & 128)) return value;
  }
  throw new Error('Invalid protobuf value.');
}
function fields(buffer) {
  const result = new Map(), cursor = { offset: 0 };
  while (cursor.offset < buffer.length) {
    const tag = Number(varint(buffer, cursor)), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field || field > 536870911) throw new Error('Invalid protobuf field.');
    let value;
    if (wire === 0) value = varint(buffer, cursor);
    else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (cursor.offset + length > buffer.length) throw new Error('Truncated protobuf field.');
      value = wire === 5 ? buffer.readFloatLE(cursor.offset) : buffer.readDoubleLE(cursor.offset); cursor.offset += length;
    } else if (wire === 2) {
      const length = Number(varint(buffer, cursor));
      if (!Number.isSafeInteger(length) || length < 0 || cursor.offset + length > buffer.length) throw new Error('Invalid protobuf length.');
      value = buffer.subarray(cursor.offset, cursor.offset + length); cursor.offset += length;
    } else throw new Error('Unsupported protobuf wire type.');
    if (!result.has(field)) result.set(field, []);
    result.get(field).push(value);
  }
  return result;
}
const first = (message, number, fallback) => message.get(number)?.[0] ?? fallback;
const text = (message, number, fallback = '') => {
  const value = first(message, number); return Buffer.isBuffer(value) ? value.toString('utf8') : fallback;
};
function contentId(url) {
  let value = String(url).replace(/\/$/, '');
  if (/^https:\/\//.test(value)) {
    const parsed = new URL(value);
    if (!['www.animeonsen.xyz', 'animeonsen.xyz', 'api.animeonsen.xyz'].includes(parsed.hostname)) throw new Error('Unexpected AnimeOnsen URL.');
    value = parsed.pathname;
  }
  value = value.replace(/^\/?(?:details\/|v4\/content\/)/, '').replace(/^\//, '').replace(/\/extensive$/, '');
  return validId(value);
}
function convert(buffer) {
  if (buffer.length > 32 * 1024 * 1024) throw new Error('Backup is too large (32 MiB compressed limit).');
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer, { maxOutputLength: 128 * 1024 * 1024 });
  const root = fields(buffer);
  const sourceIds = new Set([KNOWN_SOURCE]);
  for (const bytes of [...(root.get(503) || []), ...(root.get(103) || [])]) {
    const source = fields(bytes);
    if (/^anime\s?onsen$/i.test(text(source, 1).trim())) sourceIds.add(String(first(source, 2, 0n)));
  }
  const output = { version: 1, library: {}, progress: {}, settings: { title: 'romaji', subtitle: 'en-US', autoNext: false } };
  const stats = { importedTitles: 0, importedEpisodes: 0, skippedSources: 0, skippedMalformed: 0 };
  const animeRecords = root.get(501) || root.get(3) || [];
  if (!animeRecords.length) throw new Error('No anime library was found. This may be a manga-only or unsupported backup.');
  for (const bytes of animeRecords) {
    const anime = fields(bytes);
    if (!sourceIds.has(String(first(anime, 1, 0n)))) { stats.skippedSources++; continue; }
    let animeId;
    try { animeId = contentId(text(anime, 2)); } catch (_) { stats.skippedMalformed++; continue; }
    const title = text(anime, 3, animeId);
    const history = new Map();
    for (const bytes of anime.get(104) || []) {
      const h = fields(bytes); history.set(text(h, 1), Number(first(h, 2, 0n)));
    }
    let allSeen = true, anyProgress = false, count = 0;
    for (const bytes of anime.get(16) || []) {
      const ep = fields(bytes), url = text(ep, 1);
      let episodeId;
      try { episodeId = validId(url.replace(/\/$/, '').split('/').pop()); } catch (_) { stats.skippedMalformed++; continue; }
      const seen = first(ep, 4, 0n) !== 0n;
      // Verified against PlayerViewModel.updateEpisodeProgress: both values are milliseconds.
      const position = Number(first(ep, 6, 0n)) / 1000, duration = Number(first(ep, 16, 0n)) / 1000;
      allSeen = allSeen && seen; anyProgress = anyProgress || seen || position > 0; count++;
      if (!seen && !position) continue;
      output.progress[animeId + '/' + episodeId] = { animeId, episodeId, animeTitle: title,
        episodeTitle: text(ep, 2, 'Episode ' + episodeId), position, duration, seen,
        updatedAt: history.get(url) || Number(first(ep, 11, 0n)) || 0 };
      stats.importedEpisodes++;
    }
    if (first(anime, 100, 1n) !== 0n) {
      output.library[animeId] = { id: animeId, source: 'animeonsen', title, romaji: title, english: '',
        description: text(anime, 6), genres: (anime.get(7) || []).map(x => x.toString('utf8')),
        category: count && allSeen ? 'Completed' : anyProgress ? 'Watching' : 'Planned',
        addedAt: Number(first(anime, 13, 0n)) || Date.now() };
      stats.importedTitles++;
    }
  }
  return { output, stats };
}
if (require.main === module) {
  try {
    const input = process.argv[2];
    if (!input || input === '--help') {
      console.log('Usage: node tools/import-aniyomi.cjs BACKUP.proto.gz [OUTPUT.json | --seed]');
      console.log('--seed puts the converted library into the next TV package. Original backup is never modified.');
      process.exit(input === '--help' ? 0 : 1);
    }
    const result = convert(fs.readFileSync(input));
    const target = process.argv[3] === '--seed' ? path.join(__dirname, '../app/seed-library.json') : process.argv[3] || 'anishelf-library.json';
    if (path.resolve(target) === path.resolve(input)) throw new Error('Output must be different from the original backup.');
    fs.writeFileSync(target, JSON.stringify(result.output, null, 2) + '\n');
    console.log(JSON.stringify({ file: path.resolve(target), ...result.stats }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { convert, fields, varint, contentId };
