/**
 * RSS 2.0 / Atom → 條目。
 *
 * 實測事實（probe/out/five-urls-result.json）：
 *   - CGTN 的 content:encoded 是「轉義過的 HTML」（&lt;img ...），
 *     所以要解一次實體、再按標籤切，不能把 &lt; 當正文。
 *   - weekly feed 只有短的 description，沒有全文；role:"index" 會標「只有摘要」。
 */

import {
  attrValue,
  collapse,
  decodeEntities,
  findBlocks,
  findTagStrings,
  normalizeDate,
  pickInner,
  pickText,
  pickDecoded,
  stripCdata,
  stripTags,
} from './xml.mjs';

export const ADAPTER = 'rss';

function pickLink(block) {
  // RSS：<link>https://...</link>
  const inline = pickDecoded(block, 'link');
  if (/^(https?:)\/\//i.test(inline)) return inline;

  // Atom：<link rel="alternate" href="https://..."/>
  const tags = findTagStrings(block, 'link');
  const candidates = tags
    .map((tag) => ({
      href: attrValue(tag, 'href'),
      rel: (attrValue(tag, 'rel') || '').toLowerCase(),
      type: (attrValue(tag, 'type') || '').toLowerCase(),
    }))
    .filter((item) => item.href);

  const alternate = candidates.find((item) => item.rel === '' || item.rel === 'alternate');
  const chosen = alternate || candidates[0];
  return chosen ? collapse(chosen.href) : inline;
}

function pickDate(block) {
  for (const tag of ['pubDate', 'published', 'updated', 'dc:date']) {
    const raw = pickDecoded(block, tag);
    if (!raw) continue;
    return normalizeDate(raw);
  }
  return null;
}

function pickBody(block) {
  let raw = '';
  for (const tag of ['content:encoded', 'content', 'description', 'summary']) {
    raw = pickInner(block, tag);
    if (raw && raw.trim()) break;
  }
  if (!raw) return '';
  // 關鍵：先解一次實體（把 &lt;p&gt; 還原成 <p>），再按標籤切。
  // 有些站是雙層轉義（&amp;nbsp;），切完標籤後再解一次殘留實體。
  const once = decodeEntities(stripCdata(raw));
  return collapse(decodeEntities(stripTags(once)));
}

function pickGuid(block, link) {
  return pickDecoded(block, 'guid') || pickDecoded(block, 'id') || link;
}

/**
 * @param {string} xml feed 原文
 * @param {object} source 正規化後的源配置
 * @returns {{entries: Array, format: 'rss'|'atom'}}
 */
export function parseFeed(xml, source) {
  const text = String(xml ?? '').replace(/^\uFEFF/, '');

  let blocks = findBlocks(text, 'item');
  let format = 'rss';
  if (blocks.length === 0) {
    blocks = findBlocks(text, 'entry');
    format = 'atom';
  }
  if (blocks.length === 0) {
    throw new Error('找不到 <item> 或 <entry>（不是可辨識的 RSS/Atom）');
  }

  const max = Number.isInteger(source.maxItems) ? source.maxItems : 10;
  const entries = [];
  for (const block of blocks.slice(0, max)) {
    const title = pickText(block, 'title') || '(無標題)';
    const link = pickLink(block);
    const guid = pickGuid(block, link);
    const date = pickDate(block);
    entries.push({
      title,
      link,
      guid: guid || link,
      date,
      body: pickBody(block),
      adapter: ADAPTER,
      lowConfidence: false,
      summaryOnly: source.role === 'index',
    });
  }
  return { entries, format };
}
