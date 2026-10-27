/**
 * html adapter — P1 的 identity 空殼，**0.1.5 起 run.mjs 已改走 lib/extract.mjs**，
 * 這裏只留著當對照 / 舊行為參考（不再被 import）。
 *
 * 它不做正文抽取、不判斷導航/廣告、不引 readability：
 * 只把 script/style/註解/標籤去掉，剩下什麼就回什麼，
 * 並明確標 lowConfidence:true、adapter:'identity'，讓 digest 標「低信度」。
 */

import { collapse, decodeEntities } from './xml.mjs';

export const ADAPTER = 'identity';

function pickTitle(html) {
  const match = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!match) return '';
  return collapse(decodeEntities(match[1].replace(/<[^>]*>/g, ' ')));
}

/**
 * @param {string} raw HTML 原文
 * @returns {{text: string, title: string, lowConfidence: boolean, adapter: 'identity'}}
 */
export function extractHtml(raw) {
  const html = String(raw ?? '').replace(/^\uFEFF/, '');
  const title = pickTitle(html);

  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ');
  text = text.replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ');
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');
  text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = collapse(text);

  return {
    text,
    title,
    lowConfidence: true,
    adapter: ADAPTER,
  };
}
