/**
 * lib/safeurl.mjs —— SSRF 第一層：只放行「公開的 https URL」
 * ============================================================================
 * 背景：插件跑在宿主進程裏，`fetch` 有完整網路權限。過去 `web_watch_read` / 定時抓源
 * 都接受任意 https URL ⇒ 典型 SSRF（`https://127.0.0.1/`、`http://169.254.169.254/…`、
 * `https://10.0.0.5/`、公開域名解析到內網…）。
 *
 * 這一層做兩件事，**都在發請求之前**：
 *   ① 形狀檢查（同步）：只收 `https:`、埠只能是 443（或省略）、不帶帳密；
 *      主機名是 IP 字面值就直接判（loopback / link-local / 私有 / 保留 / 組播…），
 *      是 `localhost` / `*.local` / `*.internal` / `*.localhost` 就拒。
 *   ② DNS 檢查（非同步）：主機名用 `dns.lookup(host, { all: true })` 解析出**所有** A/AAAA，
 *      任何一個落在 ① 那些段就拒（防「公開域名指向內網」）。
 *
 * 為什麼**不**快取：快取會把「上次解析是公開的」帶進請求路徑，等於把 rebinding 窗口拉長。
 * 每次判定都重新解析，寧可慢一點。
 *
 * 這個檔案零依賴、不發請求、不寫檔。`resolve` 可注入（測試用；預設用真的 dns）。
 *
 * ⚠️ 已知殘餘風險（本版**不**解，見 README「安全邊界」）：DNS rebinding ——
 *    我們解析的位址與 `fetch` 實際連的位址是兩次獨立解析，中間可能被換掉。
 *    正解是 pinned-IP（解析一次 → 用那個 IP 連、SNI/Host 照舊），那要改用 `node:https`
 *    加自訂 `lookup`，工程量另計，不在這版。
 * ============================================================================
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** DNS 解析的硬上限：查不到就當 dns-failed，不讓一次工具呼叫卡死。 */
export const DNS_TIMEOUT_MS = 5_000;

/** 明確屬於「本機／內部」的主機名後綴（小寫比對）。 */
const LOCAL_HOST_SUFFIXES = ['.local', '.internal', '.localhost'];

/** IPv4 的禁用段（[網段, 前綴長度, 人話原因]）。 */
const V4_BLOCKS = [
  ['0.0.0.0', 8, '本網路（0.0.0.0/8）'],
  ['10.0.0.0', 8, '私有位址（10/8）'],
  ['100.64.0.0', 10, '電信級 NAT／雲端 metadata（100.64/10）'],
  ['127.0.0.0', 8, 'loopback（127/8）'],
  ['169.254.0.0', 16, 'link-local（169.254/16，雲端 metadata）'],
  ['172.16.0.0', 12, '私有位址（172.16/12）'],
  ['192.0.0.0', 24, 'IETF 協定保留（192.0.0/24）'],
  ['192.0.2.0', 24, '文件用（TEST-NET-1）'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, '私有位址（192.168/16）'],
  ['198.18.0.0', 15, 'benchmark（198.18/15）'],
  ['198.51.100.0', 24, '文件用（TEST-NET-2）'],
  ['203.0.113.0', 24, '文件用（TEST-NET-3）'],
  ['224.0.0.0', 4, '組播（224/4）'],
  ['240.0.0.0', 4, '保留（240/4，含 255.255.255.255）'],
];

function fail(code, reason) {
  return { ok: false, code, reason };
}

/* ────────────────────────── IPv4 ────────────────────────── */

function parseIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null;
  return nums;
}

function ipv4ToInt(nums) {
  return (((nums[0] * 256 + nums[1]) * 256 + nums[2]) * 256 + nums[3]) >>> 0;
}

function inV4Block(value, baseText, bits) {
  const base = ipv4ToInt(parseIPv4(baseText));
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

/** 這個 IPv4 屬於禁用段就回原因，公開位址回 null。 */
function blockedReasonV4(text) {
  const nums = parseIPv4(text);
  if (!nums) return '不是合法 IPv4';
  const value = ipv4ToInt(nums);
  for (const [base, bits, reason] of V4_BLOCKS) {
    if (inV4Block(value, base, bits)) return reason;
  }
  return null;
}

/* ────────────────────────── IPv6 ────────────────────────── */

/** 把 IPv6 字串展成 8 個 16-bit 群組；看不懂就回 null（含 `::ffff:1.2.3.4`）。 */
function parseIPv6(input) {
  let text = String(input).toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  // 尾端 dotted-quad（::ffff:192.168.1.1）先換成兩個 hex 群組
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    const v4 = parseIPv4(text.slice(cut + 1));
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, cut + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part) =>
    part === ''
      ? []
      : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));

  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...tail].some((group) => Number.isNaN(group))) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/** 這個 IPv6 屬於禁用段就回原因，公開位址回 null。 */
