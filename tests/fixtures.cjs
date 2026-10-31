'use strict';
// Fictional metadata and locally generated media, used only by tests.
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const names = ['Signal in the Rain', 'Summer at Station Six', 'A Map of Small Stars', 'The Midnight Garden',
  'Letters from Tomorrow', 'Cloud Atlas Club', 'The Last Tram Home', 'Pencil & Paper',
  'Beyond the Blue', 'A Very Small Adventure', 'Sunroom Days', 'The Quiet Observatory'];
const items = names.map((title, i) => ({ id: 'test-' + (i + 1), source: 'animeonsen', title, romaji: title,
  english: title, image: 'https://api.animeonsen.xyz/v4/image/210x300/test-' + (i + 1),
  description: 'A fictional title for testing the TV interface. This catalog is not included in the installed app.',
  score: 8.1, status: 'finished_airing', genres: ['Adventure', 'Slice of Life'] }));
const episodes = [1, 2, 3].map(i => ({ id: String(i), animeId: 'test-1', number: i, title: ['The first light', 'An unexpected letter', 'The road home'][i - 1] }));
function fixtureSource() {
  return {
    catalog: async start => ({ items: start === 0 ? items.slice(0, 6) : items.slice(6), next: start === 0 }),
    search: async query => ({ items: items.filter(i => i.title.toLowerCase().includes(query.toLowerCase())), next: false }),
    details: async id => items.find(i => i.id === id) || items[0],
    episodes: async id => episodes.map(ep => ({ ...ep, animeId: id })),
    stream: async () => ({ url: 'https://media.animeonsen.xyz/test.mp4',
      subtitles: [{ lang: 'en-US', label: 'English', url: 'https://media.animeonsen.xyz/test.srt' }] }),
  };
}
async function fixtureOpen(url, options = {}) {
  let bytes, type;
  if (/\/image\//.test(url)) {
    const number = Number(url.split('-').pop()) || 1;
    const palettes = [['#bd8aab', '#372b57'], ['#d0b68e', '#31515b'], ['#879bca', '#272648'], ['#9eaf93', '#304638']];
    const [a, b] = palettes[number % palettes.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="210" height="300"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="210" height="300" fill="url(#g)"/><circle cx="145" cy="80" r="49" fill="#fff" opacity=".22"/><path d="M0 240L65 140L130 230L210 100V300H0" fill="#12172a" opacity=".5"/><path d="M0 265L100 180L210 255V300H0" fill="#101020" opacity=".5"/><text x="20" y="48" fill="#fff" font-size="12" font-family="sans-serif" letter-spacing="3">TEST CATALOG</text><text x="20" y="270" fill="#fff" font-size="24" font-family="serif">${String(number).padStart(2, '0')}</text></svg>`;
    bytes = Buffer.from(svg); type = 'image/svg+xml';
  } else if (url.endsWith('.srt')) {
    bytes = Buffer.from('1\n00:00:00,100 --> 00:00:04,800\nSubtitle playback test.\n'); type = 'text/plain';
  } else {
    bytes = await fs.promises.readFile(path.join(__dirname, 'fixtures/sample.mp4')); type = 'video/mp4';
  }
  let status = 200, headers = { 'content-type': type, 'accept-ranges': 'bytes' };
  if (options.headers?.Range && type === 'video/mp4') {
    const match = options.headers.Range.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]), end = match[2] ? Number(match[2]) : bytes.length - 1, size = bytes.length;
      bytes = bytes.subarray(start, end + 1); status = 206;
      headers['content-range'] = `bytes ${start}-${Math.min(end, size - 1)}/${size}`;
    }
  }
  headers['content-length'] = String(bytes.length);
  const stream = Readable.from(options.method === 'HEAD' ? [] : [bytes]);
  stream.statusCode = status; stream.headers = headers; stream.finalUrl = url; return stream;
}
module.exports = { fixtureSource, fixtureOpen, items, episodes };
