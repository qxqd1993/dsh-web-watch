/**
 * lib/engine/run.mjs —— 「跑一輪」的可呼叫版本
 * ============================================================================
 * P1 的 `pull.mjs` 是 CLI：argv / console / process.exit 混在編排流程裏。
 * 插件用不到 argv，所以這裏把**編排流程**抽出來（tick 與 web_watch_pull 都調它），
 * 抓取 / 限速 / 去重 / 落檔 / digest 的邏輯**一行沒改**，全部照搬 P1。
 *
 * 與 P1 的差異只有這幾處（其餘逐行相同）：
 *   1. 根目錄由呼叫端傳（`homeDir` = `<DSH_HOME>\web-watch`），不再有 ROOT 常數、不碰 cwd；
 *   2. 沒有 console：一律走 `log(msg)` 回呼；
 *   3. 沒有 exit code / 參數解析 / self-check 印字：self-check 的結果以 `checks` 陣列回傳；
 *   4. 靜態自檢只掃本目錄（engine）—— 插件的 HTTP / 設置頁那幾檔不歸它管。
 *
 * 三條硬性預算照舊：單輪 ≤30 請求、≤20MB、同 host 間隔 ≥1s。
 *
 * 🔒 SSRF（0.1.9）：主 URL 與**每一個** fallback 都先過 `lib/safeurl.mjs`（形狀 + 字面值 + DNS）；
 *    不合格 ⇒ 這個端點判 `UNSAFE`（對外 code `unsafe-url`，照樣計入 failures / failStreak），
 *    換下一個 fallback，**請求不會發出去**。redirect 也改成自己跟（`redirect:'manual'`），
 *    每一跳重新檢查 —— 公開 feed 302 到 `169.254.169.254` 不會被跟進去。
 * ============================================================================
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError } from './loader.mjs';
import {
  evaluateDue,
  formatFileStamp,
  formatLocalStamp,
  formatZonedIso,
} from './schedule.mjs';
import { parseFeed } from './rss.mjs';
import { extractJson } from './jsonp.mjs';
import { extractMain } from '../extract.mjs';
import { checkPublicHttpsUrl, checkPublicHttpsUrlSync } from '../safeurl.mjs';
import { classifyEntries, mergeSeen } from './dedupe.mjs';
import { buildDigest } from './digest.mjs';
import {
  ensureLayout,
  getSourceState,
  isInside,
  planPrune,
  prunePages,
  readIndex,
  snapshotPath,
  writeDigestFile,
  writeIndex,
  writeSnapshot,
} from './store.mjs';

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const LIMITS = Object.freeze({
  maxRequests: 30,
  maxBytes: 20 * 1024 * 1024,
  minHostGapMs: 1_000,
  timeoutMs: 15_000,
  maxRetries: 1,
  maxRedirects: 5,
});

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class SourceError extends Error {
  constructor(reason, code = 'SOURCE', detail = '') {
    super(reason);
    this.name = 'SourceError';
    this.reason = reason;
    this.code = code;
    this.detail = detail;
  }
}

function short(value, max = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relFromRoot(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function respectHostGap(host, budget, log) {
  const last = budget.hostLastStart.get(host);
  if (last !== undefined) {
    const target = last + LIMITS.minHostGapMs;
    const wait = target - Date.now();
    if (wait > 0) {
      log(`[fetch] 同 host 間隔不足，等 ${wait + 2}ms（${host}）`);
      await sleep(wait + 2);
    }
    budget.hostGaps.push(Date.now() - last);
  }
  budget.hostLastStart.set(host, Date.now());
}

const FAILURE_CODES = {
  UNSAFE: 'unsafe-url',
  BUDGET: 'budget',
  HTTP: 'http',
  NETWORK: 'network',
  PARSE: 'parse',
  CONFIG: 'config',
  WRITE: 'write',
  REDIRECT: 'redirect',
  SOURCE: 'source',
};

/** SourceError.code → 對外可讀的失敗分類（新增 `unsafe-url`）。 */
function failureCodeOf(error) {
  if (!(error instanceof SourceError)) return 'error';
  return FAILURE_CODES[error.code] || String(error.code || 'source').toLowerCase();
}

