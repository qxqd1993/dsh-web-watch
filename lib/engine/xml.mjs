/**
 * 容錯 XML / 實體工具。
 *
 * 目的不是寫一個通用 XML parser，而是為 feed 做三件小事：
 *   1. 把 <item> / <entry> 切出來（容忍屬性、換行、CDATA）
 *   2. 取某個標籤的內文或屬性（容忍標籤帶屬性、大小寫）
 *   3. 解一次 HTML/XML 實體（CGTN 的 content:encoded 就是轉義過的 HTML）
 *
 * 沒有第三方依賴。
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', minus: '−',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  middot: '·', bull: '•', dagger: '†', Dagger: '‡', permil: '‰',
  times: '×', divide: '÷', plusmn: '±', deg: '°', micro: 'µ', para: '¶', sect: '§',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', prime: '′', Prime: '″',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω',
});

/** 解一次實體；未知實體原樣保留，不吞資料。 */
export function decodeEntities(input) {
  const s = String(input ?? '');
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** 去掉一層 <![CDATA[ ... ]]> 包裝。 */
export function stripCdata(input) {
  return String(input ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** 去掉註解、腳本、樣式與所有標籤，留空格。 */
export function stripTags(input) {
  return String(input ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/<\?xml[\s\S]*?\?>/gi, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/** 壓成單行、去控制字元；保留一個空格。 */
export function collapse(input) {
  return String(input ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 切出所有 <tag ...>...</tag> 的內文（不含標籤本身）。
 * 容忍屬性、換行、大小寫；不處理 self-closing（feed 條目不會這樣寫）。
 */
export function findBlocks(xml, tag) {
  const name = escapeRegExp(tag);
  const re = new RegExp(`<${name}(?:\\s[^>]*?)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi');
  const out = [];
  let match;
  while ((match = re.exec(String(xml ?? ''))) !== null) {
    out.push(match[1]);
    if (out.length >= 2000) break;
  }
  return out;
}

/** 取第一個 <tag> 的原始內文（已去 CDATA 包裝，但未解實體）。 */
export function pickInner(block, tag) {
  const name = escapeRegExp(tag);
  const re = new RegExp(`<${name}(?:\\s[^>]*?)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i');
  const match = String(block ?? '').match(re);
  return match ? stripCdata(match[1]) : '';
}

/** 取標籤文字：解一次實體 → 去標籤 → 壓空白。 */
export function pickText(block, tag) {
  const raw = pickInner(block, tag);
  if (!raw) return '';
  return collapse(stripTags(decodeEntities(raw)));
}

/** 取標籤文字但不把 <...> 當標籤切（給 link / guid 用）。 */
export function pickDecoded(block, tag) {
  const raw = pickInner(block, tag);
  if (!raw) return '';
  return collapse(decodeEntities(raw));
}

/** 找出所有 tag 的完整標籤字串（含 < >），給 Atom 的 <link href="..."/> 用。 */
export function findTagStrings(block, tag) {
  const name = escapeRegExp(tag);
  const re = new RegExp(`<${name}(?:\\s[^>]*?)?\\/?>`, 'gi');
  return String(block ?? '').match(re) ?? [];
}

/** 從一個完整標籤字串取屬性值。 */
export function attrValue(tagString, attr) {
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = String(tagString ?? '').match(re);
  if (!match) return '';
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * 把 feed / JSON 裡的日期壓成 Date。
 * 支援 RFC 822、ISO、Unix 秒、Unix 毫秒與純數字字串。
 */
export function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{9,14}$/.test(s)) {
    const n = Number(s);
    const ms = n > 1e12 ? n : n * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
