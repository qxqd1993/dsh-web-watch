/**
 * lib/readpage.mjs —— `web_watch_read` 的實作（A）
 * ============================================================================
 * 讀**一條**連結的正文：抓 HTML → extractMain 抽正文 → 全文落 `<家目錄>\pages\read\`，
 * 只回摘要（excerpt 最多 400 字），**全文不進模型**。
 *
 * 硬限制（超過就明確拒絕，不靜默截斷）：
 *   - 只收 https、一次一個 URL、URL 不帶帳密；
 *   - timeout 15s、回應上限 5MB、redirect ≤ 5 跳；
 *   - 同一 host 兩次請求間隔 ≥ 1s；每分鐘最多 3 次「讀取呼叫」（記憶體計數）。
 *
 * 🔒 SSRF（0.1.9）：**每一次要發出去的請求**（含每一跳 redirect）都先過
 *   `lib/safeurl.mjs`：只放行公開的 https 位址，私有 / loopback / link-local / `.local`
 *   / 解析到內網的域名一律拒 ⇒ `code: 'unsafe-url'`。redirect 改成自己跟（`redirect:'manual'`），
 *   所以「公開 URL → 302 內網」也在發請求前就被擋掉，而不是跟著跳進去。
 *
 * 失敗分類：blocked / unreachable / not-html / too-large / rate-limited / unsafe-url，
 * 每個都帶可讀 reason。
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { extractMain } from './extract.mjs';
import { assertInside } from './engine/store.mjs';
import { checkPublicHttpsUrl, checkPublicHttpsUrlSync } from './safeurl.mjs';

export const READ_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  minHostGapMs: 1_000,
  perMinute: 3,
});

/**
 * ⚠️ 2026-11-04：**不要改回偽裝的瀏覽器 UA。**
 *
 * 這裡原本自稱 Chrome 131（「假裝自己是瀏覽器就不會被擋」）。實測結果相反：
 * UN News（news.un.org）的 WAF 對偽裝 UA 回 **406 Not Acceptable**，對誠實自報回 **200**
 * —— 自稱瀏覽器但 TLS/header 指紋不是，反而被判成爬蟲。
 *
 * 驗過的目標（偽裝 vs 誠實）：
 *   cgtn 文章頁 200/200、euobserver 文章頁 200/200、latimes 文章頁 200/200、
 *   **news.un.org 文章頁 406/200**、五個源的 feed 全 200/200。
 * 也就是誠實 UA 沒有一個目標更差。
 *
 * 而且自報身分本來就是這個專案的原則：不繞 Cloudflare / 驗證牆。
 * 偽裝 UA 是貼著線走的，現在證明它既違反原則、又沒有好處。
 */
const UA = 'dsh-web-watch (+https://github.com/qxqd1993/dsh-web-watch)';

/** 每次真發出去的請求（含 redirect）；同一 host 之間至少隔 1s。 */
const lastByHost = new Map();
/** 最近一分鐘的「讀取呼叫」時間戳（不是 redirect 次數）。 */
const recentCalls = [];

