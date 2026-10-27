#!/usr/bin/env node
/**
 * probe/extract-eval.mjs —— B 的可評測入口
 * ============================================================================
 * 拿真網頁跑 `lib/extract.mjs`，印一張表（rawBytes / baseline 字數 / 抽出字數 /
 * ratio / tier / 前 120 字），並跟「純去標籤」的 baseline 對照。
 *
 * 題目：euobserver ×3、latimes ×3、cgtn ×2（全部取自 2026-10-25 那輪 digest 的真連結），
 * 外加 arabnews 的 Cloudflare 403 當 blocked 反例。
 *
 * 離線可重跑：第一次跑把 HTML 存進 probe/fixtures/<slug>.html（單檔 ≤ 800KB，超過截斷，
 * 截斷事實與 HTTP status 記在 fixtures/MANIFEST.json）；之後預設只讀 fixture，不再碰網路。
 *
 *   node probe/extract-eval.mjs            # 有 fixture 就離線跑
 *   node probe/extract-eval.mjs --refresh  # 重新抓一輪、重寫 fixture
 * ============================================================================
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractMain } from '../lib/extract.mjs';
import { collapse, decodeEntities, stripTags } from '../lib/engine/xml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures');
const MANIFEST = path.join(FIXTURE_DIR, 'MANIFEST.json');
const MAX_FIXTURE_BYTES = 800 * 1024;
const REFRESH = process.argv.includes('--refresh');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 測試集：取自 2026-10-25 digest（euobserver / latimes），cgtn 取自 2026-10-24 那輪。 */
const CASES = [
  {
    slug: 'euobserver-palantir',
    url: 'https://euobserver.com/244723/calls-mount-for-un-world-food-programme-which-feeds-1-4m-people-in-gaza-to-quit-contract-with-palantir/',
    minChars: 800,
    note: 'euobserver 全文',
  },
  {
    slug: 'euobserver-bulgaria',
    url: 'https://euobserver.com/244554/interview-bulgarias-presidential-election-becomes-a-test-of-rumen-radevs-grip-on-power/',
    minChars: 800,
    note: 'euobserver 全文',
  },
  {
    slug: 'euobserver-clocks',
    url: 'https://euobserver.com/243533/putting-the-clocks-back-this-sunday-yet-millions-of-europeans-dont-want-to/',
    minChars: 800,
    note: 'euobserver 全文',
  },
  {
    slug: 'latimes-wealth-tax',
    url: 'https://www.latimes.com/california/story/2026-10-24/more-than-351-million-spent-on-wealth-tax-on-november-ballot',
    note: 'latimes（索引源指到的真文章）',
  },
  {
    slug: 'latimes-latinos',
    url: 'https://www.latimes.com/politics/story/2026-10-23/many-latinos-are-over-trump-shift-is-especially-striking-in-texas',
    note: 'latimes',
  },
  {
    slug: 'latimes-mchenry',
    url: 'https://www.latimes.com/sports/story/2026-10-23/britt-mchenry-resigns-state-department-drink-throwing-incident-wizards-game',
    note: 'latimes',
  },
  {
    slug: 'cgtn-long-march',
    url: 'https://news.cgtn.com/news/2026-10-21/Q-A-How-the-Long-March-shapes-the-CPC-and-China-s-modernization-today-1RqwPQaTw9G/p.html',
    minChars: 800,
    note: 'cgtn 全文',
  },
  {
    slug: 'cgtn-comesa',
    url: 'https://newsaf.cgtn.com/news/2026-10-23/COMESA-leaders-call-for-stronger-regional-trade-and-integration-1Rtw4uMDSeY/p.html?UTM_Source=cgtn&UTM_Medium=rss&UTM_Campaign=World',
    minChars: 800,
    note: 'cgtn 全文',
  },
  {
    slug: 'cgtn-doctors',
    url: 'https://newsus.cgtn.com/news/2026-10-22/Next-gen-doctors-swap-scrubs-for-aprons-1RqUWNXv4By/p.html',
    note: 'cgtn 短影音稿（正文本來就短，不列入 ≥800 驗收）',
  },
  {
    slug: 'arabnews-blocked',
    url: 'https://www.arabnews.com/rss.xml',
    expectTier: 'blocked',
    note: '已知 Cloudflare 403，blocked 反例',
  },
];

function oneLine(value) {
  return collapse(String(value ?? ''));
}

async function loadManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return { fetchedAt: null, cases: {} };
  }
}

