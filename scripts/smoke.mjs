#!/usr/bin/env node
/**
 * scripts/smoke.mjs —— 不需要 DSH 的煙霧測試
 * ============================================================================
 * 用**假的 ctx** 把插件載起來，證明三件事：
 *   ① `apply(ctx, config)` 不拋錯、註冊出 5 個工具、config 有預設值、家目錄鋪好預設源；
 *   ② 60 秒 tick 真的註冊了（攔 setInterval 拿到回呼），手動觸發一次不拋錯；
 *   ③ 設置頁那條既有通道（`/api/web-watch/*`）能讀、能存、能讀回，**不合格的值會被拒**。
 *
 * 再加：
 *   ④ `web_watch_read`（A）：拒絕 http:// / 非法 URL、真網路讀一條 euobserver 且**回傳不含全文**；
 *      另外用假 fetch 驗 not-html / too-large / 每分鐘 3 次限速（離線可跑）；
 *   ⑤ digest 熔斷（C）：failStreak ≥ 3 出現「## ⚠ 注意」、< 3 不出現；fallback 第 2 個成功不算失敗；
 *   ⑥ 引擎煙霧（真網路）：三節合計 = 預設源數；上輪抓成功的源立刻再跑 = 0 新增。
 *
 * 用法：
 *   node scripts/smoke.mjs              # 全部（含真網路，約 20–60 秒）
 *   node scripts/smoke.mjs --offline    # 跳過真網路那段
 * ============================================================================
 */