function blockedReasonV6(groups) {
  const allZero = groups.every((group) => group === 0);
  if (allZero) return '未指定位址（::）';
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'loopback（::1）';

  // IPv4-mapped ::ffff:0:0/96 與（已廢棄的）IPv4-compatible ::a.b.c.d
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((group) => group === 0);
  if (mapped || compatible) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    const reason = blockedReasonV4(embedded);
    if (reason) return `${mapped ? 'IPv4-mapped' : 'IPv4-compatible'} ${embedded}：${reason}`;
    return null;
  }

  // NAT64 64:ff9b::/96（尾端嵌 IPv4）
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    const reason = blockedReasonV4(embedded);
    if (reason) return `NAT64 ${embedded}：${reason}`;
    return null;
  }

  // ⚠️ 2026-10-27 補（對抗性測試抓到）：以下都是「內嵌 IPv4 的隧道段」——
  //   請求可以經 6to4 / Teredo 中繼被帶進內網，標準 SSRF 清單一律列為禁用。
  //   6to4 2002::/16：groups[1]、groups[2] 就是內嵌的 v4。
  if (groups[0] === 0x2002) {
    const embedded = `${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`;
    return `6to4 ${embedded}（2002::/16，中繼可達內網）`;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return 'Teredo（2001:0::/32，內嵌 IPv4 隧道）';
  if (groups[0] === 0x2001 && groups[1] === 0x0002) return 'benchmarking（2001:2::/48）';
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return 'discard（100::/64）';
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) return 'local-use NAT64（64:ff9b:1::/48）';

  if ((groups[0] & 0xff00) === 0xff00) return '組播（ff00::/8）';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local（fe80::/10）';
  if ((groups[0] & 0xffc0) === 0xfec0) return '站點本地（fec0::/10，已廢棄）';
  if ((groups[0] & 0xfe00) === 0xfc00) return '唯一本地（fc00::/7）';
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return '文件用（2001:db8::/32）';
  return null;
}

/** IP 字面值（v4 / v6，v6 不帶方括號）屬於禁用段就回原因，公開位址回 null。 */
function blockedReasonIp(text) {
  const family = isIP(String(text));
  if (family === 4) return blockedReasonV4(text);
  if (family === 6) {
    const groups = parseIPv6(text);
    if (!groups) return '不是合法 IPv6';
    return blockedReasonV6(groups);
  }
  return '不是合法 IP';
}

/* ────────────────────────── 主機名 ────────────────────────── */

/** `localhost` / `*.local` / `*.internal` / `*.localhost`（尾端點也照擋）。 */
function isLocalHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  return LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 去掉 IPv6 的方括號（`URL.hostname` 會帶）。 */
function bareHost(hostname) {
  const host = String(hostname ?? '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/* ────────────────────────── 對外 API ────────────────────────── */

/**
 * 同步版：只做形狀 + 字面值判斷，**不碰 DNS**（配置校驗用，不能變成阻塞的網路請求）。
 * @param {string} raw
 * @returns {{ok:true, url:string} | {ok:false, code:string, reason:string}}
 *   code ∈ not-https / has-credentials / bad-port / private-host / bad-url
 */
export function checkPublicHttpsUrlSync(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return fail('bad-url', '不是合法 URL（要完整的 https://…）');
  }
  if (url.protocol !== 'https:') return fail('not-https', `只接受 https（收到 ${url.protocol}）`);
  if (url.username || url.password) return fail('has-credentials', 'URL 不允許帶帳號密碼');
  if (url.port !== '' && url.port !== '443') {
    return fail('bad-port', `只接受 443 埠（收到 ${url.port}）`);
  }

  const hostname = url.hostname;
  if (!hostname) return fail('bad-url', 'URL 沒有主機名');

  const host = bareHost(hostname);
  const family = isIP(host);
  if (family !== 0) {
    const reason = blockedReasonIp(host);
    return reason ? fail('private-host', `位址 ${host} 是本機／內部網段：${reason}`) : { ok: true, url: url.toString() };
  }
  if (isLocalHostname(host)) {
    return fail('private-host', `主機名 ${host} 是本機／內部專用名`);
  }
  return { ok: true, url: url.toString() };
}

/** 注入的 resolve 可以是 `dns.lookup(host, {all:true})`，也接受回字串陣列。 */
function resolveRows(rows) {
  if (typeof rows === 'string') return [rows];
  if (rows && typeof rows === 'object' && typeof rows.address === 'string') return [rows.address];
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (typeof row === 'string') out.push(row);
    else if (row && typeof row.address === 'string') out.push(row.address);
  }
  return out;
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`DNS 解析逾時（${ms}ms）`), { code: 'ETIMEDOUT' }));
    }, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 非同步版：形狀 + 字面值 + DNS（所有 A/AAAA 都必須是公開位址）。
 * @param {string} raw
 * @param {{resolve?: (host:string, opts:{all:true}) => Promise<any>}} [opts]
 * @returns {Promise<{ok:true, url:string} | {ok:false, code:string, reason:string}>}
 *   code ∈ not-https / has-credentials / bad-port / private-host / dns-failed / bad-url
 */
export async function checkPublicHttpsUrl(raw, { resolve } = {}) {
  const shape = checkPublicHttpsUrlSync(raw);
  if (!shape.ok) return shape;

  const hostname = bareHost(new URL(shape.url).hostname);
  if (isIP(hostname) !== 0) return shape; // 字面值已經判完，不必再解析

  const resolver = typeof resolve === 'function' ? resolve : dnsLookup;
  let rows;
  try {
    rows = await withTimeout(Promise.resolve().then(() => resolver(hostname, { all: true })), DNS_TIMEOUT_MS);
  } catch (error) {
    const code = error?.code || error?.name || 'UNKNOWN';
    return fail('dns-failed', `DNS 解析失敗（${hostname}）：${code}`);
  }

  const addresses = resolveRows(rows);
  if (addresses.length === 0) return fail('dns-failed', `DNS 解析不到任何 A/AAAA（${hostname}）`);

  for (const address of addresses) {
    const reason = blockedReasonIp(address);
    if (reason) {
      return fail('private-host', `${hostname} 解析到 ${address}（${reason}）`);
    }
  }
  return { ok: true, url: shape.url };
}
