'use strict';
// DASH manifest rewriting for the loopback media route.
//
// A small XML scanner (elements, either quote style, comments, CDATA, processing instructions,
// entities) builds the element tree, so URLs are resolved against the effective <BaseURL> chain
// that DASH defines (MPD → Period → AdaptationSet → Representation). Only URL-bearing values are
// replaced; every other byte of the manifest is kept as the server sent it.

// URL-bearing attributes by element (DASH ISO/IEC 23009-1). Prefixed `href` (XLink) is handled
// separately. AdaptationSet/Period also have a boolean `bitstreamSwitching`, so names alone are not enough.
const URL_ATTRIBUTES = {
  SegmentTemplate: ['media', 'index', 'initialization', 'bitstreamSwitching'],
  SegmentURL: ['media', 'index'],
  Initialization: ['sourceURL'],
  RepresentationIndex: ['sourceURL'],
  BitstreamSwitching: ['sourceURL'],
};
const REMOVED = new Set(['Location', 'PatchLocation']); // would move the player off the loopback route
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function invalid(detail) { return new Error('Invalid DASH manifest (' + detail + ').'); }
function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()];
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    try { return String.fromCodePoint(code); } catch (_) { throw invalid('bad character reference'); }
  });
}
function encode(value, quote) {
  value = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return quote === "'" ? value.replace(/'/g, '&apos;') : quote === '"' ? value.replace(/"/g, '&quot;') : value.replace(/>/g, '&gt;');
}
const localName = name => name.slice(name.indexOf(':') + 1);

function parse(text) {
  const NAME = /[A-Za-z_][\w.:-]*/y;
  const root = { children: [] }, stack = [root];
  let i = 0;
  const skipTo = (marker, what) => { const end = text.indexOf(marker, i); if (end < 0) throw invalid('unterminated ' + what); i = end + marker.length; };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) { skipTo('-->', 'comment'); continue; }
    if (text.startsWith('<![CDATA[', i)) { skipTo(']]>', 'CDATA'); continue; }
    if (text.startsWith('<?', i)) { skipTo('?>', 'processing instruction'); continue; }
    if (text.startsWith('<!', i)) { skipTo('>', 'declaration'); continue; }
    if (text.startsWith('</', i)) {
      NAME.lastIndex = i + 2; const match = NAME.exec(text);
      const node = stack.pop();
      if (!match || !node.name || node.name !== match[0]) throw invalid('mismatched closing tag');
      node.innerEnd = i;
      i = NAME.lastIndex; while (/\s/.test(text[i] || '')) i++;
      if (text[i] !== '>') throw invalid('malformed closing tag');
      node.end = ++i; continue;
    }
    NAME.lastIndex = i + 1; const match = NAME.exec(text);
    if (!match) throw invalid('malformed tag');
    const node = { name: match[0], local: localName(match[0]), start: i, attributes: [], children: [], parent: stack[stack.length - 1] };
    i = NAME.lastIndex;
    for (;;) {
      const before = i; while (/\s/.test(text[i] || '')) i++;
      if (text[i] === '>') { node.innerStart = ++i; stack.push(node); break; }
      if (text.startsWith('/>', i)) { i += 2; node.end = i; node.innerStart = node.innerEnd = null; break; }
      if (i === before) throw invalid('malformed attribute');
      NAME.lastIndex = i; const attribute = NAME.exec(text);
      if (!attribute) throw invalid('malformed attribute');
      i = NAME.lastIndex; while (/\s/.test(text[i] || '')) i++;
      if (text[i] !== '=') throw invalid('attribute without value');
      i++; while (/\s/.test(text[i] || '')) i++;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") throw invalid('unquoted attribute');
      const close = text.indexOf(quote, i + 1);
      if (close < 0) throw invalid('unterminated attribute');
      node.attributes.push({ name: attribute[0], local: localName(attribute[0]), prefixed: attribute[0].includes(':'),
        quote, valueStart: i + 1, valueEnd: close, value: decode(text.slice(i + 1, close)) });
      i = close + 1;
    }
    node.parent.children.push(node);
  }
  if (stack.length !== 1) throw invalid('unclosed element');
  const top = root.children.filter(node => node.local === 'MPD');
  if (top.length !== 1 || root.children.length !== 1) throw invalid('expected one MPD element');
  return top[0];
}
// Text content of a simple element such as <BaseURL>, with CDATA unwrapped and comments ignored.
function textOf(text, node) {
  if (node.innerStart == null) return '';
  const inner = text.slice(node.innerStart, node.innerEnd);
  let result = '';
  for (const part of inner.split(/(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>)/)) {
    if (part.startsWith('<!--')) continue;
    if (part.startsWith('<![CDATA[')) result += part.slice(9, -3);
    else if (part.includes('<')) throw invalid('unexpected markup in a URL element');
    else result += decode(part);
  }
  return result;
}
// Relative references keep working through the route, which mirrors upstream paths. HTTP(S) URLs,
// protocol- or host-relative paths, and '..' paths (which the upstream clamps at its root but the
// route would not) are resolved upstream first and rerouted. Other schemes (urn:, data:) need no
// fetch through the route and stay as they are.
function needsRoute(value) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return /^https?:/i.test(value);
  return value.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(value);
}
function rewriteDash(text, manifestUrl, route) {
  const mpd = parse(String(text));
  const edits = [];
  const reroute = (value, base) => {
    const trimmed = value.trim();
    if (!trimmed || !needsRoute(trimmed)) return null;
    return route(new URL(trimmed, base).href);
  };
  // The base for an element's children: its first BaseURL resolved against the inherited base.
  // (Further BaseURLs are alternatives; each is rewritten, children follow the first, as players do.)
  const baseFor = (node, inherited) => {
    const first = node.children.find(child => child.local === 'BaseURL');
    if (!first) return inherited;
    try { return new URL(textOf(text, first).trim(), inherited).href; } catch (_) { return inherited; }
  };
  const visit = (node, inherited) => {
    if (REMOVED.has(node.local)) { edits.push({ start: node.start, end: node.end, value: '' }); return; }
    const urlAttributes = URL_ATTRIBUTES[node.local] || [];
    for (const attribute of node.attributes) {
      if (!urlAttributes.includes(attribute.local) && !(attribute.prefixed && attribute.local === 'href')) continue;
      const replacement = reroute(attribute.value, inherited);
      if (replacement !== null) edits.push({ start: attribute.valueStart, end: attribute.valueEnd, value: encode(replacement, attribute.quote) });
    }
    const base = baseFor(node, inherited);
    for (const child of node.children) {
      if (child.local === 'BaseURL') {
        const replacement = reroute(textOf(text, child), inherited);
        if (replacement !== null && child.innerStart != null) edits.push({ start: child.innerStart, end: child.innerEnd, value: encode(replacement) });
      } else visit(child, base);
    }
  };
  visit(mpd, manifestUrl);
  edits.sort((a, b) => b.start - a.start);
  let output = String(text);
  for (const edit of edits) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  return output;
}
module.exports = { rewriteDash, parse, textOf };