import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_SCHEDULE, DEFAULT_SOURCES } from '../lib/state.mjs';
import { SCHEDULE_MIRROR_NOTE, normalizeSources } from '../lib/engine/loader.mjs';
import { buildDigest } from '../lib/engine/digest.mjs';
import { runPull } from '../lib/engine/run.mjs';
import { isInside } from '../lib/engine/store.mjs';
import { extractMain } from '../lib/extract.mjs';
import { READ_LIMITS, readPage, resetReadState } from '../lib/readpage.mjs';
import { RESOLVERS, formatTable, runCases } from '../probe/safeurl-cases.mjs';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OFFLINE = process.argv.includes('--offline');
/** 離線測試一律注入這個假 DNS（不打真 DNS、不碰外網）。 */
const OFFLINE_DNS = RESOLVERS.public;
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? ` —— ${detail}` : ''}`);
  return ok;
}

/* ────────────────────── 假 ctx（記錄註冊、logger、agents、session） ────────────────────── */

function makeCtx(home) {
  const state = { tools: [], routes: [], effects: [], logs: [], updates: [], rows: [] };
  const ctx = {
    logger: {
      info: (msg) => state.logs.push(String(msg)),
      warn: (msg) => state.logs.push(String(msg)),
      error: (msg) => state.logs.push(String(msg)),
    },
    get(key) {
      // ⚠️ 宿主给的是**函数**（dshHomePath(...segments)），不是字符串 —— 照 bili 的用法
      if (key === 'dshHomePath') return (...segments) => join(home, ...segments);
      return undefined;
    },
    tools: {
      register(spec) {
        state.tools.push(spec);
        return spec;
      },
    },
    settings: {
      describe: () => state.rows,
      update: async (ns, patch, revision) => {
        state.updates.push({ ns, patch, revision });
        // 真宿主会就地改 fiber.config + 涨 revision；这里照做，否则「存完读回来」会退回旧值
        const row = state.rows.find((item) => item.ns === ns);
        if (row) {
          row.value = { ...row.value, ...patch };
          row.user = { ...(row.user || {}), ...patch };
          row.revision = Number(revision || row.revision || 1) + 1;
        }
        return true;
      },
    },
    effect(fn, label) {
      const dispose = fn();
      state.effects.push({ label, dispose });
      return dispose;
    },
    webServer: {
      register(spec) {
        state.routes.push(spec);
        return spec;
      },
    },
    agents: {
      get: () => null,
      list: () => [],
    },
  };
  return { ctx, state };
}

/** 直接調路由 handler（不用真的開 server）：模擬 req/res。 */
function callRoute(handler, { method = 'GET', path, body } = {}) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const req = {
      method,
      url: path,
      destroy() {},
      on(event, fn) {
        listeners.set(event, fn);
        return req;
      },
    };
    const timer = setTimeout(() => reject(new Error(`路由超時：${method} ${path}`)), 10_000);
    const res = {
      writeHead() {},
      end(text) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(text || '{}')));
        } catch (e) {
          reject(new Error(`路由回的不是 JSON：${String(text).slice(0, 200)}`));
        }
      },
    };
    Promise.resolve(handler(req, res)).catch((e) => {
      clearTimeout(timer);
      reject(e);
    });
    setImmediate(() => {
      if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)));
      listeners.get('end')?.();
    });
  });
}

function toolByName(state, name) {
  return state.tools.find((spec) => spec?.name === name) || null;
}

/** 用假 ctx 起一次插件（攔 setInterval，回傳 apply 的測試把手）。新段落共用。 */
async function applyWithFakeCtx(home, rows = []) {
  const made = makeCtx(home);
  made.state.rows = rows;
  let handle = null;
  let error = null;
  globalThis.setInterval = (fn, ms) => {
    captured = { fn, ms };
    return { unref() {}, ref() {} };
  };
  try {
    handle = mod.apply(made.ctx, {});
  } catch (e) {
    error = e;
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  return { made, handle, error };
}

/** 假 fetch 回應（A / C 的離線測試用；形狀照真 fetch 要用的那幾個欄位）。 */
function fakeResponse({ status = 200, type = 'text/html; charset=utf-8', body = '', location = null, contentLength = null, url = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return type;
        if (key === 'location') return location;
        if (key === 'content-length') return contentLength == null ? null : String(contentLength);
        return null;
      },
    },
    body: { cancel: async () => {} },
    arrayBuffer: async () => Buffer.from(body, 'utf8'),
  };
}

/** 一段「像正文」的 HTML（假 fetch 用）。 */
function fakeArticleHtml() {
  return `<html><head><title>Fake story</title></head><body><article>
    <p>${'The quick brown fox jumps over the lazy dog. '.repeat(25)}</p>
    <p>${'A second paragraph with enough words to look like real article text. '.repeat(20)}</p>
    <p>${'Third paragraph, still talking about something. '.repeat(20)}</p>
    </article></body></html>`;
}

async function runTool(state, name, args = {}) {
  const spec = toolByName(state, name);
  if (!spec) throw new Error(`没有注册工具 ${name}`);
  // 插件的 tool() 包了一层 execute（过 safe()），这里走同一层
  return spec.execute(args);
}

/* ────────────────────── ① 假 ctx + apply ────────────────────── */

const home1 = mkdtempSync(join(tmpdir(), 'web-watch-smoke-home-'));
console.log(`\n=== ① 假 ctx 載入插件（家目錄 ${home1}）===`);

// 攔 setInterval：拿到 tick 回呼（順便斷言真的是 60 秒）
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let captured = null;
globalThis.setInterval = (fn, ms, ...rest) => {
  captured = { fn, ms };
  return { unref() {}, ref() {} };
};

let mod = null;
let ctxState = null;
let applyError = null;
try {
  mod = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href);
  const made = makeCtx(home1);
  ctxState = made.state;
  mod.apply(made.ctx, {});
} catch (e) {
  applyError = e;
} finally {
  globalThis.setInterval = realSetInterval;
}

check('apply(ctx, config) 不拋錯', applyError === null, applyError ? String(applyError?.stack || applyError).slice(0, 400) : '');
check('导出 name === "web-watch"（跟 cordis.patch.yml 的 id 一致）', mod?.name === 'web-watch', String(mod?.name));
// ⚠️ 2026-10-27 CI 修正：`@deepseek-ai/schemastery` 是可選 peer dep ——
//    CI 不裝它，插件本來就該走「沒有 Config 也照常跑」的降級路徑。
//    偵測方式必須跟插件自己一樣（走 hostdeps 從宿主樹找），不能用本模組的 import
//    —— 否則在「有 DSH 家目錄但沒有本地 node_modules」的環境會誤判。
const { loadHostDeps } = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'hostdeps.mjs')).href);
const hostZ = await loadHostDeps();
const hostHasZ = Boolean(hostZ?.z);
check(
  '导出 Config 與宿主 schemastery 一致（有就導出、沒有就走降級）',
  hostHasZ ? mod?.Config !== undefined : mod?.Config === undefined,
  `hostZ=${hostHasZ} Config=${mod?.Config !== undefined}`,
);

const toolNames = (ctxState?.tools || []).map((spec) => spec?.name).sort();
const wantedTools = ['web_watch_config', 'web_watch_pull', 'web_watch_read', 'web_watch_sources', 'web_watch_status'];
check(
  `工具註冊出 ${wantedTools.length} 個名字`,
  wantedTools.every((name) => toolNames.includes(name)) && toolNames.length === wantedTools.length,
  toolNames.join(', '),
);

const sourcesFile = join(home1, 'web-watch', 'sources.json');
let doc = null;
try {
  doc = JSON.parse(readFileSync(sourcesFile, 'utf8'));
} catch (e) {
  doc = null;
}
check('家目錄鋪好 sources.json', Boolean(doc), sourcesFile);
// ⚠️ 預設源會隨插件演進增減（0.1.3 時是五條：多 euobserver / latimes-world），
//    這裡不寫死條數與 id，一律跟 DEFAULT_SOURCES 對 —— 否則「加一條源」會讓整段煙霧誤紅。
const defaultIds = DEFAULT_SOURCES.map((source) => source.id);
check(
  `預設 ${defaultIds.length} 條源都在（${defaultIds.join(' / ')}）`,
  Boolean(doc) && defaultIds.every((id) => doc.sources.some((s) => s.id === id)),
  doc ? doc.sources.map((s) => s.id).join(', ') : '（讀不到）',
);
check(
  'schedule 預設 = 24h / 09:00 / Asia/Macau',
  Boolean(doc) &&
    doc.schedule.intervalHours === DEFAULT_SCHEDULE.intervalHours &&
    doc.schedule.startAt === DEFAULT_SCHEDULE.startAt &&
    doc.schedule.timezone === DEFAULT_SCHEDULE.timezone,
  doc ? JSON.stringify(doc.schedule) : '（讀不到）',
);

// 工具讀配置（預設值）
const cfgRead = await runTool(ctxState, 'web_watch_config', {});
check(
  'web_watch_config 讀到預設值',
  cfgRead?.ok === true &&
    cfgRead.config?.enabled === true &&
    cfgRead.config?.startAt === '09:00' &&
    cfgRead.config?.intervalHours === 24 &&
    cfgRead.config?.targetSession === '' &&
    cfgRead.config?.ownerName === '你',
  JSON.stringify(cfgRead?.config ?? null),
);
const statusDefaults = await runTool(ctxState, 'web_watch_status', {});
check(
  '新家（還沒有 config.json）⇒ web_watch_status.scheduleSource = defaults',
  statusDefaults?.ok === true && statusDefaults?.scheduleSource === 'defaults' && statusDefaults?.schedule?.startAt === '09:00',
  JSON.stringify({ source: statusDefaults?.scheduleSource, schedule: statusDefaults?.schedule }),
);

/* ────────────────────── ④ web_watch_read（A） ────────────────────── */

console.log('\n=== ④ web_watch_read：拒絕不合格的輸入 ===');
const readHttp = await runTool(ctxState, 'web_watch_read', { url: 'http://example.com/a' });
check('web_watch_read 拒絕 http://（只收 https）', readHttp?.ok === false && /https/.test(String(readHttp.reason)), JSON.stringify(readHttp));

const readBad = await runTool(ctxState, 'web_watch_read', { url: 'not a url' });
check('web_watch_read 拒絕非法 URL', readBad?.ok === false && readBad.code === 'unreachable', JSON.stringify(readBad));

const readUnknownSource = await runTool(ctxState, 'web_watch_read', { url: 'https://euobserver.com/', source: 'nope-not-a-source' });
check('web_watch_read 拒絕不存在的 source id', readUnknownSource?.ok === false && /nope-not-a-source/.test(String(readUnknownSource.reason)), JSON.stringify(readUnknownSource));

if (OFFLINE) {
  console.log('   （--offline：跳過真網路 read 與「連不上的 host」）');
} else {
  const readMissing = await runTool(ctxState, 'web_watch_read', { url: 'https://this-host-does-not-exist.invalid/a' });
  check('web_watch_read 連不上 ⇒ unreachable（有原因，不是靜默）', readMissing?.ok === false && readMissing.code === 'unreachable' && Boolean(readMissing.reason), JSON.stringify(readMissing));

  const readOk = await runTool(ctxState, 'web_watch_read', {
    url: 'https://euobserver.com/244723/calls-mount-for-un-world-food-programme-which-feeds-1-4m-people-in-gaza-to-quit-contract-with-palantir/',
  });
  check(
    'web_watch_read 真網路讀一條 euobserver（tier/chars 合理）',
    readOk?.ok === true && readOk.chars > 800 && readOk.tier !== 'blocked',
    `chars=${readOk?.chars} ratio=${readOk?.ratio} tier=${readOk?.tier}`,
  );
  check(
    '回傳只給摘要（excerpt ≤ 400 字）',
    typeof readOk?.excerpt === 'string' && readOk.excerpt.length <= 400,
    `${readOk?.excerpt?.length} 字`,
  );
  const homeWW = join(home1, 'web-watch');
  check(
    'savedTo 在家目錄內且檔案真的存在',
    typeof readOk?.savedTo === 'string' && isInside(homeWW, readOk.savedTo) && existsSync(readOk.savedTo),
    String(readOk?.savedTo || ''),
  );
  const savedText = readOk?.savedTo && existsSync(readOk.savedTo) ? readFileSync(readOk.savedTo, 'utf8') : '';
  check(
    '存檔沿用快照格式（# 標題 / source 行 / 正文）',
    savedText.startsWith('# ') && savedText.includes('<!-- source: https://') && savedText.length > 1000,
    `${savedText.length} 字`,
  );
  const readJson = JSON.stringify(readOk);
  check(
    '回傳不含全文（JSON 短、且不含存檔正文尾巴）',
    readJson.length < 2000 && savedText.length > 0 && !readJson.includes(savedText.slice(-80).trim()),
    `${readJson.length} chars`,
  );
}

console.log('\n=== ④.5 web_watch_read 的硬限制（假 fetch，離線） ===');
const readHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-read-'));
resetReadState();
const notHtml = await readPage({
  root: readHome,
  url: 'https://read-json.example/a',
  resolve: OFFLINE_DNS,
  fetchImpl: async () => fakeResponse({ type: 'application/json', body: '{"a":1}' }),
});
check('content-type 不是 HTML ⇒ not-html', notHtml.ok === false && notHtml.code === 'not-html', JSON.stringify(notHtml));

resetReadState();
const tooLarge = await readPage({
  root: readHome,
  url: 'https://read-big.example/a',
  resolve: OFFLINE_DNS,
  fetchImpl: async () => fakeResponse({ type: 'text/html', contentLength: READ_LIMITS.maxBytes + 1 }),
});
check('content-length 超過 5MB ⇒ too-large（明確拒絕）', tooLarge.ok === false && tooLarge.code === 'too-large', JSON.stringify(tooLarge));

resetReadState();
const blockedRead = await readPage({
  root: readHome,
  url: 'https://read-403.example/a',
  resolve: OFFLINE_DNS,
  fetchImpl: async () => fakeResponse({ status: 403, type: 'text/html', body: '<title>Just a moment...</title>' }),
});
check('HTTP 403 ⇒ blocked（不把挑戰頁當正文）', blockedRead.ok === false && blockedRead.code === 'blocked', JSON.stringify(blockedRead));

resetReadState();
const rateRows = [];
for (const host of ['read-a.example', 'read-b.example', 'read-c.example', 'read-d.example']) {
  rateRows.push(
    await readPage({
      root: readHome,
      url: `https://${host}/story`,
      resolve: OFFLINE_DNS,
      fetchImpl: async () => fakeResponse({ body: fakeArticleHtml() }),
    }),
  );
}
check(
  '同一分鐘讀 4 次 ⇒ 第 4 次 rate-limited（前 3 次成功）',
  rateRows.slice(0, 3).every((row) => row.ok === true) && rateRows[3].ok === false && rateRows[3].code === 'rate-limited',
  rateRows.map((row) => (row.ok ? 'ok' : row.code)).join(','),
);

