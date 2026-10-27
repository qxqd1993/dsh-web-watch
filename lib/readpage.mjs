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
 * 失敗分類：blocked / unreachable / not-html / too-large / rate-limited，每個都帶可讀 reason。
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { extractMain } from './extract.mjs';
import { assertInside } from './engine/store.mjs';

export const READ_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  minHostGapMs: 1_000,
  perMinute: 3,
});

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

/** https / 無帳密 / 合法 host —— 不合格一律 unreachable（可讀原因說清楚）。 */
function parseHttps(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? '').trim());
  } catch {
    return { error: '不是合法 URL（要完整的 https://…）' };
  }
  if (url.protocol !== 'https:') return { error: `只接受 https（收到 ${url.protocol}）` };
  if (url.username || url.password) return { error: 'URL 不允許帶帳號密碼' };
  if (!url.hostname) return { error: 'URL 沒有主機名' };
  return { url };
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

/** 手動跟 redirect（才知道跳了幾次、中途有沒有掉回 http）。 */
async function fetchHtml(startUrl, fetchImpl) {
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
      const next = parseHttps(new URL(location, current).toString());
      if (next.error) return { error: fail(current.toString(), 'unreachable', `redirect 到不合格的位址：${next.error}`) };
      current = next.url;
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
 * 讀一條連結。
 * @param {{root:string, url:string, now?:Date, fetchImpl?:Function}} opts
 * @returns {Promise<object>} 成功：{ok, url, title, chars, ratio, tier, excerpt, savedTo}
 *                            失敗：{ok:false, url, code, reason}
 */
export async function readPage({ root, url: rawUrl, now = new Date(), fetchImpl = fetch } = {}) {
  if (!root) throw new Error('readPage 缺 root（家目錄）');

  const parsed = parseHttps(rawUrl);
  if (parsed.error) return fail(String(rawUrl ?? ''), 'unreachable', parsed.error);
  const url = parsed.url.toString();

  const quota = takeQuota(now.getTime());
  if (!quota.ok) return fail(url, 'rate-limited', quota.reason);

  const fetched = await fetchHtml(parsed.url, fetchImpl);
  if (fetched.error) return fetched.error;

  const document = extractMain(fetched.html, { url, status: fetched.status, maxChars: 200_000 });
  if (document.tier === 'blocked') return fail(url, 'blocked', document.reason);
  if (!document.ok) {
    return fail(url, 'not-html', `拿不到正文（tier=${document.tier}：${document.reason}）`);
  }

  const text = document.text.trim();
  const hash = createHash('sha256').update(`${url}\n${text}`, 'utf8').digest('hex').slice(0, 8);
  const dir = assertInside(root, path.join(root, 'pages', 'read'));
  const file = assertInside(root, readPagePath(root, { host: parsed.url.hostname, hash }));
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
  };
}
