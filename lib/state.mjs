/**
 * lib/state.mjs —— 插件的「家」、預設值、落盤小工具
 * ============================================================================
 * 規矩（照 dsh-bili-subagent 的 lib/state.mjs）：
 *   **配置、快照、digest、日誌都放插件自己的家** —— `<DSH_HOME>\web-watch\`，
 *   **絕不寫進插件包目錄**（裝進 node_modules 後可能只讀、升級也會被覆蓋）。
 *
 * 家裏的東西（0.1.7 起「一個值只有一個家」）：
 *   config.json    插件配置；**schedule（startAt / intervalHours / timezone）的唯一真值**
 *   sources.json   源清單 + schedule **兼容鏡像**（deprecated：由插件寫，手改會被覆蓋）
 *   index.json     去重與健康度（只由程式寫）
 *   pages/<host>/  快照
 *   out/           digest（每輪一份 .md）
 *   watch.log      這個插件自己的日誌（宿主 logger 之外再留一份，排查不用翻控制台）
 *
 * ⚠️ 2026-10-14 bili 那邊踩到的坑，照抄一遍教訓（lib/state.mjs:30-49）：
 *   `ctx.get('dshHomePath')` 返回的是**函數**不是字串 —— `dshHomePath(...segments)`。
 *   當字串用會拼出「函數源碼 + \web-watch」⇒ mkdir ENOENT ⇒ apply 拋錯 ⇒ 插件不激活。
 * ============================================================================
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { assertInside } from './engine/store.mjs';
import { SCHEDULE_MIRROR_NOTE } from './engine/loader.mjs';

/** 預設 schedule（跟 P1 的 sources.json 一致）。 */
export const DEFAULT_SCHEDULE = Object.freeze({
  intervalHours: 24,
  startAt: '09:00',
  timezone: 'Asia/Macau',
});

/**
 * 三條預設源（P1 實測留下的那三條，一字不改）。
 * 其餘（APNews / cve.now 這類 Cloudflare 硬牆）刻意不納入 —— 見 web-watch-plan.md 第 1、5 節。
 */
export const DEFAULT_SOURCES = Object.freeze([
  Object.freeze({
    id: 'cgtn-world',
    kind: 'rss',
    role: 'full',
    url: 'https://www.cgtn.com/subscribe/rss/section/world.xml',
    maxItems: 10,
    trusted: true,
  }),
  Object.freeze({
    id: 'tech-weekly-index',
    kind: 'rss',
    role: 'index',
    url: 'https://awesome-tech-weekly-zh.netlify.app/feed.xml',
    maxItems: 10,
    trusted: true,
  }),
  Object.freeze({
    id: 'steam-news',
    kind: 'json',
    role: 'full',
    url: 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=5',
    path: 'appnews.newsitems',
    idPath: 'gid',
    titlePath: 'title',
    linkPath: 'url',
    bodyPath: 'contents',
    datePath: 'date',
    maxItems: 5,
    trusted: true,
  }),
  Object.freeze({
    id: 'euobserver',
    kind: 'rss',
    role: 'full',
    url: 'https://euobserver.com/feed/',
    maxItems: 10,
    trusted: true,
  }),
  Object.freeze({
    id: 'latimes-world',
    kind: 'rss',
    role: 'index',
    url: 'https://www.latimes.com/world-nation/rss2.0.xml',
    maxItems: 10,
    trusted: true,
  }),
]);

/** 首次运行要落地的那份 sources.json。
 *  ⚠️ 裏面的 `schedule` 只是**兼容鏡像**（照 DEFAULT_SCHEDULE 鋪）；真值在 config.json。
 */
export function defaultSourcesDoc() {
  return {
    version: 1,
    _scheduleMirror: SCHEDULE_MIRROR_NOTE,
    schedule: { ...DEFAULT_SCHEDULE },
    sources: DEFAULT_SOURCES.map((source) => ({ ...source })),
  };
}

/**
 * 插件家目錄：`<DSH_HOME>\web-watch\`（拿不到宿主那條就退回 $DSH_HOME / ~\.dsh）。
 * @returns {string} 絕對路徑（已 mkdir）
 */