/* ────────────────────── ④.7 SSRF 防護：案例表（注入 resolve，零網路） ────────────────────── */

console.log('\n=== ④.7 SSRF 防護：safeurl 案例表（注入 resolve，零網路） ===');
const safeRows = await runCases();
console.log(formatTable(safeRows));
check(
  `safeurl 案例表 ${safeRows.filter((row) => row.ok).length}/${safeRows.length} 符合期望`,
  safeRows.every((row) => row.ok),
  safeRows
    .filter((row) => !row.ok)
    .map((row) => `${row.url} 期望 ${row.expect} 實際 ${row.actual}`)
    .join('; ') || 'http / 帳密 / 埠 / 內網 IP / .local / DNS 內網 / DNS 失敗 / 對照組全對',
);

/* ────────────────────── ④.8 SSRF 端到端：read / 配置 / redirect ────────────────────── */

console.log('\n=== ④.8 SSRF 端到端：內網 URL / 私有源 / 302 到內網 ===');

// ① web_watch_read：內網 URL 在發請求之前就被拒（fetch 一次都不該被呼叫）
resetReadState();
let ssrfFetches = 0;
const ssrfRead = await readPage({
  root: readHome,
  url: 'https://169.254.169.254/latest/meta-data/',
  resolve: OFFLINE_DNS,
  fetchImpl: async () => {
    ssrfFetches += 1;
    throw new Error('不該發出這個請求');
  },
});
check(
  'web_watch_read 對內網 URL ⇒ unsafe-url，且沒有發出任何請求',
  ssrfRead.ok === false && ssrfRead.code === 'unsafe-url' && ssrfFetches === 0,
  `${ssrfRead.code} / fetch=${ssrfFetches} / ${ssrfRead.reason}`,
);

// 也走一次真的工具入口（index.js → readPage）：`https://127.0.0.1/` 是字面值，不需要 DNS
resetReadState();
const toolSsrf = await runTool(ctxState, 'web_watch_read', { url: 'https://127.0.0.1/' });
check(
  'web_watch_read 工具入口也回 unsafe-url（不是靜默放行）',
  toolSsrf?.ok === false && toolSsrf?.code === 'unsafe-url',
  JSON.stringify(toolSsrf),
);

// ② 配置階段：私有 / 本機 / fallbacks 的內網 URL 都進不來
let cfgPrivate = null;
try {
  normalizeSources([{ id: 'ssrf-src', kind: 'rss', url: 'https://192.168.1.1/feed.xml' }]);
} catch (error) {
  cfgPrivate = error;
}
check(
  '配置階段就拒私有 URL（源清單）',
  cfgPrivate?.name === 'ConfigError' && /192\.168\.1\.1/.test(String(cfgPrivate.message)),
  String(cfgPrivate?.message || '（沒有拒絕）'),
);

let cfgLocal = null;
try {
  normalizeSources([{ id: 'ssrf-local', kind: 'rss', url: 'https://localhost/feed.xml' }]);
} catch (error) {
  cfgLocal = error;
}
check(
  '配置階段就拒 localhost（源清單）',
  cfgLocal?.name === 'ConfigError' && /localhost/.test(String(cfgLocal.message)),
  String(cfgLocal?.message || '（沒有拒絕）'),
);

let cfgFallback = null;
try {
  normalizeSources([
    { id: 'ssrf-fb', kind: 'rss', url: 'https://ok.example/feed.xml', fallbacks: ['https://169.254.169.254/'] },
  ]);
} catch (error) {
  cfgFallback = error;
}
check(
  '配置階段就拒 fallbacks 裏的內網 URL',
  cfgFallback?.name === 'ConfigError' && /169\.254\.169\.254/.test(String(cfgFallback.message)),
  String(cfgFallback?.message || '（沒有拒絕）'),
);

// ③ redirect 到內網：假 fetch 模擬 302，只該發出第 1 個請求
resetReadState();
const redirectCalls = [];
const redirectRead = await readPage({
  root: readHome,
  url: 'https://public-redirect.example/a',
  resolve: OFFLINE_DNS,
  fetchImpl: async (target) => {
    redirectCalls.push(String(target));
    return fakeResponse({
      status: 302,
      type: 'text/html',
      location: 'https://169.254.169.254/latest/meta-data/',
      body: '',
    });
  },
});
check(
  'redirect 到內網 ⇒ unsafe-url（沒有跟著跳進去）',
  redirectRead.ok === false && redirectRead.code === 'unsafe-url' && redirectCalls.length === 1,
  `${redirectRead.code} / ${redirectCalls.length} 個請求 / ${redirectRead.reason}`,
);

// tick 註冊 + 手動觸發
check('tick 用 60 秒註冊了 setInterval', captured?.ms === 60_000, captured ? `${captured.ms}ms` : '沒攔到');

// 讓這一跳「沒到期」：預先寫一份 index.json，把三條源的 lastOkAt 設成現在
const nowIso = new Date().toISOString();
const preIndex = { version: 1, updatedAt: nowIso, sources: {} };
for (const source of DEFAULT_SOURCES) {
  preIndex.sources[source.id] = { seenIds: [], seenHashes: [], failures: 0, lastOkAt: nowIso, lastRunAt: nowIso, lastStatus: 'ok', lastCount: 0 };
}
try {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(home1, 'web-watch', 'index.json'), JSON.stringify(preIndex, null, 2), 'utf8');
} catch {
  /* 寫不進去就讓 tick 真跑一輪（結果一樣不拋錯） */
}

let tickError = null;
let tickOut = null;
try {
  tickOut = await captured.fn();
} catch (e) {
  tickError = e;
}
check('手動觸發一次 tick 不拋錯', tickError === null, tickError ? String(tickError?.stack || tickError).slice(0, 300) : JSON.stringify(tickOut ?? null));
check('（這一跳是 not-due，沒去打網路）', tickOut?.reason === 'not-due', JSON.stringify(tickOut ?? null));

// cleanup：跑掉 effect 的 disposer（真宿主卸载时也走这条）
for (const item of ctxState.effects) {
  try {
    if (typeof item.dispose === 'function') item.dispose();
  } catch {
    /* 忽略 */
  }
}
check('ctx.effect 註冊了可清理的 disposer（定時器 + HTTP 路由）', ctxState.effects.length >= 2, ctxState.effects.map((e) => e.label).join(' | '));

/* ────────────────────── ③ 設置頁那條通道（路由） ────────────────────── */

console.log('\n=== ③ 設置頁通道：讀 / 存 / 讀回 / 拒絕不合格的值 ===');

