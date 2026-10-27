/**
 * JSON adapter：按 dot-path 取陣列，再用各 *Path 取值。
 *
 * 實測：Steam 的 contents 是 BBcode（[p]...[/p]、[list][*]...），
 * 去標籤、去 BBcode、解一次實體後壓空白。
 */

import { collapse, decodeEntities, normalizeDate, stripTags } from './xml.mjs';

export const ADAPTER = 'json';

// 只認真的 BBcode 標籤，避免把一般文字裡的 [方括號] 吃掉。
const BB_TAG =
  /\[(?:\/)?(?:p|b|i|u|s|strike|url|img|list|olist|\*\/|\*|h[1-6]|quote|code|spoiler|table|tr|td|th|hr|font|color|size|center|left|right|previewyoutube|video|audio|noparse|pre|sub|sup)(?:=[^\]]*)?\]/gi;

/**
 * 取值：`a.b.c`、`a.b[0].c` 都吃；取不到回 undefined。
 */
export function getByPath(root, dotPath) {
  if (dotPath === undefined || dotPath === null || dotPath === '') return root;
  let current = root;
  const segments = String(dotPath)
    .split('.')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    const match = segment.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!match) return undefined;
    const key = match[1];
    if (key) current = current[key];
    const indexes = match[2].match(/\d+/g) ?? [];
    for (const index of indexes) {
      if (current === null || current === undefined) return undefined;
      current = current[Number(index)];
    }
  }
  return current;
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function cleanInline(value) {
  return collapse(stripTags(decodeEntities(valueText(value))));
}

/** HTML / BBcode / 純文字 → 單行純文本。 */
export function markupToText(value) {
  let text = valueText(value);
  if (!text) return '';
  text = text.replace(/\\\[/g, '[');
  text = text.replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, ' ');
  text = text.replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, ' ');
  // 先解一層實體，讓轉義過的 &lt;p&gt; 變成可移除的標籤；
  // 去標籤/BBcode 後再解一次殘留的 &nbsp; 之類。
  text = decodeEntities(text);
  text = stripTags(text);
  text = text.replace(BB_TAG, ' ');
  text = text.replace(/\{STEAM_[A-Z0-9_]+\}/gi, ' ');
  text = decodeEntities(text);
  return collapse(text);
}

/**
 * @param {any} payload JSON.parse 後的物件
 * @param {object} source 正規化後的源配置
 * @returns {{entries: Array}}
 */
export function extractJson(payload, source) {
  const list = getByPath(payload, source.path);
  if (!Array.isArray(list)) {
    throw new Error(`path "${source.path}" 取到的不是陣列`);
  }

  const max = Number.isInteger(source.maxItems) ? source.maxItems : 10;
  const entries = [];
  for (const item of list.slice(0, max)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`path "${source.path}" 裡有非物件元素`);
    }
    const title = cleanInline(getByPath(item, source.titlePath || 'title')) || '(無標題)';
    const link = cleanInline(getByPath(item, source.linkPath || 'url'));
    const guid = source.idPath ? cleanInline(getByPath(item, source.idPath)) : '';
    const dateValue = getByPath(item, source.datePath || 'date');
    entries.push({
      title,
      link,
      guid: guid || link,
      date: normalizeDate(dateValue),
      body: markupToText(getByPath(item, source.bodyPath || 'contents')),
      adapter: ADAPTER,
      lowConfidence: false,
      summaryOnly: source.role === 'index',
    });
  }
  return { entries };
}