export function stateDirOf(ctx) {
  let dir = '';
  try {
    const p = ctx?.get?.('dshHomePath');
    if (typeof p === 'function') {
      const v = p('web-watch'); // ← 函數形態：把目錄名傳進去
      if (v) dir = String(v);
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'web-watch');
    }
  } catch {
    /* 拿不到就用下面的兜底 */
  }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'web-watch');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/**
 * 寫 JSON；給了 root 就先 assertInside（呼叫端一律傳家目錄）。
 * ⚠️ 0.1.7：`config.json` / `sources.json` 的「讀 + 寫」要排進 index.js 的 writeQueue
 *    （createWriteQueue）；這個函式只負責寫，不負責排序。`ensureHome` 是啟動時一次性鋪底，
 *    發生在任何併發之前，所以不用排隊；`appendLog` 也不排隊（寫不進去不影響一致性）。
 */
export function writeJson(file, value, root) {
  const target = root ? assertInside(root, file) : file;
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 一條 promise 寫入隊列（0.1.7）。
 * ============================================================================
 * 事故：兩條寫入路徑各自「讀 cfg → 寫檔」，其中一條讀到舊值 ⇒ config.json 17:30、
 *       sources.json 09:00，mtime 卻停在同一次操作。
 * 規矩：**凡是會動 config.json / sources.json 的「讀 + 寫」都排進同一條隊列**；
 *       任務裏讀到的 cfg 與寫出去的檔必須是同一個快照。
 * 用法：
 *   const chain = createWriteQueue();
 *   const value = await chain.enqueue(() => { ...同步讀寫...; return x; });
 *   await chain.whenIdle();   // 測試 / 卸載前等所有排隊寫入落地
 * 隊列本身永不 reject（前一個任務失敗不會卡死後續），失敗只回給呼叫端。
 */
export function createWriteQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(task) {
      const run = tail.then(task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    whenIdle() {
      return tail;
    },
  };
}

/** 家目錄的日誌（寫不進去也不致命；越界不寫、也不炸）。 */
export function appendLog(stateDir, msg) {
  const line = `${new Date().toISOString()}  ${msg}`;
  try {
    const file = assertInside(stateDir, join(stateDir, 'watch.log'));
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* 日誌寫不進去 / 越界都不影響運行 */
  }
}

/**
 * 首次運行鋪好家目錄：`sources.json` 沒有就寫預設那三條，`pages/`、`out/` 建好。
 * **不覆蓋已有的 sources.json**（使用者的配置是神聖的）。
 */
export function ensureHome(stateDir, log = () => {}) {
  const out = { created: [], kept: [] };
  for (const dir of ['pages', 'out']) {
    const full = assertInside(stateDir, join(stateDir, dir));
    try {
      mkdirSync(full, { recursive: true });
    } catch (e) {
      log(`建 ${full} 失敗：${e?.message ?? e}`);
    }
  }
  const sourcesFile = join(stateDir, 'sources.json');
  if (!existsSync(sourcesFile)) {
    try {
      writeJson(sourcesFile, defaultSourcesDoc(), stateDir);
      out.created.push('sources.json');
      log(`已鋪好預設 sources.json（3 條源）→ ${sourcesFile}`);
    } catch (e) {
      log(`鋪 sources.json 失敗：${e?.message ?? e}`);
    }
  } else {
    out.kept.push('sources.json');
  }
  return out;
}

/** 家目錄裏的固定檔名（別在別處拼字串）。 */
export function homePaths(stateDir) {
  return {
    dir: stateDir,
    config: join(stateDir, 'config.json'),
    sources: join(stateDir, 'sources.json'),
    index: join(stateDir, 'index.json'),
    pages: join(stateDir, 'pages'),
    out: join(stateDir, 'out'),
    log: join(stateDir, 'watch.log'),
  };
}

/** 最新的 digest 檔（給 web_watch_status / status 路由用；沒有就 null）。 */
export function latestDigest(stateDir) {
  const outDir = join(stateDir, 'out');
  try {
    const files = readdirSync(outDir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort();
    if (files.length === 0) return null;
    const name = files[files.length - 1];
    return { name, file: join(outDir, name), count: files.length };
  } catch {
    return null;
  }
}