const home2 = mkdtempSync(join(tmpdir(), 'web-watch-smoke-route-'));
globalThis.setInterval = (fn, ms) => {
  captured = { fn, ms };
  return { unref() {}, ref() {} };
};
const made2 = makeCtx(home2);
// 模拟「DSH 原生插件设置页里已经有我们那一行」：这样 POST /config 会真的走
// ctx.settings.update(ns, patch, revision) 那条通道（不然只能拿降级路径）
made2.state.rows = [
  {
    ns: 'web-watch',
    value: { enabled: true, startAt: '09:00', intervalHours: 24, timezone: 'Asia/Macau', targetSession: '', ownerName: '你' },
    base: {},
    user: {},
    revision: 1,
  },
];
try {
  mod.apply(made2.ctx, {});
} finally {
  globalThis.setInterval = realSetInterval;
}
const route = made2.state.routes[0];
check('註冊了 /api/web-watch 路由', route?.path === '/api/web-watch' && route?.kind === 'prefix', JSON.stringify({ path: route?.path, kind: route?.kind }));

const st1 = await callRoute(route.handler, { method: 'GET', path: '/api/web-watch/status' });
check(`GET /status 讀回 ${DEFAULT_SOURCES.length} 條源 + 預設配置`, st1?.ok === true && st1.sources?.length === DEFAULT_SOURCES.length && st1.config?.startAt === '09:00', `sources=${st1?.sources?.length} startAt=${st1?.config?.startAt}`);

const bad = await callRoute(route.handler, { method: 'POST', path: '/api/web-watch/config', body: { startAt: '25:00' } });
check('POST /config 拒絕 startAt=25:00（不寫入）', bad?.ok === false && /startAt/.test(String(bad.error)), JSON.stringify(bad));

const bad2 = await callRoute(route.handler, { method: 'POST', path: '/api/web-watch/config', body: { intervalHours: 0 } });
check('POST /config 拒絕 intervalHours=0（不寫入）', bad2?.ok === false && /intervalHours/.test(String(bad2.error)), JSON.stringify(bad2));

const saved = await callRoute(route.handler, { method: 'POST', path: '/api/web-watch/config', body: { startAt: '08:30', intervalHours: 12.5, ownerName: '大肥魚' } });
check(
  'POST /config 存檔成功（走 ctx.settings.update + config.json）',
  saved?.ok === true && saved.config?.startAt === '08:30' && saved.config?.intervalHours === 12.5 && made2.state.updates.length === 1,
  `host=${JSON.stringify(saved?.host)} updates=${made2.state.updates.length}`,
);
const doc2 = JSON.parse(readFileSync(join(home2, 'web-watch', 'sources.json'), 'utf8'));
check(
  'schedule 鏡像進 sources.json（P1 CLI 讀的就是它）',
  doc2.schedule.startAt === '08:30' && doc2.schedule.intervalHours === 12.5,
  JSON.stringify(doc2.schedule),
);
const st2 = await callRoute(route.handler, { method: 'GET', path: '/api/web-watch/status' });
check('讀回來（GET /status 拿到剛存的 08:30 / 12.5）', st2?.config?.startAt === '08:30' && st2?.config?.intervalHours === 12.5, JSON.stringify(st2?.config));
check('存過 config.json 後 scheduleSource = config.json（真值來源可觀測）', st2?.scheduleSource === 'config.json', String(st2?.scheduleSource));

const badUrl = await callRoute(route.handler, {
  method: 'POST',
  path: '/api/web-watch/sources',
  body: { sources: [{ id: 'x-bad', kind: 'rss', url: 'http://example.com/feed.xml' }] },
});
check('POST /sources 拒絕 http://（只收 https）', badUrl?.ok === false && /https/.test(String(badUrl.error)), JSON.stringify(badUrl));

const badKind = await callRoute(route.handler, {
  method: 'POST',
  path: '/api/web-watch/sources',
  body: { sources: [{ id: 'x-bad', kind: 'nope', url: 'https://example.com/feed.xml' }] },
});
check('POST /sources 拒絕 kind=nope', badKind?.ok === false && /kind/.test(String(badKind.error)), JSON.stringify(badKind));

const badPrivate = await callRoute(route.handler, {
  method: 'POST',
  path: '/api/web-watch/sources',
  body: { sources: [{ id: 'x-ssrf', kind: 'rss', url: 'https://10.0.0.5/feed.xml' }] },
});
check(
  'POST /sources 拒絕內網 URL（設置頁那條路也擋）',
  badPrivate?.ok === false && /10\.0\.0\.5/.test(String(badPrivate.error)),
  JSON.stringify(badPrivate),
);
const afterPrivate = JSON.parse(readFileSync(join(home2, 'web-watch', 'sources.json'), 'utf8'));
check(
  '被拒的內網源沒有寫進 sources.json',
  !afterPrivate.sources.some((item) => item.id === 'x-ssrf'),
  afterPrivate.sources.map((item) => item.id).join(','),
);

const added = await callRoute(route.handler, {
  method: 'POST',
  path: '/api/web-watch/sources',
  body: { sources: [...doc2.sources, { id: 'hn-best', kind: 'rss', role: 'index', url: 'https://hnrss.org/best', maxItems: 5 }] },
});
check('POST /sources 增一條、存得下去', added?.ok === true && added.sources?.length === DEFAULT_SOURCES.length + 1, `sources=${added?.sources?.length}`);
const st3 = await callRoute(route.handler, { method: 'GET', path: '/api/web-watch/sources' });
check(`源清單讀回來（${DEFAULT_SOURCES.length + 1} 條，含健康度）`, st3?.ok === true && st3.sources?.length === DEFAULT_SOURCES.length + 1 && Array.isArray(st3.health), `sources=${st3?.sources?.length} health=${st3?.health?.length}`);
const back = await callRoute(route.handler, { method: 'POST', path: '/api/web-watch/sources', body: { sources: doc2.sources } });
check(`刪回 ${DEFAULT_SOURCES.length} 條（回到預設清單）`, back?.ok === true && back.sources?.length === DEFAULT_SOURCES.length, `sources=${back?.sources?.length}`);

for (const item of made2.state.effects) {
  try {
    if (typeof item.dispose === 'function') item.dispose();
  } catch {
    /* 忽略 */
  }
}

/* ────────────────────── ③.7 config 所有權：啟動自癒 ────────────────────── */

console.log('\n=== ③.7 啟動自癒：sources.schedule 漂移（config 17:30 / sources 09:00）===');

