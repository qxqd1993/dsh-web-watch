#!/usr/bin/env node
/**
 * probe/safeurl-cases.mjs —— SSRF 防護（lib/safeurl.mjs）的**離線**案例表
 * ============================================================================
 * 這裡的每一條都帶**注入的 resolve**，所以：
 *   - 不打真 DNS、不碰外網、不需要 DSH；
 *   - 期望值寫在表裏，`node probe/safeurl-cases.mjs` 會印出
 *     「URL / 期望 / 實際 / 原因」四欄，並在有任何一條不符時 exit 1。
 *
 * `scripts/smoke.mjs --offline` 直接把同一份表跑成斷言（單一真值，不重抄一份）。
 *
 * 用法：
 *   node probe/safeurl-cases.mjs           # 印表 + 總結（有任何一條不符就 exit 1）
 * ============================================================================
 */

import { pathToFileURL } from 'node:url';

import { checkPublicHttpsUrl } from '../lib/safeurl.mjs';

/** 假 resolver：測試一律從這裏拿，**永遠不打真 DNS**。 */
export const RESOLVERS = Object.freeze({
  /** 公開位址（範例 IP，文件中保留給範例用，不會真連）。 */
  public: async () => [{ address: '93.184.216.34', family: 4 }],
  /** 解析到內網（「公開域名指向內網」的攻擊形狀）。 */
  private: async () => [{ address: '192.168.1.1', family: 4 }],
  /** 一個公開、一個私有 ⇒ 必須拒（任何一個落內網就拒）。 */
  mixed: async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.7', family: 4 },
  ],
  /** 解析失敗（DNS 掛掉 / 網域不存在）。 */
  fail: async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  },
});

/**
 * 案例表。
 * expect: 'ok' | safeurl 的 code（not-https / has-credentials / bad-port / private-host / dns-failed / bad-url）
 */
export const CASES = Object.freeze([
  // ── 形狀 ──
  { url: 'http://public.example/p', dns: 'public', expect: 'not-https', note: '明文 http 一律不收' },
  { url: 'https://user:pass@public.example/', dns: 'public', expect: 'has-credentials', note: 'URL 不帶帳密' },
  { url: 'https://public.example:8080/', dns: 'public', expect: 'bad-port', note: '埠只能是 443 或省略' },
  { url: 'not a url', dns: 'public', expect: 'bad-url', note: '不是合法 URL' },

  // ── IP 字面值：本機 / 內網 / 保留 ──
  { url: 'https://127.0.0.1/', dns: 'public', expect: 'private-host', note: 'IPv4 loopback' },
  { url: 'https://[::1]/', dns: 'public', expect: 'private-host', note: 'IPv6 loopback' },
  { url: 'https://169.254.169.254/latest/meta-data/', dns: 'public', expect: 'private-host', note: '雲端 metadata（link-local）' },
  { url: 'https://10.1.2.3/', dns: 'public', expect: 'private-host', note: '私有 10/8' },
  { url: 'https://172.20.0.1/', dns: 'public', expect: 'private-host', note: '私有 172.16/12' },
  { url: 'https://192.168.1.1/', dns: 'public', expect: 'private-host', note: '私有 192.168/16' },
  { url: 'https://0.0.0.0/', dns: 'public', expect: 'private-host', note: '未指定位址' },
  { url: 'https://[::ffff:192.168.1.1]/', dns: 'public', expect: 'private-host', note: 'IPv4-mapped 包裝的內網' },
  { url: 'https://[fe80::1]/', dns: 'public', expect: 'private-host', note: 'IPv6 link-local' },
  { url: 'https://[fd00::1]/', dns: 'public', expect: 'private-host', note: 'IPv6 唯一本地 fc00::/7' },
  { url: 'https://100.100.100.200/', dns: 'public', expect: 'private-host', note: '雲端 metadata（CGNAT 100.64/10）' },
  { url: 'https://2130706433/', dns: 'public', expect: 'private-host', note: '十進位寫法的 127.0.0.1（URL 會正規化）' },
  { url: 'https://0x7f000001/', dns: 'public', expect: 'private-host', note: '十六進位寫法的 127.0.0.1' },

  // ── 主機名：本機 / 內部專用名 ──
  { url: 'https://localhost/', dns: 'public', expect: 'private-host', note: 'localhost' },
  { url: 'https://localhost./', dns: 'public', expect: 'private-host', note: '尾端點的 localhost. 也擋' },
  { url: 'https://foo.local/', dns: 'public', expect: 'private-host', note: '*.local' },
  { url: 'https://sub.internal/', dns: 'public', expect: 'private-host', note: '*.internal' },
  { url: 'https://metadata.google.internal/', dns: 'public', expect: 'private-host', note: '雲端 metadata 主機名' },

  // ── DNS 判斷 ──
  { url: 'https://public.example/', dns: 'public', expect: 'ok', note: '公開域名 + 公開 A ⇒ 放行' },
  { url: 'https://example.com:443/', dns: 'public', expect: 'ok', note: '顯式 :443 等於省略（URL 會正規化掉）' },
  { url: 'https://evil.example/', dns: 'private', expect: 'private-host', note: '公開域名解析到內網 ⇒ 拒' },
  { url: 'https://mixed.example/', dns: 'mixed', expect: 'private-host', note: '任何一個 A/AAAA 落內網就拒' },
  { url: 'https://no-such-host.example/', dns: 'fail', expect: 'dns-failed', note: '解析失敗 ⇒ dns-failed' },

  // ── IPv6「內嵌 IPv4 的隧道段」（2026-10-27 對抗性測試後補：這幾類經中繼可達內網） ──
  { url: 'https://[2002:7f00:1::]/', dns: 'public', expect: 'private-host', note: '6to4 → 127.0.0.1' },
  { url: 'https://[2002:a9fe:a9fe::]/', dns: 'public', expect: 'private-host', note: '6to4 → 169.254.169.254' },
  { url: 'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', dns: 'public', expect: 'private-host', note: 'Teredo 隧道' },
  { url: 'https://[2001:2::1]/', dns: 'public', expect: 'private-host', note: 'benchmarking 2001:2::/48' },
  { url: 'https://[100::1]/', dns: 'public', expect: 'private-host', note: 'discard 100::/64' },
  { url: 'https://[64:ff9b:1::1]/', dns: 'public', expect: 'private-host', note: 'local-use NAT64 64:ff9b:1::/48' },

  // ── 對照組：這些必須放行（避免「全都擋」的假安全） ──
  { url: 'https://172.15.0.1/', dns: 'public', expect: 'ok', note: '172.16/12 之前的公開位址' },
  { url: 'https://[2001:4860:4860::8888]/', dns: 'public', expect: 'ok', note: '公開 IPv6（Google DNS）' },
  { url: 'https://public.example/very/deep?x=1#frag', dns: 'public', expect: 'ok', note: '路徑 / query / fragment 不影響判定' },
]);

