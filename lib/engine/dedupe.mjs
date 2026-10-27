/**
 * 去重：
 *   - guid 出現過 → 不進「新增」
 *   - 正文 sha256 出現過（guid 新的） → 不重寫快照，只記「未變」
 *   - seenIds / seenHashes 各保留最近 500
 */

import { createHash } from 'node:crypto';

export const SEEN_LIMIT = 500;

export function sha256(input) {
  return createHash('sha256').update(String(input ?? ''), 'utf8').digest('hex');
}

function tailUnique(previous, additions, limit) {
  const out = [];
  const seen = new Set();
  for (const value of [...(previous ?? []), ...(additions ?? [])]) {
    if (typeof value !== 'string' || value === '') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/**
 * @param {Array} entries adapter 產出的條目
 * @param {object} state index.json 裡該源的狀態
 * @returns {{
 *   all: Array, fresh: Array, hashUnchanged: Array,
 *   knownCount: number, hashUnchangedCount: number,
 *   recordGuids: string[], recordHashes: string[], lastHash: string|null
 * }}
 */
export function classifyEntries(entries, state = {}) {
  const seenIds = new Set(state.seenIds ?? []);
  const seenHashes = new Set(state.seenHashes ?? []);

  const all = [];
  const fresh = [];
  const hashUnchanged = [];
  const recordGuids = [];
  const recordHashes = [];
  let knownCount = 0;
  let hashUnchangedCount = 0;

  for (const entry of entries) {
    const body = String(entry.body ?? '');
    const hash = sha256(body);
    const guid = String(entry.guid || entry.link || hash).trim() || hash;
    const withMeta = { ...entry, guid, hash };
    all.push(withMeta);

    if (seenIds.has(guid)) {
      knownCount += 1;
      continue;
    }
    seenIds.add(guid);
    recordGuids.push(guid);

    if (seenHashes.has(hash)) {
      hashUnchangedCount += 1;
      hashUnchanged.push(withMeta);
      continue;
    }
    seenHashes.add(hash);
    recordHashes.push(hash);
    fresh.push(withMeta);
  }

  const lastHash = all.length > 0 ? sha256(all.map((entry) => entry.hash).join(':')) : null;

  return {
    all,
    fresh,
    hashUnchanged,
    knownCount,
    hashUnchangedCount,
    recordGuids,
    recordHashes,
    lastHash,
  };
}

/** 把新值接到尾端，去重並截到 limit（給 store 更新 index 用）。 */
export function mergeSeen(previous, additions, limit = SEEN_LIMIT) {
  return tailUnique(previous, additions, limit);
}
