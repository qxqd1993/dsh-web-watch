/**
 * 落檔與狀態：
 *   - pages/<host>/<id>-<hash8>.txt（UTF-8、無 BOM）
 *   - index.json（只由程式寫）
 *   - out/<YYYY-MM-DDTHH-mm>.md（同一分鐘重跑時加 -2、-3，避免覆蓋證據）
 *
 * 所有寫入 / 刪除前都用絕對路徑檢查必須在 `root`（插件家目錄 `<DSH_HOME>\\web-watch`）以內；
 * 越界直接拋錯。root 一律由呼叫端傳進來（不碰 process.cwd()）—— 移植時只換了這一點，
 * assertInside() 的邊界檢查原樣保留。
 */

import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from './loader.mjs';

export const RETENTION_DAYS = 90;
export const MAX_PAGE_FILES = 200;

function violation(target) {
  const error = new Error(`拒絕寫入：${target} 不在 web-watch 家目錄內`);
  error.name = 'PathViolation';
  error.code = 'PATH_VIOLATION';
  return error;
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function assertInside(root, target) {
  const abs = path.resolve(target);
  if (!isInside(root, abs)) throw violation(abs);
  return abs;
}

function safeHost(host) {
  return (
    String(host ?? 'unknown-host')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_')
      .slice(0, 80) || 'unknown-host'
  );
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function ensureLayout(root) {
  for (const dir of [path.join(root, 'pages'), path.join(root, 'out')]) {
    assertInside(root, dir);
    await mkdir(dir, { recursive: true });
  }
}

export function getSourceState(index, id) {
  const current = index.sources?.[id];
  return {
    seenIds: Array.isArray(current?.seenIds) ? current.seenIds : [],
    seenHashes: Array.isArray(current?.seenHashes) ? current.seenHashes : [],
    failures: Number.isInteger(current?.failures) ? current.failures : 0,
    failStreak: Number.isInteger(current?.failStreak) ? current.failStreak : 0,
    lastOkAt: current?.lastOkAt ?? null,
    lastHash: current?.lastHash ?? null,
    lastRunAt: current?.lastRunAt ?? null,
    lastStatus: current?.lastStatus ?? null,
    lastCount: Number.isInteger(current?.lastCount) ? current.lastCount : 0,
  };
}

export async function readIndex(root) {
  const file = path.join(root, 'index.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { version: 1, updatedAt: null, sources: {} };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`index.json 不是合法 JSON（只由程式寫入；可刪掉重建）：${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('index.json 最外層必須是物件');
  }
  const sources =
    parsed.sources !== null && typeof parsed.sources === 'object' && !Array.isArray(parsed.sources)
      ? parsed.sources
      : {};
  return { version: 1, updatedAt: parsed.updatedAt ?? null, sources };
}

export async function writeIndex(root, index, now) {
  const file = assertInside(root, path.join(root, 'index.json'));
  const payload = {
    version: 1,
    updatedAt: now.toISOString(),
    sources: index.sources ?? {},
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

export function snapshotPath(root, { sourceId, host, hash }) {
  const hash8 = String(hash ?? '').slice(0, 8) || '00000000';
  return path.join(root, 'pages', safeHost(host), `${sourceId}-${hash8}.txt`);
}

export async function writeSnapshot(root, { sourceId, host, title, url, dateIso, body, hash }) {
  const dir = assertInside(root, path.join(root, 'pages', safeHost(host)));
  const file = assertInside(root, snapshotPath(root, { sourceId, host, hash }));
  await mkdir(dir, { recursive: true });
  const head = `# ${oneLine(title) || '(無標題)'}\n<!-- source: ${oneLine(url)} | ${oneLine(dateIso)} -->\n\n`;
  await writeFile(file, `${head}${String(body ?? '').trim()}\n`, 'utf8');
  return file;
}

async function walkFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

export async function countPageFiles(root) {
  return (await walkFiles(path.join(root, 'pages'))).length;
}

/**
 * 只算要刪哪些，不動磁碟（dry-run 也用這個）。
 * 規則：先刪超過 90 天的，再從剩下的最舊的刪到最多 200 份。
 */
export async function planPrune(root, now) {
  const pagesDir = path.join(root, 'pages');
  const files = await walkFiles(pagesDir);
  const withTime = [];
  for (const file of files) {
    const info = await stat(file);
    withTime.push({ file, mtimeMs: info.mtimeMs });
  }
  withTime.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 3_600_000;
  const expired = new Set(withTime.filter((item) => item.mtimeMs < cutoff).map((item) => item.file));
  const kept = withTime.filter((item) => !expired.has(item.file));
  const overflow = kept.slice(0, Math.max(0, kept.length - MAX_PAGE_FILES));

  const plan = [...expired, ...overflow.map((item) => item.file)];
  return { plan, total: withTime.length };
}

/** @returns {{removed:number, remaining:number}} */
export async function prunePages(root, now) {
  const { plan } = await planPrune(root, now);
  let removed = 0;
  for (const file of plan) {
    assertInside(root, file);
    try {
      await unlink(file);
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { removed, remaining: await countPageFiles(root) };
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 寫 digest；同一分鐘重跑不覆蓋，改成 ...-2.md、...-3.md。
 * @returns {Promise<string>} 絕對路徑
 */
export async function writeDigestFile(root, baseName, markdown) {
  const outDir = assertInside(root, path.join(root, 'out'));
  await mkdir(outDir, { recursive: true });

  let candidate = assertInside(root, path.join(outDir, baseName));
  let suffix = 2;
  while (await fileExists(candidate)) {
    candidate = assertInside(root, path.join(outDir, baseName.replace(/\.md$/i, `-${suffix}.md`)));
    suffix += 1;
    if (suffix > 999) throw new Error(`digest 檔名衝突過多：${baseName}`);
  }
  await writeFile(candidate, markdown, 'utf8');
  return candidate;
}
