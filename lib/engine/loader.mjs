/**
 * 讀 sources.json、校驗、補預設值。
 * 配置錯誤在抓取前就丟 ConfigError（插件把它吞成一句「配置有問題」），不要跑到一半才炸。
 *
 * 移植改動（僅此幾點）：
 *   - 從 P1 原樣搬過來，校驗規則一條沒改；
 *   - 把「校驗 schedule / sources」抽成可重用的 normalizeSchedule / normalizeSources，
 *     設置頁存檔與工具改配置都走同一份規則（不再各寫一遍）；
 *   - 多一個 buildConfigDoc()：把校驗後的東西寫回 sources.json（null 欄位不落地）。
 *   - 0.1.7：sources.json 的 `schedule` 降級成**兼容鏡像**（deprecated）。真值是插件家目錄的
 *     `config.json`；buildConfigDoc() 寫出的鏡像會帶 `_scheduleMirror` 標記，讓手改的人一眼看出來。
 *   - 0.1.9（SSRF）：`url` 與 `fallbacks` 在**配置階段**就過一次 `lib/safeurl.mjs` 的**同步**檢查
 *     （形狀 + IP 字面值 + `localhost` / `*.local` 這類名字），私有 / loopback / link-local 的源直接
 *     ConfigError。⚠️ 這裡**故意不解析 DNS** —— 配置校驗不能變成阻塞的網路請求；「公開域名解析到內網」
 *     這種留給抓取時的非同步檢查（readpage / engine 都做）。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertTimeZone, parseStartAt } from './schedule.mjs';
import { checkPublicHttpsUrlSync } from '../safeurl.mjs';

/** sources.json 裏 schedule 欄位的身份標記（機器可讀，也是給人看的警告）。 */
export const SCHEDULE_MIRROR_NOTE = 'derived from config.json; do not edit';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS = new Set(['rss', 'json', 'html']);
const ROLES = new Set(['full', 'index']);

function positiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${label} 必須是 > 0 的數字`);
  }
  return value;
}

function startAtField(value, label) {
  try {
    return parseStartAt(value);
  } catch (error) {
    throw new ConfigError(`${label}：${error.message}`);
  }
}

function maxItemsField(value, label) {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ConfigError(`${label} 必須是 1–100 的整數`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${label} 必須是非空字串`);
  }
  return value.trim();
}

function normalizeSource(raw, index, seenIds) {
  const prefix = `sources[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${prefix} 必須是物件`);
  }

  const id = raw.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new ConfigError(`${prefix}.id 必須是小寫英數與 '-'（1–64 字元）`);
  }
  if (seenIds.has(id)) throw new ConfigError(`${prefix}.id 重複：${id}`);
  seenIds.add(id);

  if (!KINDS.has(raw.kind)) {
    throw new ConfigError(`${prefix}.kind 必須是 rss / json / html`);
  }

  let role = raw.role ?? 'full';
  if (!ROLES.has(role)) {
    throw new ConfigError(`${prefix}.role 必須是 full / index`);
  }

  if (typeof raw.url !== 'string' || raw.url.trim() === '') {
    throw new ConfigError(`${prefix}.url 是必填的 https URL`);
  }
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    throw new ConfigError(`${prefix}.url 不是合法 URL：${raw.url}`);
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError(`${prefix}.url 只接受 https（收到 ${url.protocol}）`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${prefix}.url 不允許帶帳密`);
  }
  // 🔒 SSRF：字面值 / 本機名直接拒（DNS 留給抓取時做，見檔頭說明）
  const literal = checkPublicHttpsUrlSync(url.toString());
  if (!literal.ok) throw new ConfigError(`${prefix}.url ${literal.reason}`);

  if (raw.trusted !== undefined && typeof raw.trusted !== 'boolean') {
    throw new ConfigError(`${prefix}.trusted 必須是 boolean`);
  }

  // fallbacks（可選）：主 URL 失敗時依序試；全部失敗才記 failed。同樣只收 https、不帶帳密。
  const fallbacks = [];
  if (raw.fallbacks !== undefined && raw.fallbacks !== null) {
    if (!Array.isArray(raw.fallbacks)) throw new ConfigError(`${prefix}.fallbacks 必須是 URL 陣列`);
    if (raw.fallbacks.length > 5) throw new ConfigError(`${prefix}.fallbacks 最多 5 條（有界抓取）`);
    for (let i = 0; i < raw.fallbacks.length; i += 1) {
      const item = raw.fallbacks[i];
      if (typeof item !== 'string' || item.trim() === '') {
        throw new ConfigError(`${prefix}.fallbacks[${i}] 必須是非空字串 URL`);
      }
      let fb;
      try {
        fb = new URL(item.trim());
      } catch {
        throw new ConfigError(`${prefix}.fallbacks[${i}] 不是合法 URL：${item}`);
      }
      if (fb.protocol !== 'https:') {
        throw new ConfigError(`${prefix}.fallbacks[${i}] 只接受 https（收到 ${fb.protocol}）`);
      }
      if (fb.username || fb.password) throw new ConfigError(`${prefix}.fallbacks[${i}] 不允許帶帳密`);
      const fbLiteral = checkPublicHttpsUrlSync(fb.toString());
      if (!fbLiteral.ok) throw new ConfigError(`${prefix}.fallbacks[${i}] ${fbLiteral.reason}`);
      fallbacks.push(fb.toString());
    }
  }

  const source = {
    id,
    kind: raw.kind,
    role,
    url: url.toString(),
    maxItems: maxItemsField(raw.maxItems, `${prefix}.maxItems`),
    trusted: raw.trusted ?? true,
    // ⚠️ 2026-10-25 修：這裡原本只認 undefined 當「沒填」，null 就被丟進 positiveNumber
    //    → 拋「必須是 > 0」。而 saveSources() 會把**已正規化過的源**（intervalHours:
    //    null）再校驗一次，於是 add / update / remove 全數失敗，設定頁也加不了源。
    //    null 與 undefined 都該視為「沒有 per-source 覆寫」。
    intervalHours:
      raw.intervalHours == null ? null : positiveNumber(raw.intervalHours, `${prefix}.intervalHours`),
    startAt: raw.startAt == null ? null : startAtField(raw.startAt, `${prefix}.startAt`),
    fallbacks,
  };

  if (raw.kind === 'json') {
    source.path = optionalString(raw.path, `${prefix}.path`);
    if (!source.path) throw new ConfigError(`${prefix}.path 是 kind=json 的必填欄位`);
    source.idPath = optionalString(raw.idPath, `${prefix}.idPath`);
    source.titlePath = optionalString(raw.titlePath, `${prefix}.titlePath`) ?? 'title';
    source.linkPath = optionalString(raw.linkPath, `${prefix}.linkPath`) ?? 'url';
    source.bodyPath = optionalString(raw.bodyPath, `${prefix}.bodyPath`) ?? 'contents';
    source.datePath = optionalString(raw.datePath, `${prefix}.datePath`) ?? 'date';
  }

  return source;
}

/** 校驗一份 schedule（全域）。 */
export function normalizeSchedule(raw, label = 'schedule') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${label} 必須是物件`);
  }
  let timezone;
  try {
    timezone = assertTimeZone(raw.timezone);
  } catch (error) {
    throw new ConfigError(`${label}.timezone：${error.message}`);
  }
  return {
    intervalHours: positiveNumber(raw.intervalHours, `${label}.intervalHours`),
    startAt: startAtField(raw.startAt, `${label}.startAt`),
    timezone,
  };
}