const homeHeal = mkdtempSync(join(tmpdir(), 'web-watch-smoke-heal-'));
mkdirSync(join(homeHeal, 'web-watch'), { recursive: true });
writeFileSync(
  join(homeHeal, 'web-watch', 'config.json'),
  JSON.stringify(
    { enabled: true, startAt: '17:30', intervalHours: 24, timezone: 'Asia/Macau', targetSession: '', ownerName: '你' },
    null,
    2,
  ),
  'utf8',
);
writeFileSync(
  join(homeHeal, 'web-watch', 'sources.json'),
  JSON.stringify(
    {
      version: 1,
      schedule: { ...DEFAULT_SCHEDULE },
      sources: [
        { id: 'heal-probe', kind: 'rss', role: 'full', url: 'https://heal.example/feed.xml', maxItems: 5, trusted: true },
      ],
    },
    null,
    2,
  ),
  'utf8',
);
const healBoot = await applyWithFakeCtx(homeHeal);
await healBoot.handle?.whenIdle?.();
check('啟動自癒：apply 不拋錯（假 ctx）', healBoot.error === null, healBoot.error ? String(healBoot.error).slice(0, 200) : '');
const healedDoc = JSON.parse(readFileSync(join(homeHeal, 'web-watch', 'sources.json'), 'utf8'));
check(
  '啟動自癒：sources.json.schedule 09:00 → 17:30',
  healedDoc.schedule?.startAt === '17:30' && healedDoc.schedule?.intervalHours === 24 && healedDoc.schedule?.timezone === 'Asia/Macau',
  JSON.stringify(healedDoc.schedule),
);
check('鏡像帶 _scheduleMirror 標記（deprecated）', healedDoc._scheduleMirror === SCHEDULE_MIRROR_NOTE, String(healedDoc._scheduleMirror));
const healLog = readFileSync(join(homeHeal, 'web-watch', 'watch.log'), 'utf8');
check(
  '自癒 log 一行：09:00 → 17:30（真值 config.json）',
  healLog.includes('啟動自癒：sources.json.schedule 09:00 → 17:30（真值 config.json）'),
  healLog.split('\n').filter((line) => line.includes('啟動自癒')).join(' | '),
);
check(
  '自癒沒弄丟源清單',
  healedDoc.sources?.length === 1 && healedDoc.sources[0]?.id === 'heal-probe',
  `${healedDoc.sources?.length} 條`,
);
const healStatus = await runTool(healBoot.made.state, 'web_watch_status', {});
check(
  'web_watch_status 回 scheduleSource=config.json（schedule=17:30）',
  healStatus?.scheduleSource === 'config.json' && healStatus?.schedule?.startAt === '17:30',
  JSON.stringify({ source: healStatus?.scheduleSource, schedule: healStatus?.schedule }),
);
for (const item of healBoot.made.state.effects) {
  try {
    if (typeof item.dispose === 'function') item.dispose();
  } catch {
    /* 忽略 */
  }
}

/* ────────────────────── ③.72 config 所有權：升級遷移（只有 sources、沒有 config） ────────────────────── */

console.log('\n=== ③.72 升級遷移：sources.schedule 17:30、沒有 config.json ===');

const homeMigrate = mkdtempSync(join(tmpdir(), 'web-watch-smoke-migrate-'));
mkdirSync(join(homeMigrate, 'web-watch'), { recursive: true });
writeFileSync(
  join(homeMigrate, 'web-watch', 'sources.json'),
  JSON.stringify(
    {
      version: 1,
      schedule: { intervalHours: 24, startAt: '17:30', timezone: 'Asia/Macau' },
      sources: [
        { id: 'migrate-probe', kind: 'rss', role: 'full', url: 'https://migrate.example/feed.xml', maxItems: 5, trusted: true },
      ],
    },
    null,
    2,
  ),
  'utf8',
);
const migrateBoot = await applyWithFakeCtx(homeMigrate);
await migrateBoot.handle?.whenIdle?.();
const migrateCfgFile = join(homeMigrate, 'web-watch', 'config.json');
const migrateCfg = existsSync(migrateCfgFile) ? JSON.parse(readFileSync(migrateCfgFile, 'utf8')) : null;
check(
  '升級遷移：config.json 被寫出來（17:30 / 24h / Asia/Macau）',
  migrateCfg?.startAt === '17:30' && migrateCfg?.intervalHours === 24 && migrateCfg?.timezone === 'Asia/Macau',
  JSON.stringify(migrateCfg),
);
check(
  '升級遷移：log 一行（sources.json.schedule → config.json，一次性）',
  /遷移：sources\.json\.schedule → config\.json（17:30 \/ 24h \/ Asia\/Macau，一次性）/.test(
    readFileSync(join(homeMigrate, 'web-watch', 'watch.log'), 'utf8'),
  ),
  readFileSync(join(homeMigrate, 'web-watch', 'watch.log'), 'utf8').split('\n').filter((line) => line.includes('遷移')).join(' | '),
);
const migrateStatus = await runTool(migrateBoot.made.state, 'web_watch_status', {});
check(
  '升級遷移後 scheduleSource=config.json（不再看 sources）',
  migrateStatus?.scheduleSource === 'config.json' && migrateStatus?.schedule?.startAt === '17:30',
  JSON.stringify({ source: migrateStatus?.scheduleSource, schedule: migrateStatus?.schedule }),
);
for (const item of migrateBoot.made.state.effects) {
  try {
    if (typeof item.dispose === 'function') item.dispose();
  } catch {
    /* 忽略 */
  }
}

/* ────────────────────── ③.75 config 所有權：併發寫入 ────────────────────── */

console.log('\n=== ③.75 併發寫：persistCfg + saveSources 同時觸發 → 兩檔一致、源不丟 ===');

const homeConc = mkdtempSync(join(tmpdir(), 'web-watch-smoke-conc-'));
const concBoot = await applyWithFakeCtx(homeConc);
await concBoot.handle?.whenIdle?.();
const concRoute = concBoot.made.state.routes[0];
const concDoc1 = JSON.parse(readFileSync(join(homeConc, 'web-watch', 'sources.json'), 'utf8'));
const concSources = [
  ...concDoc1.sources,
  { id: 'conc-extra', kind: 'rss', role: 'index', url: 'https://conc.example/feed.xml', maxItems: 3, trusted: true },
];
const [cfgRes, srcRes] = await Promise.all([
  callRoute(concRoute.handler, { method: 'POST', path: '/api/web-watch/config', body: { startAt: '17:30' } }),
  callRoute(concRoute.handler, { method: 'POST', path: '/api/web-watch/sources', body: { sources: concSources } }),
]);
const concCfg = JSON.parse(readFileSync(join(homeConc, 'web-watch', 'config.json'), 'utf8'));
const concDoc2 = JSON.parse(readFileSync(join(homeConc, 'web-watch', 'sources.json'), 'utf8'));
check(
  '併發寫：config.json 與 sources.schedule 一致（都是 17:30）',
  cfgRes?.ok === true && srcRes?.ok === true && concCfg.startAt === '17:30' && concDoc2.schedule?.startAt === '17:30',
  `config=${concCfg.startAt} sources=${concDoc2.schedule?.startAt}`,
);
check(
  '併發寫：源清單沒丟（多一條 conc-extra）',
  concDoc2.sources?.length === DEFAULT_SOURCES.length + 1 && concDoc2.sources.some((row) => row.id === 'conc-extra'),
  `${concDoc2.sources?.length} 條`,
);
check(
  '併發寫：interval / timezone 也一致（沒有 09:00 殘留）',
  concCfg.intervalHours === 24 && concDoc2.schedule?.intervalHours === 24 && concDoc2.schedule?.timezone === 'Asia/Macau',
  JSON.stringify(concDoc2.schedule),
);
for (const item of concBoot.made.state.effects) {
  try {
    if (typeof item.dispose === 'function') item.dispose();
  } catch {
    /* 忽略 */
  }
}

/* ────────────────────── ③.8 P1 CLI：三層優先級 + 一次性遷移 ────────────────────── */

// ⚠️ 2026-10-27 CI 修正：P1 CLI 是工作區的參照實作，住在插件目錄的**兄弟目錄** web-watch/。
//    repo 檢出（GitHub Actions）時那裡什麼都沒有 —— 這不是缺陷，跳過即可，別讓 CI 紅。
const cliSrcDir = join(PLUGIN_DIR, '..', 'web-watch');
const hasP1Cli = existsSync(join(cliSrcDir, 'pull.mjs'));