async function fetchOne({ source, url, budget, log, fetchImpl, resolve }) {
  const accept =
    source.kind === 'json'
      ? 'application/json,text/json;q=0.9,*/*;q=0.8'
      : source.kind === 'rss'
        ? 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'
        : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';

  for (let attempt = 0; attempt <= LIMITS.maxRetries; attempt += 1) {
    let made = 0; // 這次嘗試真的發出去幾個請求（含 redirect 每一跳）
    let current = url;
    let hops = 0;
    try {
      for (;;) {
        if (budget.requests >= LIMITS.maxRequests) {
          throw new SourceError('本輪請求數已達 30 上限', 'BUDGET');
        }
        if (budget.bytes >= LIMITS.maxBytes) {
          throw new SourceError('本輪下載量已達 20MB 上限', 'BUDGET');
        }
        await respectHostGap(new URL(current).hostname, budget, log);
        budget.requests += 1;
        made += 1;

        log(`[fetch] ${source.id} GET ${current}（第 ${attempt + 1} 次${hops > 0 ? `，redirect ${hops}` : ''}）`);
        const response = await fetchImpl(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(LIMITS.timeoutMs),
          headers: {
            'user-agent': UA,
            accept,
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });

        // 🔒 redirect 自己跟：每一跳都重新過 safeurl，不讓公開 feed 把我們 302 進內網
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            try {
              await response.body?.cancel();
            } catch {
              /* 已取消或沒有 body */
            }
            if (hops >= LIMITS.maxRedirects) {
              throw new SourceError(`redirect 超過 ${LIMITS.maxRedirects} 跳`, 'REDIRECT');
            }
            let nextUrl;
            try {
              nextUrl = new URL(location, current).toString();
            } catch {
              throw new SourceError('redirect 的 Location 不是合法 URL', 'REDIRECT');
            }
            const next = await checkPublicHttpsUrl(nextUrl, { resolve });
            if (!next.ok) {
              throw new SourceError(`redirect 到不安全的位址：${next.reason}`, 'UNSAFE');
            }
            current = next.url;
            hops += 1;
            continue;
          }
        }

        const declared = Number(response.headers.get('content-length') || 0);
        if (Number.isFinite(declared) && declared > 0 && budget.bytes + declared > LIMITS.maxBytes) {
          try {
            await response.body?.cancel();
          } catch {
            /* 已取消或沒有 body */
          }
          throw new SourceError('本輪下載量將超過 20MB 上限', 'BUDGET');
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        budget.bytes += buffer.byteLength;
        if (budget.bytes > LIMITS.maxBytes) {
          throw new SourceError('本輪下載量超過 20MB 上限', 'BUDGET');
        }

        if (!response.ok) {
          const error = new SourceError(`HTTP ${response.status}`, 'HTTP');
          error.status = response.status;
          throw error;
        }

        // 🔒 第二道：核對「實際回應的位址」（redirect 已是 manual，正常等於 current）
        const provided = String(response.url || '');
        if (provided) {
          const shape = checkPublicHttpsUrlSync(provided);
          if (!shape.ok) {
            throw new SourceError(`回應的最終位址不合格：${shape.reason}`, 'UNSAFE');
          }
        }

        log(
          `[fetch] ${source.id} -> ${response.status} ${buffer.byteLength}B ${response.headers.get('content-type') || ''}`,
        );

        return {
          text: buffer.toString('utf8'),
          requests: made,
          bytes: buffer.byteLength,
          status: response.status,
          finalUrl: provided || current,
          contentType: response.headers.get('content-type') || '',
        };
      }
    } catch (error) {
      if (error instanceof SourceError) {
        if (!(error.requests >= made)) error.requests = made;
        throw error;
      }

      const rawCode = error?.cause?.code || error?.code;
      const timedOut =
        error?.name === 'TimeoutError' || rawCode === 23 || rawCode === 'ABORT_ERR';
      const code = timedOut ? 'TIMEOUT' : rawCode || error?.name || 'NETWORK';
      if (attempt < LIMITS.maxRetries) {
        log(`[fetch] ${source.id} ${code}，重試一次`);
        continue;
      }
      const failure = new SourceError(String(code), 'NETWORK', error?.message || String(error));
      failure.requests = made;
      throw failure;
    }
  }
  throw new SourceError('抓取失敗', 'NETWORK');
}

/**
 * 抓一個源：主 URL → `fallbacks`（可選）依序試，**全部失敗才**記 failed，
 * 失敗原因裏註明試過幾個端點。預算（請求數 / 位元組）用盡就不再試。
 * 🔒 每一個端點（含 fallbacks）在發請求之前都先過 SSRF 檢查；不合格的端點直接跳過。
 */
