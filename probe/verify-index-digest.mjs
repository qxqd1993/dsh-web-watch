#!/usr/bin/env node
/**
 * probe/verify-index-digest.mjs —— 驗證 buildDigest() 對 role 的差別處理
 * ============================================================================
 * 不聯網、不寫檔：造一份假的 summary（一個 role=full 帶正文、一個 role=index），
 * 呼叫 buildDigest()，把 render 出來的 markdown 原樣印出來並斷言：
 *   ・full 條目有「前 200 字」；
 *   ・index 條目沒有「前 200 字」、但有「只有摘要（無全文）」；
 *   ・兩條都在、三節標題都在；
 *   ・只有 index 條目時不留空行 / 半截格式。
 *
 * 用法：node probe/verify-index-digest.mjs
 * ============================================================================
 */

import { buildDigest } from '../lib/engine/digest.mjs';

const NOW = new Date('2026-10-25T13:10:55+08:00');
const SCHEDULE = { intervalHours: 24, startAt: '09:00', timezone: 'Asia/Macau' };
const FULL_BODY = '這是 full 源的正文：真正的文章內容，不是來源站的自我介紹。'.repeat(12);

function makeEntry({ title, link, date, body }) {
  return { title, link, date, body };
}

function makeResult({ sourceId, role, url, fresh }) {
  return {
    sourceId,
    source: { id: sourceId, kind: 'rss', role, url },
    exactUrl: url,
    section: 'changed',
    entries: [...fresh],
    fresh: [...fresh],
    knownCount: 0,
  };
}

function build(results) {
  return buildDigest({
    now: NOW,
    schedule: SCHEDULE,
    results,
    cleanup: { removed: 0, remaining: 1 },
    skippedCount: 0,
  });
}

/** 把某個源的 block 從 markdown 裡切出來（到下一條 ### 或下一個 ## 節為止）。 */
function blockOf(markdown, sourceId) {
  const start = markdown.indexOf(`### [${sourceId}]`);
  if (start < 0) return '';
  const rest = markdown.slice(start);
  const cuts = [rest.indexOf('\n### ['), rest.indexOf('\n## ')].filter((index) => index > 0);
  const end = cuts.length > 0 ? Math.min(...cuts) : rest.length;
  return rest.slice(0, end).trim();
}

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(name);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}
function checkNot(name, haystack, needle) {
  check(name, !haystack.includes(needle), haystack.includes(needle) ? `意外出現「${needle}」` : '未出現');
}

/* ────────────────────── 假 summary：一個 full + 一個 index ────────────────────── */

const fullResult = makeResult({
  sourceId: 'demo-full',
  role: 'full',
  url: 'https://example.com/full.xml',
  fresh: [
    makeEntry({
      title: '[全文] CGTN 世界新聞：真正的文章',
      link: 'https://example.com/full/1',
      date: new Date('2026-10-25T09:00:00+08:00'),
      body: FULL_BODY,
    }),
  ],
});

const indexResult = makeResult({
  sourceId: 'demo-index',
  role: 'index',
  url: 'https://example.com/index.xml',
  fresh: [
    makeEntry({
      title: '[Rust] 【Rust日报】2026-10-23 Wasmtime 修复 CVSS 9.3 沙箱逃逸',
      link: 'https://example.com/index/1',
      date: new Date('2026-10-23T09:07:00+08:00'),
      body: 'Rust语言中文社区新闻和日报',
    }),
  ],
});

const mixed = build([fullResult, indexResult]);

console.log('\n===== ① 兩條源（full + index）render 出來的 digest =====\n');
console.log(mixed.markdown);
console.log('===== ① 結束 =====\n');

const fullBlock = blockOf(mixed.markdown, 'demo-full');
const indexBlock = blockOf(mixed.markdown, 'demo-index');

check('full 條目在 digest 裡', fullBlock.length > 0);
check('index 條目在 digest 裡', indexBlock.length > 0);
check('full 條目有「前 200 字」', fullBlock.includes('- 前 200 字：'));
checkNot('full 條目不帶「只有摘要（無全文）」', fullBlock, '只有摘要（無全文）');
checkNot('index 條目沒有「前 200 字」', indexBlock, '前 200 字');
check('index 條目有「只有摘要（無全文）」', indexBlock.includes('- 只有摘要（無全文）'));
check('index 條目保留「來源」', indexBlock.includes('- 來源：https://example.com/index/1'));
check('index 條目保留「時間」', indexBlock.includes('時間：2026-10-23T09:07:00+08:00'));
check(
  'index 條目剛好三行（標題 / 來源時間 / 只有摘要）',
  indexBlock.split('\n').length === 3,
  `${indexBlock.split('\n').length} 行`,
);
check(
  '三節標題都在',
  ['## 變動', '## 沒變', '## 抓不到'].every((head) => mixed.markdown.includes(head)),
  mixed.markdown.split('\n').filter((line) => line.startsWith('## ')).join(' | '),
);
check('標題計數 = 2 條', mixed.markdown.includes('## 變動 2 條'));
check('沒有三連空行（排版沒被撐破）', !mixed.markdown.includes('\n\n\n'));

// full 的行為「完全不變」：200 字預覽照舊截斷
const previewLine = fullBlock.split('\n').find((line) => line.startsWith('- 前 200 字：')) || '';
const previewText = previewLine.slice('- 前 200 字：'.length);
check(
  'full 的預覽仍截在 200 字 + 省略號',
  Array.from(previewText).length === 201 && previewText.endsWith('…'),
  `${Array.from(previewText).length} 字`,
);

/* ────────────────────── 只有 index 條目：不留空行 / 半截格式 ────────────────────── */

const indexOnly = build([indexResult]);

console.log('\n===== ② 只有 index 條目 render 出來的 digest =====\n');
console.log(indexOnly.markdown);
console.log('===== ② 結束 =====\n');

const onlyBlock = blockOf(indexOnly.markdown, 'demo-index');
check('只有 index 時：條目仍在', onlyBlock.length > 0);
check('只有 index 時：沒有「前 200 字」', !indexOnly.markdown.includes('前 200 字'));
check('只有 index 時：「只有摘要（無全文）」仍在', indexOnly.markdown.includes('- 只有摘要（無全文）'));
check('只有 index 時：計數 = 1 條', indexOnly.markdown.includes('## 變動 1 條'));
check('只有 index 時：三節標題都在', ['## 變動', '## 沒變', '## 抓不到'].every((head) => indexOnly.markdown.includes(head)));
check('只有 index 時：沒有三連空行', !indexOnly.markdown.includes('\n\n\n'));
check('只有 index 時：block 仍是三行、沒有被留下半截', onlyBlock.split('\n').length === 3, onlyBlock.split('\n').length + ' 行');
check(
  '只有 index 時：每個「- 」行都有內容（沒有空標籤）',
  indexOnly.markdown
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .every((line) => line.trim().length > 2),
);

/* ────────────────────── 總結 ────────────────────── */

console.log(`\n[probe] ${failures.length === 0 ? '全部通過' : `FAIL ${failures.length} 項`}`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