/** 測試用：清掉限速記憶體（真正宿主裡不需要）。 */
export function resetReadState() {
  lastByHost.clear();
  recentCalls.length = 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function fail(url, code, reason) {
  return { ok: false, url, code, reason };
}

/**
 * safeurl 的 code → `web_watch_read` 對外的 code。
 * ⚠️ 只有「位址本身不安全」（private-host）才新增 `unsafe-url`；其餘（協議 / 帳密 / 埠 /
 * 壞 URL / 解析不到）維持原本的 `unreachable` —— 不偷偷改既有回傳語義。
 */
function readCode(code) {
  return code === 'private-host' ? 'unsafe-url' : 'unreachable';
}

function takeQuota(nowMs) {
  const cutoff = nowMs - 60_000;
  while (recentCalls.length > 0 && recentCalls[0] < cutoff) recentCalls.shift();
  if (recentCalls.length >= READ_LIMITS.perMinute) {
    return { ok: false, reason: `每分鐘最多 ${READ_LIMITS.perMinute} 次（剛才已用滿，請稍後再讀）` };
  }
  recentCalls.push(nowMs);
  return { ok: true };
}

async function respectHostGap(host, nowMs) {
  const last = lastByHost.get(host);
  if (last !== undefined) {
    const wait = last + READ_LIMITS.minHostGapMs - nowMs;
    if (wait > 0) await sleep(wait + 5);
  }
  lastByHost.set(host, Date.now());
}

/** 手動跟 redirect（才知道跳了幾次、中途有沒有掉回 http，**每一跳都重新過 safeurl**）。 */
async function fetchHtml(startUrl, fetchImpl, resolve) {
  let current = startUrl;
  for (let hop = 0; hop <= READ_LIMITS.maxRedirects; hop += 1) {
    await respectHostGap(current.hostname, Date.now());
    let response;
    try {
      response = await fetchImpl(current.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(READ_LIMITS.timeoutMs),
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        },
      });
    } catch (error) {
      const code = error?.cause?.code || error?.code || error?.name || 'NETWORK';
      const timedOut = error?.name === 'TimeoutError' || code === 23 || code === 'ABORT_ERR';
      return { error: fail(current.toString(), 'unreachable', timedOut ? '連線逾時（15s）' : `連不上：${code}`) };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      try {
        await response.body?.cancel();
      } catch {
        /* 沒有 body 就算了 */
      }
      if (!location) return { error: fail(current.toString(), 'unreachable', `HTTP ${response.status} 但沒有 Location`) };
      if (hop === READ_LIMITS.maxRedirects) {
        return { error: fail(current.toString(), 'unreachable', `redirect 超過 ${READ_LIMITS.maxRedirects} 跳`) };
      }
      // 🔒 每一跳都重新檢查：公開 URL 302 到內網，在這裡就被擋下（請求還沒發出去）
      let nextUrl;
      try {
        nextUrl = new URL(location, current).toString();
      } catch {
        return { error: fail(current.toString(), 'unreachable', 'redirect 的 Location 不是合法 URL') };
      }
      const next = await checkPublicHttpsUrl(nextUrl, { resolve });
      if (!next.ok) {
        return {
          error: fail(current.toString(), readCode(next.code), `redirect 到不合格的位址：${next.reason}`),
        };
      }
      current = new URL(next.url);
      continue;
    }

    if (response.status === 403 || response.status === 429) {
      try {
        await response.body?.cancel();
      } catch {
        /* 同上 */
      }
      return { error: fail(current.toString(), 'blocked', `HTTP ${response.status}（站點拒絕：可能是 Cloudflare / 驗證牆）`) };
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* 同上 */
      }
      return { error: fail(current.toString(), 'unreachable', `HTTP ${response.status}`) };
    }

    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|application\/xhtml\+xml/.test(type)) {
      try {
        await response.body?.cancel();
      } catch {
        /* 同上 */
      }
      return { error: fail(current.toString(), 'not-html', `不是 HTML（content-type: ${short(type) || '（沒給）'}）`) };
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > READ_LIMITS.maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        /* 同上 */
      }
      return { error: fail(current.toString(), 'too-large', `檔案太大（content-length ${declared}B > ${READ_LIMITS.maxBytes}B）`) };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > READ_LIMITS.maxBytes) {
      return { error: fail(current.toString(), 'too-large', `檔案太大（${buffer.byteLength}B > ${READ_LIMITS.maxBytes}B）`) };
    }
    // 🔒 最後再核對一次「實際回應的位址」（第二道；redirect 已是 manual，正常會等於 current）
    const provided = String(response.url || '');
    if (provided) {
      const finalCheck = checkPublicHttpsUrlSync(provided);
      if (!finalCheck.ok) {
        return {
          error: fail(current.toString(), readCode(finalCheck.code), `回應的最終位址不合格：${finalCheck.reason}`),
        };
      }
    }
    return { html: buffer.toString('utf8'), finalUrl: current.toString(), status: response.status, bytes: buffer.byteLength };
  }
  return { error: fail(startUrl.toString(), 'unreachable', `redirect 超過 ${READ_LIMITS.maxRedirects} 跳`) };
}

function safeHost(host) {
  return (
    String(host ?? 'unknown-host').toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 80) || 'unknown-host'
  );
}

/** 全文落檔的位置（`pages/read/<host>-<hash8>.txt`）；測試也用這個算路徑。 */
export function readPagePath(root, { host, hash }) {
  return path.join(root, 'pages', 'read', `${safeHost(host)}-${String(hash ?? '').slice(0, 8) || '00000000'}.txt`);
}

/**
 * 付費牆只認**完整片語**，不搜單獨的 `subscribe`。
 * 幾乎每個頁面的導航都有那個詞，搜它等於讓警告永遠亮著 ——
 * 而一個永遠亮著的燈等於沒有燈。
 */
const PAYWALL_PHRASES = [
  'already a subscriber',
  'subscribe to continue',
  'sign in to continue',
  'to continue reading',
];

/** 正文比低於此值就標「可能不完整」（可用 config 的 `incompleteRatio` 覆蓋）。 */
const DEFAULT_INCOMPLETE_RATIO = 0.4;

/** 句末標點：判斷結尾是不是被截斷。 */
const SENTENCE_END = /[。！？.!?…]/;

/**
 * 這篇正文是不是「看起來完整其實不完整」。
 *
 * 2026-11-04 加。起因：euobserver 有軟付費牆，`tier` 仍是 `full`、ratio 只有 0.344，
 * 正文停在半句話 —— 呼叫端完全看不出來，還會把它當成完整文章引用。
 *
 * @returns {string[]} 人類可讀的警告；空陣列 = 沒問題
 */