async function fetchSource(source, budget, log, fetchImpl, resolve) {
  const urls = [source.url, ...(Array.isArray(source.fallbacks) ? source.fallbacks : [])];
  let lastError = null;
  for (let index = 0; index < urls.length; index += 1) {
    const checked = await checkPublicHttpsUrl(urls[index], { resolve });
    if (!checked.ok) {
      lastError = new SourceError(`不安全的 URL：${checked.reason}`, 'UNSAFE');
      lastError.requests = 0;
      if (index < urls.length - 1) {
        log(`[fetch] ${source.id} 端點 ${index + 1}/${urls.length} 被 SSRF 防護擋下（${checked.reason}），試下一個 fallback`);
      }
      continue;
    }
    try {
      const fetched = await fetchOne({ source, url: checked.url, budget, log, fetchImpl, resolve });
      if (index > 0) log(`[fetch] ${source.id} fallback #${index} 成功：${checked.url}`);
      return fetched;
    } catch (error) {
      if (!(error instanceof SourceError) || error.code === 'BUDGET') throw error;
      lastError = error;
      if (index < urls.length - 1) {
        log(
          `[fetch] ${source.id} 端點 ${index + 1}/${urls.length} 失敗（${error.reason}），試下一個 fallback`,
        );
      }
    }
  }
  const reason = urls.length > 1 ? `${lastError.reason}（試過 ${urls.length} 個端點）` : lastError.reason;
  const failure = new SourceError(reason, lastError.code, lastError.detail);
  failure.requests = lastError.requests;
  if (lastError.status) failure.status = lastError.status;
  throw failure;
}