/** 校驗一份源清單（設置頁存檔、工具改配置、sources.json 讀入都走這裏）。 */
export function normalizeSources(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new ConfigError('sources 必須是非空陣列');
  }
  const seenIds = new Set();
  return rawList.map((item, index) => normalizeSource(item, index, seenIds));
}

/** 校驗後的源 → 要寫進 sources.json 的形狀（null / 空欄位不落地）。 */
export function toRawSource(source) {
  const out = {
    id: source.id,
    kind: source.kind,
    role: source.role,
    url: source.url,
    maxItems: source.maxItems,
    trusted: source.trusted,
  };
  if (Number.isFinite(source.intervalHours) && source.intervalHours > 0) out.intervalHours = source.intervalHours;
  if (typeof source.startAt === 'string' && source.startAt) out.startAt = source.startAt;
  if (Array.isArray(source.fallbacks) && source.fallbacks.length > 0) out.fallbacks = source.fallbacks;
  if (source.kind === 'json') {
    out.path = source.path;
    if (source.idPath) out.idPath = source.idPath;
    out.titlePath = source.titlePath;
    out.linkPath = source.linkPath;
    out.bodyPath = source.bodyPath;
    out.datePath = source.datePath;
  }
  return out;
}

/**
 * 校驗 + 組出要寫回 sources.json 的完整物件。
 * ⚠️ 0.1.7 起 `schedule` 只是**兼容鏡像**：真值在 config.json，插件在保存配置 / 啟動自檢時
 *    會用「有效 schedule」覆蓋它（給 P1 CLI 與人工查看）。`_scheduleMirror` 就是這層身份的標記。
 */
export function buildConfigDoc({ schedule, sources }) {
  return {
    version: 1,
    _scheduleMirror: SCHEDULE_MIRROR_NOTE,
    schedule: normalizeSchedule(schedule),
    sources: normalizeSources(sources).map(toRawSource),
  };
}

/**
 * @returns {{version:number, schedule:{intervalHours:number,startAt:string,timezone:string}, sources:Array}}
 */
export async function loadConfig(root) {
  const file = path.join(root, 'sources.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`讀不到 ${file}（${error.code || error.message}）`);
  }

  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`sources.json 不是合法 JSON：${error.message}`);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('sources.json 最外層必須是物件');
  }
  if (raw.version !== 1) {
    throw new ConfigError(`sources.json version 必須是 1（收到 ${String(raw.version)}）`);
  }

  return {
    version: 1,
    schedule: normalizeSchedule(raw.schedule, 'sources.json schedule'),
    sources: normalizeSources(raw.sources),
  };
}