if (!hasP1Cli) {
  console.log('\n=== ③.8 P1 CLI：跳過（旁邊沒有 web-watch/；repo 檢出時屬正常） ===');
} else {
  console.log('\n=== ③.8 P1 CLI：config.json → sources.json（一次性遷移）→ defaults ===');

  check('P1 CLI 在旁邊的 web-watch/（工作區）', true, cliSrcDir);

const cliHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-cli-'));
copyFileSync(join(cliSrcDir, 'pull.mjs'), join(cliHome, 'pull.mjs'));
cpSync(join(cliSrcDir, 'lib'), join(cliHome, 'lib'), { recursive: true });
const cliSourceRow = { id: 'cli-probe', kind: 'rss', role: 'full', url: 'https://cli.example/feed.xml', maxItems: 5, trusted: true };
writeFileSync(
  join(cliHome, 'sources.json'),
  JSON.stringify({ version: 1, schedule: { ...DEFAULT_SCHEDULE }, sources: [cliSourceRow] }, null, 2),
  'utf8',
);
const cliNow = new Date().toISOString();
writeFileSync(
  join(cliHome, 'index.json'),
  JSON.stringify(
    {
      version: 1,
      updatedAt: cliNow,
      sources: { 'cli-probe': { seenIds: [], seenHashes: [], failures: 0, lastOkAt: cliNow, lastRunAt: cliNow, lastStatus: 'ok', lastCount: 0 } },
    },
    null,
    2,
  ),
  'utf8',
);

/** 跑一輪 CLI（--tick，index 剛寫過 ⇒ not-due，不打網路）。stdout 用檔案接（沙箱不給 pipe）。 */
function runCli(cwd) {
  const outFile = join(cwd, 'cli.out.txt');
  const errFile = join(cwd, 'cli.err.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  try {
    const result = spawnSync(process.execPath, [join(cwd, 'pull.mjs'), '--tick'], {
      cwd,
      stdio: ['ignore', outFd, errFd],
    });
    return { status: result.status, stdout: readFileSync(outFile, 'utf8'), stderr: readFileSync(errFile, 'utf8'), error: result.error };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

const cliRun1 = runCli(cliHome);
check(
  'CLI 第一輪（只有 sources 09:00、沒有 config.json）exit 0 且 not-due',
  cliRun1.status === 0 && /not-due/.test(cliRun1.stdout),
  `exit=${cliRun1.status} stderr=${cliRun1.stderr.slice(0, 150)}`,
);
const cliCfg1 = existsSync(join(cliHome, 'config.json')) ? JSON.parse(readFileSync(join(cliHome, 'config.json'), 'utf8')) : null;
check(
  'CLI 一次性遷移：config.json 被寫出來（09:00 / 24h / Asia/Macau）',
  cliCfg1?.startAt === '09:00' && cliCfg1?.intervalHours === 24 && cliCfg1?.timezone === 'Asia/Macau',
  JSON.stringify(cliCfg1),
);
check(
  'CLI 遷移有 log 一行（sources.json.schedule 09:00 → config.json）',
  /遷移：sources\.json\.schedule 09:00 → config\.json/.test(cliRun1.stdout),
  cliRun1.stdout.split('\n').filter((line) => line.includes('遷移')).join(' | '),
);

const cliDoc2 = JSON.parse(readFileSync(join(cliHome, 'sources.json'), 'utf8'));
cliDoc2.schedule.startAt = '08:00';
writeFileSync(join(cliHome, 'sources.json'), JSON.stringify(cliDoc2, null, 2), 'utf8');
const cliRun2 = runCli(cliHome);
check(
  'CLI 第二輪用 config.json 的 09:00（不是 sources 的 08:00）',
  cliRun2.status === 0 && /\[schedule\] 09:00 \/ 24h \/ Asia\/Macau（來源：config\.json）/.test(cliRun2.stdout),
  cliRun2.stdout.split('\n').find((line) => line.startsWith('[schedule]')) || '(沒有 schedule 行)',
);
check(
  'CLI 退役生效：第二輪不再遷移，config.json 仍 09:00',
  !/遷移：sources/.test(cliRun2.stdout) && JSON.parse(readFileSync(join(cliHome, 'config.json'), 'utf8')).startAt === '09:00',
  cliRun2.stdout.split('\n').filter((line) => line.includes('遷移')).join(' | ') || '（沒有再遷移）',
);

unlinkSync(join(cliHome, 'config.json'));
const cliDoc3 = JSON.parse(readFileSync(join(cliHome, 'sources.json'), 'utf8'));
delete cliDoc3.schedule;
writeFileSync(join(cliHome, 'sources.json'), JSON.stringify(cliDoc3, null, 2), 'utf8');
const cliRun3 = runCli(cliHome);
check(
  'CLI 兩邊都沒有 ⇒ 用 DEFAULT_SCHEDULE（來源 defaults），也不建 config.json',
  cliRun3.status === 0 &&
    /\[schedule\] 09:00 \/ 24h \/ Asia\/Macau（來源：defaults）/.test(cliRun3.stdout) &&
    !existsSync(join(cliHome, 'config.json')),
  cliRun3.stdout.split('\n').find((line) => line.startsWith('[schedule]')) || '(沒有 schedule 行)',
  );
}

/* ────────────────────── ⑤ 源健康與熔斷（C，離線） ────────────────────── */

console.log('\n=== ⑤ 源健康：failStreak ≥ 3 的注意節 / fallbacks ===');

const failedStub = (id, streak) => ({
  sourceId: id,
  source: { id, url: `https://${id}.example/feed`, role: 'full' },
  ok: false,
  section: 'failed',
  entries: [],
  fresh: [],
  knownCount: 0,
  failure: { reason: 'HTTP 403' },
  failuresCount: streak,
  failStreak: streak,
});
const digestOf = (results) =>
  buildDigest({ now: new Date('2026-10-25T09:00:00+08:00'), schedule: { ...DEFAULT_SCHEDULE }, results, cleanup: { removed: 0, remaining: 1 } }).markdown;

const warn3 = digestOf([failedStub('dead-source', 3)]);
check(
  'failStreak = 3 ⇒ digest 出現「## ⚠ 注意」',
  warn3.includes('## ⚠ 注意') && /dead-source 連續失敗 3 次（HTTP 403）/.test(warn3),
  warn3.split('\n').filter((line) => line.startsWith('## ') || line.startsWith('- dead')).join(' | '),
);
check(
  '注意節在最前面（標題之後、變動之前）',
  warn3.indexOf('## ⚠ 注意') > warn3.indexOf('# web-watch') && warn3.indexOf('## ⚠ 注意') < warn3.indexOf('## 變動'),
  String(warn3.indexOf('## ⚠ 注意')),
);
const warn2 = digestOf([failedStub('flaky-source', 2)]);
check('failStreak = 2 ⇒ 整節不出現（不留空節）', !warn2.includes('⚠ 注意'), warn2.split('\n').filter((line) => line.startsWith('## ')).join(' | '));

// fallbacks：第 1 個端點 HTTP 500，第 2 個成功 ⇒ 不算失敗
const fbHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-fallback-'));
const fbSource = normalizeSources([
  {
    id: 'fb-test',
    kind: 'rss',
    url: 'https://primary.example/feed.xml',
    fallbacks: ['https://backup.example/feed.xml'],
  },
])[0];
const rssBody =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>'
  + '<item><title>Hello fallback</title><link>https://example.com/a</link><guid>fb-1</guid>'
  + '<description>Body text for the fallback item.</description></item></channel></rss>';
const fbCalls = [];
const fbRun = await runPull({
  homeDir: fbHome,
  sources: [fbSource],
  schedule: { ...DEFAULT_SCHEDULE },
  resolve: OFFLINE_DNS,
  fetchImpl: async (url) => {
    fbCalls.push(String(url));
    if (String(url).includes('primary.example')) return fakeResponse({ status: 500, type: 'text/plain' });
    return fakeResponse({ status: 200, type: 'application/rss+xml', body: rssBody });
  },
  log: () => {},
});
const fbIndex = JSON.parse(readFileSync(join(fbHome, 'index.json'), 'utf8'));
const fbState = fbIndex.sources?.['fb-test'] || {};
check(
  'fallback 第 2 個成功 ⇒ 不算失敗（failures=0 / failStreak=0）',
  fbRun.counts.failedSources === 0 && fbRun.counts.newEntries === 1 && fbState.failures === 0 && fbState.failStreak === 0,
  `failed=${fbRun.counts.failedSources} new=${fbRun.counts.newEntries} failures=${fbState.failures} failStreak=${fbState.failStreak}`,
);
check('fallback 真的依序試過兩個端點', fbCalls.some((url) => url.includes('primary.example')) && fbCalls.some((url) => url.includes('backup.example')), `${fbCalls.length} 次請求`);

// fallbacks：兩個都失敗 ⇒ 記 failed，原因註明試過幾個端點
const failHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-fallback-fail-'));
const failSource = normalizeSources([
  {
    id: 'fb-fail',
    kind: 'rss',
    url: 'https://primary2.example/feed.xml',
    fallbacks: ['https://backup2.example/feed.xml'],
  },
])[0];
const failRun = await runPull({
  homeDir: failHome,
  sources: [failSource],
  schedule: { ...DEFAULT_SCHEDULE },
  resolve: OFFLINE_DNS,
  fetchImpl: async () => fakeResponse({ status: 500, type: 'text/plain' }),
  log: () => {},
});
check(
  'fallback 全失敗 ⇒ failed，原因註明「試過 2 個端點」',
  failRun.failed.length === 1 && /試過 2 個端點/.test(String(failRun.failed[0].reason)),
  JSON.stringify(failRun.failed),
);
check('第一次失敗 ⇒ failStreak = 1', failRun.results[0]?.failStreak === 1, String(failRun.results[0]?.failStreak));

let fbRejected = null;
try {
  normalizeSources([{ id: 'fb-bad', kind: 'rss', url: 'https://ok.example/feed.xml', fallbacks: ['http://bad.example/feed.xml'] }]);
} catch (error) {
  fbRejected = error;
}
check('fallbacks 也要過 https 校驗', fbRejected?.name === 'ConfigError' && /https/.test(fbRejected.message), String(fbRejected?.message || '沒有拒絕'));

// kind=html 已改走 extractMain（不是 identity 透傳）
const htmlHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-html-'));
const htmlSource = normalizeSources([{ id: 'html-test', kind: 'html', url: 'https://html.example/story' }])[0];
const htmlRun = await runPull({
  homeDir: htmlHome,
  sources: [htmlSource],
  schedule: { ...DEFAULT_SCHEDULE },
  resolve: OFFLINE_DNS,
  fetchImpl: async () => fakeResponse({ body: fakeArticleHtml() }),
  log: () => {},
});
const htmlEntry = htmlRun.results?.[0]?.fresh?.[0] || null;
check(
  'kind=html 走 extractMain（adapter=extract、不再 identity）',
  htmlRun.counts.newEntries === 1 && htmlEntry?.adapter === 'extract' && !String(htmlEntry?.body || '').includes('<'),
  `new=${htmlRun.counts.newEntries} adapter=${htmlEntry?.adapter} tier=${htmlEntry?.tier}`,
);

// 0.1.10：extractMain 的 strategy 擴展點（契約見 docs/extract.md）
const strategyHtml =
  '<!doctype html><html><head><title>策略煙霧</title></head><body><article>' +
  '<p>預設算法會抽到這段正文，用來跟自訂策略對照。</p></article></body></html>';
const strategyInjected = extractMain(strategyHtml, {
  strategy: (html, context) => ({ text: context.title, how: 'smoke-title' }),
});
check(
  'extractMain 可注入 strategy（text 由策略決定，不走預設算法）',
  strategyInjected.text === '策略煙霧' && strategyInjected.chars === 4 && strategyInjected.ok === true,
  `text=${JSON.stringify(strategyInjected.text)} chars=${strategyInjected.chars} tier=${strategyInjected.tier}`,
);
const strategyDefault = extractMain(strategyHtml, {});
check(
  '不傳 strategy 仍走預設算法（兩條路徑不串味）',
  strategyDefault.text.includes('預設算法會抽到這段正文') && strategyDefault.text !== strategyInjected.text,
  `tier=${strategyDefault.tier}`,
);
let strategyThrew = null;
let strategyDegraded = null;
try {
  strategyDegraded = extractMain(strategyHtml, {
    strategy: () => {
      throw new Error('smoke-boom');
    },
  });
} catch (error) {
  strategyThrew = error;
}
check(
  '非法 strategy ⇒ 安全降級 shell（不拋到調用方）',
  strategyThrew === null &&
    strategyDegraded?.ok === false &&
    strategyDegraded?.tier === 'shell' &&
    /自訂策略失效/.test(String(strategyDegraded?.reason || '')),
  strategyThrew ? `拋了：${strategyThrew.message}` : `tier=${strategyDegraded?.tier} reason=${strategyDegraded?.reason}`,
);

/* ────────────────────── ⑤.5 SSRF：引擎端（私有源 / 302 內網，離線） ────────────────────── */

console.log('\n=== ⑤.5 SSRF：引擎端（私有源 / 302 到內網，離線假 fetch） ===');

// 私有源：loader 已經在配置階段擋掉，這裡直接餵手工 source 給 runPull，驗「抓取時也擋」
const ssrfEngineHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-ssrf-engine-'));
let ssrfEngineFetches = 0;
const privateSource = {
  id: 'ssrf-engine',
  kind: 'rss',
  role: 'full',
  url: 'https://10.0.0.5/feed.xml',
  maxItems: 10,
  trusted: true,
  fallbacks: [],
};
const privateRun = await runPull({
  homeDir: ssrfEngineHome,
  sources: [privateSource],
  schedule: { ...DEFAULT_SCHEDULE },
  resolve: OFFLINE_DNS,
  fetchImpl: async () => {
    ssrfEngineFetches += 1;
    return fakeResponse({ status: 200, type: 'application/rss+xml', body: rssBody });
  },
  log: () => {},
});
check(
  '引擎拒絕私有源 ⇒ failed（code unsafe-url、failStreak=1、請求沒發出去）',
  privateRun.counts.failedSources === 1 &&
    privateRun.results[0]?.failure?.code === 'unsafe-url' &&
    privateRun.results[0]?.failStreak === 1 &&
    ssrfEngineFetches === 0,
  `failed=${privateRun.counts.failedSources} code=${privateRun.results[0]?.failure?.code} fetch=${ssrfEngineFetches} reason=${privateRun.results[0]?.failure?.reason}`,
);

// 引擎 redirect：公開 feed 302 到 metadata ⇒ 只該發出第 1 個請求
const ssrfRedirectHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-ssrf-redirect-'));
const ssrfRedirectCalls = [];
const redirectSource = {
  id: 'ssrf-redirect',
  kind: 'rss',
  role: 'full',
  url: 'https://feed-redirect.example/rss',
  maxItems: 10,
  trusted: true,
  fallbacks: [],
};
const redirectRun = await runPull({
  homeDir: ssrfRedirectHome,
  sources: [redirectSource],
  schedule: { ...DEFAULT_SCHEDULE },
  resolve: OFFLINE_DNS,
  fetchImpl: async (target) => {
    ssrfRedirectCalls.push(String(target));
    return fakeResponse({
      status: 302,
      type: 'application/rss+xml',
      location: 'https://169.254.169.254/latest/meta-data/',
      body: '',
    });
  },
  log: () => {},
});
check(
  '引擎 redirect 到內網 ⇒ unsafe-url（只發 1 個請求，沒跟著跳）',
  redirectRun.counts.failedSources === 1 &&
    redirectRun.results[0]?.failure?.code === 'unsafe-url' &&
    ssrfRedirectCalls.length === 1,
  `failed=${redirectRun.counts.failedSources} code=${redirectRun.results[0]?.failure?.code} requests=${ssrfRedirectCalls.length}`,
);

// 不安全的主 URL + 安全的 fallback ⇒ 換端點後照樣成功（不是整條源報廢）
const ssrfFallbackHome = mkdtempSync(join(tmpdir(), 'web-watch-smoke-ssrf-fallback-'));
const ssrfFallbackCalls = [];
const unsafePrimary = {
  id: 'ssrf-fallback',
  kind: 'rss',
  role: 'full',
  url: 'https://10.9.9.9/feed.xml',
  maxItems: 10,
  trusted: true,
  fallbacks: ['https://good.example/feed.xml'],
};
const ssrfFallbackRun = await runPull({
  homeDir: ssrfFallbackHome,
  sources: [unsafePrimary],
  schedule: { ...DEFAULT_SCHEDULE },
  resolve: OFFLINE_DNS,
  fetchImpl: async (target) => {
    ssrfFallbackCalls.push(String(target));
    return fakeResponse({ status: 200, type: 'application/rss+xml', body: rssBody });
  },
  log: () => {},
});
check(
  '不安全的主 URL + 安全 fallback ⇒ 走 fallback 成功（只打 1 次、打在 fallback 上）',
  ssrfFallbackRun.counts.failedSources === 0 &&
    ssrfFallbackRun.counts.newEntries === 1 &&
    ssrfFallbackCalls.length === 1 &&
    String(ssrfFallbackCalls[0]).includes('good.example'),
  `failed=${ssrfFallbackRun.counts.failedSources} new=${ssrfFallbackRun.counts.newEntries} calls=${JSON.stringify(ssrfFallbackCalls)}`,
);

/* ────────────────────── ⑥ 引擎煙霧（真網路） ────────────────────── */

if (OFFLINE) {
  console.log('\n=== ⑥ 引擎煙霧：--offline，跳過真網路 ===');
} else {
  /* ── ③.5 tick 真的跑到 runPull（一條源，省時間） ── */
  console.log('\n=== ③.5 tick 真的會去跑（一條源的真網路） ===');
  const home4 = mkdtempSync(join(tmpdir(), 'web-watch-smoke-tick-'));
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(home4, 'web-watch'), { recursive: true });
    writeFileSync(
      join(home4, 'web-watch', 'sources.json'),
      JSON.stringify(
        {
          version: 1,
          schedule: { ...DEFAULT_SCHEDULE },
          sources: [
            {
              id: 'steam-news',
              kind: 'json',
              role: 'full',
              url: 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=2',
              path: 'appnews.newsitems',
              idPath: 'gid',
              titlePath: 'title',
              linkPath: 'url',
              bodyPath: 'contents',
              datePath: 'date',
              maxItems: 2,
              trusted: true,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (e) {
    check('準備 tick 測試的家目錄', false, String(e?.message ?? e));
  }
  globalThis.setInterval = (fn, ms) => {
    captured = { fn, ms };
    return { unref() {}, ref() {} };
  };
  const made4 = makeCtx(home4);
  try {
    mod.apply(made4.ctx, {});
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  let tick4 = null;
  let tick4Error = null;
  try {
    tick4 = await captured.fn();
  } catch (e) {
    tick4Error = e;
  }
  check('tick（從未跑過 ⇒ due）真的跑去抓了，且不拋錯', tick4Error === null && tick4?.ran === true, tick4Error ? String(tick4Error?.message ?? tick4Error) : JSON.stringify(tick4?.summary?.counts ?? tick4));
  const tickDigest = tick4?.summary?.digestPath;
  check('tick 寫出了 digest', Boolean(tickDigest), String(tickDigest || ''));
  for (const item of made4.state.effects) {
    try {
      if (typeof item.dispose === 'function') item.dispose();
    } catch {
      /* 忽略 */
    }
  }

  console.log(`\n=== ⑥ 引擎煙霧：${DEFAULT_SOURCES.length} 條真源跑兩輪 ===`);
  const home3 = mkdtempSync(join(tmpdir(), 'web-watch-smoke-engine-'));
  const sources = normalizeSources(DEFAULT_SOURCES);
  const sourceCount = sources.length;
  const schedule = { ...DEFAULT_SCHEDULE };
  const logs = [];
  const log = (msg) => logs.push(String(msg));

  let first = null;
  let second = null;
  let engineError = null;
  try {
    first = await runPull({ homeDir: home3, sources, schedule, log });
    second = await runPull({ homeDir: home3, sources, schedule, log });
  } catch (e) {
    engineError = e;
  }
  check('引擎跑一輪不拋錯', engineError === null, engineError ? String(engineError?.stack || engineError).slice(0, 400) : `requests=${first?.requests} bytes=${first?.bytes}`);

  if (first) {
    const digestText = first.digestPath ? readFileSync(first.digestPath, 'utf8') : '';
    check('產出 digest 檔', Boolean(first.digestPath && digestText.length > 0), String(first.digestPath || ''));
    const rows = first.counts.changedSources + first.counts.unchangedSources + first.counts.failedSources;
    check(`三節合計 = ${sourceCount}（每個源都有結果行）`, rows === sourceCount && first.counts.rows === sourceCount, `變動 ${first.counts.changedSources} + 沒變 ${first.counts.unchangedSources} + 抓不到 ${first.counts.failedSources} = ${rows}`);
    check(
      'digest 三節標題都在',
      ['## 變動', '## 沒變', '## 抓不到'].every((head) => digestText.includes(head)),
      digestText.split('\n').filter((line) => line.startsWith('## ')).join(' | '),
    );
    const outside = (first.writePaths || []).filter((file) => !isInside(home3, file));
    check('所有寫入都在家目錄內', outside.length === 0, `${first.writePaths?.length} 個寫入，越界 ${outside.length}`);
    check('self-check 全綠', first.checksOk === first.checksTotal, `${first.checksOk}/${first.checksTotal}${first.checks?.filter((c) => !c.ok).map((c) => ` FAIL:${c.name}`).join('') || ''}`);
    check('新一輪有東西進來（或全部抓不到，但沒有例外）', first.counts.newEntries > 0 || first.counts.failedSources > 0, `新增 ${first.counts.newEntries} / 抓不到 ${first.counts.failedSources}`);
  }
  if (second) {
    // ⚠️ 舊斷言是「第二次跑全域 0 新增」—— 但第一輪只要有一個源網路失敗（steam-news 就常超時），
    //    第二輪重試成功必然把它那幾條當新條目，於是「去重壞了」的假紅。
    //    去重該保證的是：**上一輪抓成功的源，這一輪 0 新增**。失敗源的重試不算。
    const firstFailed = new Set((first?.failed || []).map((item) => item.id));
    const unexpected = second.results
      .filter((result) => result.ok && !firstFailed.has(result.sourceId) && result.fresh.length > 0)
      .map((result) => `${result.sourceId}:${result.fresh.length}`);
    check(
      '立刻再跑一次：上輪抓成功的源 0 新增（去重沒被移植弄壞）',
      unexpected.length === 0,
      unexpected.length
        ? `意外新增 ${unexpected.join(', ')}`
        : `新增 ${second.counts.newEntries} 條（上輪失敗、本輪重試的源：${[...firstFailed].join(',') || '無'}）`,
    );
    check(`第二次跑：三節合計仍 = ${sourceCount}`, second.counts.rows === sourceCount, `${second.counts.rows}`);
  }
  console.log(`   家目錄（留著看）：${home3}`);
}

/* ────────────────────── 總結 ────────────────────── */

const passed = results.filter((item) => item.ok).length;
console.log(`\n[smoke] ${passed}/${results.length} ok`);
if (failures > 0) {
  console.log('[smoke] FAIL：');
  for (const item of results.filter((entry) => !entry.ok)) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ''}`);
  process.exitCode = 1;
} else {
  console.log('[smoke] 全部通過');
}