async function runSource({ homeDir, source, state, now, timeZone, budget, write, log, fetchImpl, resolve }) {
  const startedAt = Date.now();
  const result = {
    sourceId: source.id,
    source,
    ok: false,
    section: 'failed',
    entries: [],
    fresh: [],
    knownCount: 0,
    hashOnlyCount: 0,
    recordGuids: [],
    recordHashes: [],
    lastHash: null,
    failure: null,
    failuresCount: state.failures || 0,
    failStreak: state.failStreak || 0,
    prevFailures: state.failures || 0,
    requests: 0,
    bytes: 0,
    snapshots: [],
    planned: [],
    durationMs: 0,
  };

  try {
    const fetched = await fetchSource(source, budget, log, fetchImpl, resolve);
    result.requests = fetched.requests;
    result.bytes = fetched.bytes;

    let parsed;
    try {
      if (source.kind === 'rss') {
        parsed = parseFeed(fetched.text, source);
      } else if (source.kind === 'json') {
        let payload;
        try {
          payload = JSON.parse(fetched.text);
        } catch (error) {
          throw new SourceError(`JSON 解析失敗：${short(error.message)}`, 'PARSE');
        }
        parsed = extractJson(payload, source);
      } else if (source.kind === 'html') {
        const document = extractMain(fetched.text, {
          url: fetched.finalUrl || source.url,
          status: fetched.status,
        });
        if (!document.ok) {
          throw new SourceError(`正文抽取失敗（tier=${document.tier}：${document.reason}）`, 'PARSE');
        }
        parsed = {
          entries: [
            {
              title: document.title || source.id,
              link: source.url,
              guid: source.url,
              date: null,
              body: document.text,
              adapter: 'extract',
              tier: document.tier,
              lowConfidence: document.tier !== 'full',
              summaryOnly: false,
            },
          ],
        };
      } else {
        throw new SourceError(`未知 kind：${source.kind}`, 'CONFIG');
      }
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(`解析失敗：${short(error.message)}`, 'PARSE', error.stack);
    }

    if (!parsed.entries || parsed.entries.length === 0) {
      throw new SourceError('解析到 0 條', 'PARSE');
    }

    const classified = classifyEntries(parsed.entries, state);
    result.entries = classified.all;
    result.fresh = classified.fresh;
    result.knownCount = classified.knownCount;
    result.hashOnlyCount = classified.hashUnchangedCount;
    result.recordGuids = classified.recordGuids;
    result.recordHashes = classified.recordHashes;
    result.lastHash = classified.lastHash;

    const host = new URL(source.url).hostname;
    if (write) {
      try {
        for (const entry of classified.fresh) {
          const file = await writeSnapshot(homeDir, {
            sourceId: source.id,
            host,
            title: entry.title,
            url: entry.link || source.url,
            dateIso: entry.date ? formatZonedIso(entry.date, timeZone) : formatZonedIso(now, timeZone),
            body: entry.body,
            hash: entry.hash,
          });
          result.snapshots.push(file);
          budget.writes.push(file);
        }
      } catch (error) {
        if (error?.code === 'PATH_VIOLATION') throw error;
        throw new SourceError(`寫檔失敗：${short(error.message)}`, 'WRITE', error.stack);
      }
    } else {
      for (const entry of classified.fresh) {
        result.planned.push(
          snapshotPath(homeDir, { sourceId: source.id, host, hash: entry.hash }),
        );
      }
    }

    result.ok = true;
    result.failStreak = 0;
    result.section = classified.fresh.length > 0 ? 'changed' : 'unchanged';
  } catch (error) {
    if (error?.code === 'PATH_VIOLATION') throw error;
    result.ok = false;
    result.section = 'failed';
    result.failure =
      error instanceof SourceError
        ? { reason: error.reason, detail: error.detail || '', code: failureCodeOf(error) }
        : { reason: error?.code || error?.name || 'ERROR', detail: short(error?.message || String(error)), code: 'error' };
    result.failuresCount = (state.failures || 0) + 1;
    result.failStreak = (state.failStreak || 0) + 1;
    if (Number.isInteger(error?.requests) && error.requests > result.requests) {
      result.requests = error.requests;
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

function applyResult(index, result, now) {
  const previous = getSourceState(index, result.sourceId);
  const state = { ...previous };
  if (result.ok) {
    state.seenIds = mergeSeen(previous.seenIds, result.recordGuids);
    state.seenHashes = mergeSeen(previous.seenHashes, result.recordHashes);
    state.failures = 0;
    state.failStreak = 0;
    state.lastOkAt = now.toISOString();
    state.lastHash = result.lastHash;
    state.lastRunAt = now.toISOString();
    state.lastStatus = 'ok';
    state.lastCount = result.entries.length;
  } else {
    state.failures = (previous.failures || 0) + 1;
    state.failStreak = (previous.failStreak || 0) + 1;
    state.lastRunAt = now.toISOString();
    state.lastStatus = result.failure.reason;
  }
  index.sources[result.sourceId] = state;
  result.failuresCount = state.failures;
}

/** 靜態自檢：engine 目錄裏沒有第三方 import、沒有 eval/Function/vm/child_process。 */
async function auditStaticSafety() {
  const noDeps = [];
  const noExec = [];
  const banned = ['ev' + 'al(', 'new ' + 'Function(', 'node:' + 'vm', 'node:' + 'child_process', 'node:' + 'worker_threads'];
  let names = [];
  try {
    names = (await readdir(ENGINE_DIR)).filter((name) => name.endsWith('.mjs')).sort();
  } catch {
    return { noDeps: ['(engine 目錄讀不到)'], noExec: [] };
  }
  for (const name of names) {
    const text = await readFile(path.join(ENGINE_DIR, name), 'utf8');
    for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      const allowed =
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../');
      if (!allowed) noDeps.push(`${name} -> ${specifier}`);
    }
    for (const token of banned) {
      if (text.includes(token)) noExec.push(`${name} 含 ${token}`);
    }
  }
  return { noDeps, noExec };
}

/**
 * 把一輪的結果丟進 self-check（P1 的 11 條減掉 CLI 專屬的那幾條）。
 * 不印字、不 exit：只回傳 `[{name, ok, detail}]`，由呼叫端決定怎麼顯示。
 */
async function verifyRun({ homeDir, runnable, results, counts, index, budget, cleanup, writePaths }) {
  const staticIssues = await auditStaticSafety();
  const checks = [];

  const outside = writePaths.filter((file) => !isInside(homeDir, file));
  checks.push({ name: '寫入只在家目錄內', ok: outside.length === 0, detail: `${writePaths.length} 個寫入` });
  checks.push({ name: '單輪請求 ≤ 30', ok: budget.requests <= LIMITS.maxRequests, detail: String(budget.requests) });
  checks.push({
    name: '單輪下載 ≤ 20MB',
    ok: budget.bytes <= LIMITS.maxBytes,
    detail: `${(budget.bytes / 1024).toFixed(1)}KB`,
  });

  const minGap = budget.hostGaps.length > 0 ? Math.min(...budget.hostGaps) : null;
  checks.push({
    name: '同 host 間隔 ≥ 1s',
    ok: minGap === null || minGap >= LIMITS.minHostGapMs,
    detail: minGap === null ? '每 host 只 1 次' : `${minGap}ms`,
  });

  checks.push({
    name: '每個源都有結果行',
    ok: results.length === runnable.length && counts.rows === runnable.length,
    detail: `${counts.rows}/${runnable.length}`,
  });
  checks.push({
    name: '失敗帶原因',
    ok: results.every((result) => result.ok || (result.failure && result.failure.reason)),
    detail: results.filter((result) => !result.ok).map((result) => result.sourceId).join(',') || '0',
  });
  checks.push({
    name: 'failures 累加正確',
    ok: results.every((result) => {
      const state = index.sources[result.sourceId];
      if (!state) return false;
      return result.ok ? state.failures === 0 : state.failures === result.prevFailures + 1;
    }),
    detail: results.map((result) => `${result.sourceId}:${index.sources[result.sourceId]?.failures ?? '?'}`).join(' '),
  });
  checks.push({ name: '快照 ≤ 200 份', ok: cleanup.remaining <= 200, detail: `${cleanup.remaining} 份` });
  checks.push({
    name: '無第三方依賴',
    ok: staticIssues.noDeps.length === 0,
    detail: staticIssues.noDeps.join('; ') || 'all node:/relative',
  });
  checks.push({
    name: '無 JS/動態執行、內容只當數據',
    ok: staticIssues.noExec.length === 0,
    detail: staticIssues.noExec.join('; ') || 'no eval/Function/vm/child_process',
  });
  checks.push({
    name: '單源錯誤隔離',
    ok: results.length === runnable.length,
    detail: `${results.length}/${runnable.length}`,
  });

  return checks;
}

/** 摘要用：前 N 條（含出處），給工具 / tick 訊息用。 */
function topEntriesOf(results, limit = 3) {
  const out = [];
  for (const result of results) {
    for (const entry of result.fresh) {
      out.push({
        source: result.sourceId,
        title: String(entry.title ?? '').slice(0, 200),
        link: String(entry.link || result.source.url),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * 判斷這一輪有哪些源到期（tick 用）。
 * @returns {Promise<{index:object, due:string[], skipped:Array<{id:string,nextAt:string|null}>}>}
 */
export async function dueSourceIds({ homeDir, sources, schedule, now = new Date() }) {
  const index = await readIndex(homeDir);
  const due = [];
  const skipped = [];
  for (const source of sources) {
    const state = getSourceState(index, source.id);
    const decided = evaluateDue({ source, state, schedule, now });
    if (decided.due) due.push(source.id);
    else skipped.push({ id: source.id, nextAt: decided.nextAt ? decided.nextAt.toISOString() : null });
  }
  return { index, due, skipped };
}

/**
 * 跑一輪。
 * @param {object} opts
 * @param {string} opts.homeDir 插件家目錄（所有寫入都在它以內）
 * @param {Array} opts.sources 已校驗的源清單（loader.normalizeSources 的產物）
 * @param {object} opts.schedule 已校驗的 schedule（{intervalHours,startAt,timezone}）
 * @param {Date} [opts.now] 覆寫「現在」（測 due / digest 檔名用）
 * @param {string[]} [opts.only] 只跑這些 id（省略 = 全部）
 * @param {boolean} [opts.dryRun] 只抓不寫檔
 * @param {number} [opts.skippedCount] digest 末尾註明「另有 N 個源未到期」
 * @param {Function} [opts.fetchImpl] 測試用：替換 fetch（預設 globalThis.fetch）
 * @param {Function} [opts.resolve] 測試用：替換 DNS（safeurl 用；預設 dns.lookup）
 * @param {(msg:string)=>void} [opts.log]
 */
export async function runPull({
  homeDir,
  sources,
  schedule,
  now = new Date(),
  only = [],
  dryRun = false,
  skippedCount = 0,
  fetchImpl = fetch,
  resolve,
  log = () => {},
} = {}) {
  if (!homeDir) throw new ConfigError('runPull 缺 homeDir');
  if (!schedule || typeof schedule !== 'object') throw new ConfigError('runPull 缺 schedule');
  if (!Array.isArray(sources) || sources.length === 0) throw new ConfigError('sources 必須是非空陣列');
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new ConfigError('runPull 的 now 不是合法時間');

  const timeZone = schedule.timezone;
  const wanted = new Set((Array.isArray(only) ? only : []).map(String));
  if (wanted.size > 0) {
    const known = new Set(sources.map((source) => source.id));
    for (const id of wanted) {
      if (!known.has(id)) throw new ConfigError(`源 ${id} 不存在（可用：${[...known].join(', ')}）`);
    }
  }
  const runnable = wanted.size > 0 ? sources.filter((source) => wanted.has(source.id)) : [...sources];

  log(
    `[run] ${formatLocalStamp(at, timeZone)}，${runnable.length} 個源${dryRun ? '（dry-run）' : ''}`,
  );

  const budget = {
    requests: 0,
    bytes: 0,
    hostLastStart: new Map(),
    hostGaps: [],
    writes: [],
  };

  if (!dryRun) await ensureLayout(homeDir);

  const index = await readIndex(homeDir);
  const results = [];
  for (const source of runnable) {
    const state = getSourceState(index, source.id);
    const result = await runSource({ homeDir, source, state, now: at, timeZone, budget, write: !dryRun, log, fetchImpl, resolve });
    results.push(result);
    if (result.ok) {
      log(`[ok] ${result.sourceId} ${result.source.kind}：${result.entries.length} 條，新增 ${result.fresh.length}`);
    } else {
      log(`[fail] ${result.sourceId} ${result.source.kind}：${result.failure.reason}（累計 ${result.failuresCount} 次）`);
    }
  }

  const totalNew = results.reduce((sum, result) => sum + result.fresh.length, 0);
  const unchangedCount = results.filter((result) => result.section === 'unchanged').length;
  const failedCount = results.filter((result) => result.section === 'failed').length;

  const summary = {
    ok: true,
    dryRun,
    at: at.toISOString(),
    timezone: timeZone,
    ran: runnable.map((source) => source.id),
    results,
    counts: {
      newEntries: totalNew,
      changedSources: results.filter((result) => result.section === 'changed').length,
      unchangedSources: unchangedCount,
      failedSources: failedCount,
      rows: results.length,
    },
    top: topEntriesOf(results, 3),
    unchanged: results.filter((result) => result.section === 'unchanged').map((result) => result.sourceId),
    failed: results
      .filter((result) => result.section === 'failed')
      .map((result) => ({ id: result.sourceId, reason: result.failure.reason, failures: result.failuresCount })),
    requests: budget.requests,
    bytes: budget.bytes,
    digestPath: null,
    digestName: null,
    cleanup: { removed: 0, remaining: 0 },
    checks: [],
    writePaths: [],
  };

  if (dryRun) {
    const { plan, total } = await planPrune(homeDir, at);
    summary.plannedDigest = `out/${formatFileStamp(at, timeZone)}.md`;
    summary.plannedPrune = plan.length;
    // ⚠️ 2026-10-24 修：dry-run 不寫檔，「寫入邊界 / digest 三節」這類自檢無從驗起，
    //    但磁碟現況要照實報 —— 原本 remaining 寫死 0，配上空的 checks 陣列，
    //    格式化那邊就吐出 "undefined/undefined ok"，比不報還糟。
    summary.cleanup = { removed: 0, remaining: total };
    summary.checksOk = null;
    summary.checksTotal = null;
    summary.checksNote = 'dry-run：不寫檔，寫入類自檢未執行';
    return summary;
  }

  const writePaths = [];
  for (const result of results) {
    applyResult(index, result, at);
    writePaths.push(...result.snapshots);
  }

  const indexFile = await writeIndex(homeDir, index, at);
  writePaths.push(indexFile);

  const cleanup = await prunePages(homeDir, at);
  const { markdown, counts } = buildDigest({
    now: at,
    schedule,
    results,
    cleanup,
    skippedCount,
  });
  const digestFile = await writeDigestFile(homeDir, `${formatFileStamp(at, timeZone)}.md`, markdown);
  writePaths.push(digestFile);

  summary.counts = counts;
  summary.digestPath = digestFile;
  summary.digestName = relFromRoot(homeDir, digestFile);
  summary.cleanup = cleanup;
  summary.writePaths = writePaths;
  summary.checks = await verifyRun({
    homeDir,
    runnable,
    results,
    counts,
    index,
    budget,
    cleanup,
    writePaths,
  });
  summary.checksOk = summary.checks.filter((check) => check.ok).length;
  summary.checksTotal = summary.checks.length;

  log(`digest: ${summary.digestName}（變動 ${counts.newEntries} 條 / 沒變 ${counts.unchangedSources} 源 / 抓不到 ${counts.failedSources} 源）`);
  log(`清理：刪除 ${cleanup.removed} 份，現有 ${cleanup.remaining} 份`);

  return summary;
}
