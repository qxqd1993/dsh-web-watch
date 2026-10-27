#!/usr/bin/env node
/**
 * probe/extract-strategy.mjs —— `strategy` 擴展點的可執行契約
 * ============================================================================
 * 證明兩件事：
 *   ① 自訂 strategy 真的被呼叫、拿到 `(html, { title, status, url })`，回傳的
 *      `{ text, how }` 會決定輸出（這裡只回第一段，跟預設全文不同）；
 *   ② 非法 strategy（不是函式 / 拋錯 / 回傳形狀不對）由 `extractMain` 安全降級成
 *      `tier:'shell'` + `ok:false`，**不把例外丟給調用方**。
 *
 * 另外釘住兩條邊界：不傳 strategy（或傳 null）＝預設算法；blocked 優先於 strategy。
 *
 *   node probe/extract-strategy.mjs
 * ============================================================================
 */

import { extractMain } from '../lib/extract.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

const URL = 'https://example.test/strategy';
const TITLE = '策略測試文章';
const P1 = '第一段：這是自訂策略唯一要回傳的段落，預設算法會把第二段也抽進來，所以兩者應該不同。';
const P2 = '第二段：預設算法會保留這一段，用來證明自訂策略沒有偷偷走回預設流程。';
const ARTICLE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>',
  TITLE,
  '</title></head><body><article><h1>',
  TITLE,
  '</h1><p>',
  P1,
  '</p><p>',
  P2,
  '</p></article></body></html>',
].join('');

const DEFAULT_TEXT = extractMain(ARTICLE, { url: URL, status: 200 }).text;
check(
  '預設算法（不傳 strategy）仍然抽出兩段正文',
  DEFAULT_TEXT.includes(P1) && DEFAULT_TEXT.includes(P2),
  `${DEFAULT_TEXT.length} 字`,
);

/* ① 注入生效 ─────────────────────────────────────────────────────────────── */

let seen = null;
const injected = extractMain(ARTICLE, {
  url: URL,
  status: 200,
  strategy: (html, context) => {
    seen = { html, context };
    const first = String(html).match(/<p>([\s\S]*?)<\/p>/i);
    return { text: first ? first[1] : '', how: 'first-paragraph' };
  },
});

check(
  '自訂 strategy 拿到 (html, { title, status, url })',
  seen?.html === ARTICLE &&
    seen?.context?.title === TITLE &&
    seen?.context?.status === 200 &&
    seen?.context?.url === URL,
  JSON.stringify(seen?.context),
);
check(
  '注入生效：只回第一段，與預設全文不同',
  injected.text === P1 && injected.text !== DEFAULT_TEXT,
  `自訂 ${injected.text.length} 字 / 預設 ${DEFAULT_TEXT.length} 字，tier=${injected.tier}`,
);
check(
  '自訂策略的 text 原樣回傳、chars 對得上',
  injected.chars === injected.text.length && injected.title === TITLE,
  `chars=${injected.chars} title=${JSON.stringify(injected.title)}`,
);

const nullStrategy = extractMain(ARTICLE, { url: URL, status: 200, strategy: null });
check('strategy: null 視同不傳，走預設算法', nullStrategy.text === DEFAULT_TEXT, `tier=${nullStrategy.tier}`);

/* ② 非法 strategy 安全降級 ───────────────────────────────────────────────── */

function safely(options) {
  try {
    return { value: extractMain(ARTICLE, { url: URL, status: 200, ...options }) };
  } catch (error) {
    return { thrown: error };
  }
}

const BAD_STRATEGIES = [
  ['不是函式', { strategy: 'not-a-function' }, /不是函式/],
  ['呼叫時拋錯', { strategy: () => { throw new Error('boom'); } }, /boom/],
  ['回傳 null', { strategy: () => null }, /必須回傳/],
  ['回傳缺 text 的物件', { strategy: () => ({ how: 'x' }) }, /必須回傳/],
];

for (const [label, options, reasonRe] of BAD_STRATEGIES) {
  const outcome = safely(options);
  const value = outcome.value;
  check(
    `非法 strategy（${label}）⇒ shell + ok:false，不拋到調用方`,
    !outcome.thrown &&
      value?.ok === false &&
      value?.tier === 'shell' &&
      value?.text === '' &&
      value?.chars === 0 &&
      reasonRe.test(String(value?.reason || '')),
    outcome.thrown ? `拋了：${outcome.thrown?.message || outcome.thrown}` : `tier=${value?.tier} reason=${value?.reason}`,
  );
}

/* 邊界：blocked 是抓取層事實，優先於 strategy ─────────────────────────────── */

let strategyCalledOnBlocked = false;
const blocked = extractMain(
  '<html><head><title>Just a moment...</title></head><body><p>challenge</p></body></html>',
  {
    url: URL,
    status: 403,
    strategy: () => {
      strategyCalledOnBlocked = true;
      return { text: '不該被採用', how: 'nope' };
    },
  },
);
check(
  'blocked 優先於 strategy（且不會呼叫它）',
  blocked.ok === false && blocked.tier === 'blocked' && blocked.text === '' && !strategyCalledOnBlocked,
  `tier=${blocked.tier} called=${strategyCalledOnBlocked}`,
);

console.log(`\n[extract-strategy] ${failures === 0 ? '全部通過' : `${failures} 條失敗`}`);
if (failures > 0) process.exitCode = 1;