export function incompleteWarnings({ text, ratio, tier, minRatio = DEFAULT_INCOMPLETE_RATIO }) {
  const warnings = [];
  if (tier === 'full' && Number.isFinite(ratio) && ratio < minRatio) {
    warnings.push(`正文比偏低（ratio ${ratio.toFixed(2)} < ${minRatio}）`);
  }
  const body = String(text ?? '').trimEnd();
  // 只看**最後三個字元**。
  //
  // 原本寫 `body.slice(-40)`，那等於永遠不響：正常文章最後 40 字幾乎一定含句號，
  // 而這條判據要抓的是「被硬切掉」（超位元組上限之類），不是「句子沒寫完」。
  //
  // ⚠️ 它抓不到「語法完整、語意截斷」—— euobserver 那篇就是停在句號後面的，
  //   那種只能靠上面的 ratio 判據。兩條是互補的，不是一條的備份。
  const tail = body.slice(-3);
  if (tail.length > 0 && !SENTENCE_END.test(tail)) {
    warnings.push('結尾沒有句末標點，可能被硬切掉');
  }
  const lowered = body.toLowerCase();
  const paywall = PAYWALL_PHRASES.find((phrase) => lowered.includes(phrase));
  if (paywall) warnings.push(`頁面含付費牆字樣（"${paywall}"）`);
  return warnings;
}

/**
 * 讀一條連結。
 * @param {{root:string, url:string, now?:Date, fetchImpl?:Function, resolve?:Function,
 *          incompleteRatio?:number, incompleteMode?:'warn'|'block'}} opts
 *   `resolve` 測試用：注入 DNS（預設真的 `dns.lookup`），讓離線測試不打真網路。
 *   `incompleteRatio` 正文比門檻（預設 0.4）；`incompleteMode` 遇到疑似不完整時
 *   `warn` = 照樣回內容並附 `warnings`，`block` = 回 `{ok:false, code:'incomplete'}` 不給內容。
 * @returns {Promise<object>} 成功：{ok, url, title, chars, ratio, tier, excerpt, savedTo, warnings?}
 *                            失敗：{ok:false, url, code, reason}（'unsafe-url' / 'incomplete'）
 */
export async function readPage({
  root,
  url: rawUrl,
  now = new Date(),
  fetchImpl = fetch,
  resolve,
  incompleteRatio = DEFAULT_INCOMPLETE_RATIO,
  incompleteMode = 'warn',
} = {}) {
  if (!root) throw new Error('readPage 缺 root（家目錄）');

  // 🔒 發請求之前先過 SSRF 檢查（形狀 + 字面值 + DNS 全部 A/AAAA）
  const checked = await checkPublicHttpsUrl(rawUrl, { resolve });
  if (!checked.ok) return fail(String(rawUrl ?? '').trim(), readCode(checked.code), checked.reason);
  const url = checked.url;
  const target = new URL(url);

  const quota = takeQuota(now.getTime());
  if (!quota.ok) return fail(url, 'rate-limited', quota.reason);

  const fetched = await fetchHtml(target, fetchImpl, resolve);
  if (fetched.error) return fetched.error;

  const document = extractMain(fetched.html, { url, status: fetched.status, maxChars: 200_000 });
  if (document.tier === 'blocked') return fail(url, 'blocked', document.reason);
  if (!document.ok) {
    return fail(url, 'not-html', `拿不到正文（tier=${document.tier}：${document.reason}）`);
  }

  const text = document.text.trim();
  const hash = createHash('sha256').update(`${url}\n${text}`, 'utf8').digest('hex').slice(0, 8);

  // 「看起來完整其實不完整」要在落檔之前判斷 —— block 模式不該留下半截的存檔。
  const warnings = incompleteWarnings({
    text,
    ratio: document.ratio,
    tier: document.tier,
    minRatio: incompleteRatio,
  });
  if (warnings.length > 0 && incompleteMode === 'block') {
    return fail(url, 'incomplete', `疑似不完整（${warnings.join('；')}）—— incompleteMode=block，不回內容也不落檔`);
  }

  const dir = assertInside(root, path.join(root, 'pages', 'read'));
  const file = assertInside(root, readPagePath(root, { host: target.hostname, hash }));
  await mkdir(dir, { recursive: true });

  const head = `# ${document.title || '(無標題)'}\n<!-- source: ${url} | ${now.toISOString()} -->\n\n`;
  await writeFile(file, `${head}${text}\n`, 'utf8');

  return {
    ok: true,
    url,
    title: document.title,
    chars: document.chars,
    ratio: document.ratio,
    tier: document.tier,
    excerpt: text.slice(0, 400),
    savedTo: file,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
