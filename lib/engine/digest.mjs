/**
 * 三節摘要（標題固定，不改名）：
 *   ## 變動 N 條
 *   ## 沒變 N 個源
 *   ## 抓不到 N 個源
 *
 * 每個源必須出現在三節之一，合計 == 本輪跑的源數。
 */

import { formatLocalStamp, formatOffset, formatZonedIso, offsetMinutes } from './schedule.mjs';

function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function preview(value, maxChars = 200) {
  const text = oneLine(value);
  if (!text) return '（空）';
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

function changedSection(results, totalNew, timeZone) {
  const blocks = [];
  for (const result of results) {
    // role 在 run.mjs 的 `result.source` 上（normalizeSources 校驗後的源物件）。
    // index 源只給標題＋極短摘要，body 抓到的是「來源站的自我介紹」，不是當期內容
    // ⇒ 不印「前 200 字」，只留來源 / 時間 + 「只有摘要（無全文）」。
    const isIndex = result.source?.role === 'index';
    for (const entry of result.fresh) {
      const lines = [
        `### [${result.sourceId}] ${oneLine(entry.title) || '(無標題)'}`,
        `- 來源：${entry.link || result.source.url}  時間：${entry.date ? formatZonedIso(entry.date, timeZone) : '未知'}`,
      ];
      if (!isIndex) lines.push(`- 前 200 字：${preview(entry.body, 200)}`);
      if (isIndex) lines.push('- 只有摘要（無全文）');
      if (entry.lowConfidence) {
        lines.push(entry.tier ? `- 低信度（正文抽取 tier=${entry.tier}）` : '- 低信度（identity 透傳）');
      }
      blocks.push(lines.join('\n'));
    }
  }
  return [`## 變動 ${totalNew} 條`, ...blocks].join('\n\n');
}

function unchangedSection(results) {
  const lines = results.map((result) => {
    const total = result.entries.length;
    const allKnown = result.knownCount >= total;
    return `- ${result.sourceId}（${total} 條，${allKnown ? '全是已讀' : '均未變'}）`;
  });
  return [`## 沒變 ${results.length} 個源`, ...lines].join('\n');
}

function failedSection(results) {
  const lines = results.map(
    (result) => `- ${result.sourceId}（${result.failure.reason}，累計 ${result.failuresCount} 次）`,
  );
  return [`## 抓不到 ${results.length} 個源`, ...lines].join('\n');
}

/**
 * 源健康提醒：任一源 failStreak ≥ 3 才出現；否則整節不寫（不留空節）。
 * 放在 digest 最前面（標題之下），免得連續壞掉的源被埋在「抓不到」裏。
 */
function attentionSection(results) {
  const rows = results.filter((result) => Number(result.failStreak) >= 3);
  if (rows.length === 0) return null;
  const lines = rows.map(
    (result) =>
      `- ${result.sourceId} 連續失敗 ${result.failStreak} 次（${oneLine(result.failure?.reason || '未知')}）—— 要考慮換端點或刪掉`,
  );
  return ['## ⚠ 注意', ...lines].join('\n');
}

/**
 * @returns {{markdown:string, counts:{newEntries:number,changedSources:number,unchangedSources:number,failedSources:number,rows:number}}}
 */
export function buildDigest({ now, schedule, results, cleanup, skippedCount = 0 }) {
  const timeZone = schedule.timezone;
  const changed = results.filter((result) => result.section === 'changed');
  const unchanged = results.filter((result) => result.section === 'unchanged');
  const failed = results.filter((result) => result.section === 'failed');
  const totalNew = changed.reduce((sum, result) => sum + result.fresh.length, 0);

  const header = `# web-watch ${formatLocalStamp(now, timeZone)} (${formatOffset(offsetMinutes(now, timeZone))})`;
  const attention = attentionSection(results);
  const parts = [
    header,
    ...(attention ? [attention] : []),
    changedSection(changed, totalNew, timeZone),
    unchangedSection(unchanged),
    failedSection(failed),
  ];

  if (skippedCount > 0) {
    parts.push(`> tick：另有 ${skippedCount} 個源未到期，本輪未抓。`);
  }
  parts.push(
    `---\n清理：本輪刪除 ${cleanup.removed} 份過期快照（保留 90 天 / 最多 200 份；現有 ${cleanup.remaining} 份）。`,
  );

  return {
    markdown: `${parts.join('\n\n')}\n`,
    counts: {
      newEntries: totalNew,
      changedSources: changed.length,
      unchangedSources: unchanged.length,
      failedSources: failed.length,
      rows: results.length,
    },
  };
}