async function saveFixture(slug, url, { html, status, contentType, rawBytes, truncatedAt }) {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${slug}.html`);
  await writeFile(file, html, 'utf8');
  return { slug, url, status, contentType, rawBytes, storedBytes: Buffer.byteLength(html, 'utf8'), truncatedAt, file: `${slug}.html` };
}

async function fetchFixture(entry, manifest) {
  const response = await fetch(entry.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const rawBytes = buffer.byteLength;
  const truncatedAt = rawBytes > MAX_FIXTURE_BYTES ? MAX_FIXTURE_BYTES : null;
  const html = buffer.subarray(0, MAX_FIXTURE_BYTES).toString('utf8');
  const saved = await saveFixture(entry.slug, entry.url, {
    html,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    rawBytes,
    truncatedAt,
  });
  manifest.cases[entry.slug] = saved;
  return { ...saved, html, status: response.status };
}

async function main() {
  const manifest = await loadManifest();
  const rows = [];
  const failures = [];

  for (const entry of CASES) {
    const cached = manifest.cases[entry.slug];
    let html = '';
    let status = 0;
    let rawBytes = 0;
    let truncated = false;
    let source = 'fixture';

    const file = path.join(FIXTURE_DIR, `${entry.slug}.html`);
    if (!REFRESH && cached) {
      try {
        html = await readFile(file, 'utf8');
        status = Number(cached.status) || 0;
        rawBytes = Number(cached.rawBytes) || Buffer.byteLength(html, 'utf8');
        truncated = Boolean(cached.truncatedAt);
      } catch {
        html = '';
      }
    }

    if (!html) {
      source = 'network';
      try {
        const fetched = await fetchFixture(entry, manifest);
        html = fetched.html;
        status = fetched.status;
        rawBytes = fetched.rawBytes;
        truncated = Boolean(fetched.truncatedAt);
      } catch (error) {
        failures.push(`${entry.slug}：抓不到（${error?.name || 'ERROR'} ${error?.message || error}）`);
        continue;
      }
    }

    const result = extractMain(html, { url: entry.url, status });
    const baselineChars = collapse(decodeEntities(stripTags(html))).length;
    const head = oneLine(result.text).slice(0, 120);

    rows.push({ entry, result, baselineChars, rawBytes, status, truncated, source, head });

    if (entry.minChars && result.chars < entry.minChars) {
      failures.push(`${entry.slug}：抽出 ${result.chars} 字，< ${entry.minChars}`);
    }
    if (entry.minChars && !['full', 'partial'].includes(result.tier)) {
      failures.push(`${entry.slug}：tier=${result.tier}（預期 full/partial）`);
    }
    if (entry.expectTier && result.tier !== entry.expectTier) {
      failures.push(`${entry.slug}：tier=${result.tier}（預期 ${entry.expectTier}）`);
    }
  }

  if (REFRESH || Object.keys(manifest.cases).length > 0) {
    await mkdir(FIXTURE_DIR, { recursive: true });
    const cases = {};
    for (const [slug, item] of Object.entries(manifest.cases)) cases[slug] = { ...item, file: `${slug}.html` };
    await writeFile(
      MANIFEST,
      `${JSON.stringify({ fetchedAt: new Date().toISOString(), maxFixtureBytes: MAX_FIXTURE_BYTES, cases }, null, 2)}\n`,
      'utf8',
    );
  }

  // ── 表格 ──────────────────────────────────────────────────────────────────
  const header = ['#', 'slug', 'status', 'rawBytes', 'baseline', 'chars', 'ratio', 'tier', '前 120 字'];
  const table = rows.map((row, index) => [
    String(index + 1),
    row.entry.slug,
    String(row.status || '-'),
    String(row.rawBytes),
    String(row.baselineChars),
    String(row.result.chars),
    row.result.ratio.toFixed(3),
    row.result.tier,
    row.head || '（無文字）',
  ]);
  const widths = header.map((label, col) =>
    Math.max(label.length, ...table.map((line) => (col === 8 ? 0 : line[col].length))),
  );
  const render = (line) =>
    line.map((cell, col) => (col === 8 ? cell : cell.padEnd(widths[col]))).join(' | ');
  console.log('\n=== B：extractMain 評估（fixture / 網路）===');
  console.log(render(header));
  console.log(widths.map((width) => '-'.repeat(width + 2)).join('|'));
  for (const line of table) console.log(render(line));

  console.log('\n基線對照：baseline = 同一份 HTML 純去標籤（含導覽/頁腳）的字數；chars = 抽出正文；ratio = chars / baseline。');
  for (const row of rows) {
    console.log(
      `- ${row.entry.slug}: baseline ${row.baselineChars} → 正文 ${row.result.chars}（${row.result.reason}）${row.truncated ? '［fixture 已截斷］' : ''}`,
    );
  }

  console.log('\n=== 驗收 ===');
  const blocked = rows.find((row) => row.entry.expectTier === 'blocked');
  console.log(`${blocked && blocked.result.tier === 'blocked' ? '✅' : '❌'} blocked 反例判 blocked（${blocked?.entry.slug || 'missing'} → ${blocked?.result.tier || 'missing'}）`);
  for (const row of rows.filter((item) => item.entry.minChars)) {
    const ok = row.result.chars >= row.entry.minChars && row.result.tier !== 'blocked' && row.result.tier !== 'shell';
    console.log(`${ok ? '✅' : '❌'} ${row.entry.slug}：chars=${row.result.chars}（要求 ≥${row.entry.minChars}），tier=${row.result.tier}`);
  }
  console.log(`\n[extract-eval] ${rows.length} 條，${failures.length === 0 ? '全部通過' : `${failures.length} 條不合格`}`);
  for (const failure of failures) console.log(`  ❌ ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[extract-eval] 失敗：', error);
  process.exitCode = 1;
});