/**
 * 跑完整表（注入 resolve，零網路）。
 * @returns {Promise<Array<{url:string, expect:string, actual:string, reason:string, note:string, ok:boolean}>>}
 */
export async function runCases() {
  const rows = [];
  for (const item of CASES) {
    const resolver = RESOLVERS[item.dns];
    let outcome;
    try {
      outcome = await checkPublicHttpsUrl(item.url, { resolve: resolver });
    } catch (error) {
      outcome = { ok: false, code: 'threw', reason: String(error?.message ?? error) };
    }
    const actual = outcome.ok ? 'ok' : outcome.code;
    rows.push({
      url: item.url,
      expect: item.expect,
      actual,
      reason: outcome.ok ? '（放行）' : outcome.reason,
      note: item.note,
      ok: actual === item.expect,
    });
  }
  return rows;
}

/** 顯示寬度：中文 / 全形字算兩格，否則表格會歪。 */
function widthOf(value) {
  return [...String(value)].reduce((sum, char) => sum + (char.codePointAt(0) > 0xff ? 2 : 1), 0);
}

function pad(text, width) {
  let out = String(text);
  const diff = width - widthOf(out);
  if (diff > 0) out += ' '.repeat(diff);
  return out;
}

/** 印成「URL / 期望 / 實際 / 原因」四欄。 */
export function formatTable(rows) {
  const column = (header, pick) =>
    Math.max(4, widthOf(header), ...rows.map((row) => widthOf(pick(row))));
  const widths = [
    column('URL', (row) => row.url),
    column('期望', (row) => row.expect),
    column('實際', (row) => row.actual),
  ];
  const lines = [];
  lines.push(
    `${pad('URL', widths[0])}  ${pad('期望', widths[1])}  ${pad('實際', widths[2])}  原因`,
  );
  lines.push(`${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(widths[2])}  ${'-'.repeat(30)}`);
  for (const row of rows) {
    const mark = row.ok ? '  ' : '❌';
    lines.push(
      `${mark}${pad(row.url, widths[0])}  ${pad(row.expect, widths[1])}  ${pad(row.actual, widths[2])}  ${row.reason}`,
    );
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const rows = await runCases();
  console.log('\n=== safeurl 案例表（注入 resolve，零網路） ===\n');
  console.log(formatTable(rows));
  const bad = rows.filter((row) => !row.ok);
  console.log(`\n[safeurl] ${rows.length - bad.length}/${rows.length} 符合期望`);
  if (bad.length > 0) {
    console.log('[safeurl] 不符：');
    for (const row of bad) console.log(`  - ${row.url} 期望 ${row.expect}，實際 ${row.actual}（${row.reason}）`);
    process.exitCode = 1;
  } else {
    console.log('[safeurl] 全部符合期望');
  }
}
