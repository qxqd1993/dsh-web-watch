/**
 * lib/sessions.mjs —— 給設置頁的「最新會話」找顯示名
 * ============================================================================
 * 為什麼要有這支：
 *   宿主 `ctx.agents.list()` 給的會話物件**沒有 title**（只有 id），所以設置頁原本只能
 *   把 id 印兩次：「可選會話：session-…（session-…）」。但會話標題其實存在
 *   `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val`。
 *
 * 為什麼讀存儲而不是等宿主給：
 *   翻過插件的既有寫法（`item?.session?.title`）—— 宿主那條路拿不到，而我們不想為了一個
 *   顯示名去加新的 API 依賴。這支是「**盡力而為**」：讀不到就回空，調用方退回只顯示 id。
 *
 * ⚠️ 這是**內部存儲格式**，不是公開契約。DSH 改版就可能失效 ——
 *    所以：任何例外都吞掉、單檔壞掉不影響其他人、格式不符就當沒標題。
 *    顯示名失效最多是「看不到暱稱」，不該連累抓取與排程。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 內部目錄（相對 DSH 家目錄）。 */
const SESS_DIR = ['storages', 'session_projcache', 'sessions']

/** `session-<uuid>` 與 `<uuid>` 視為同一個會話。 */
const keyOf = (id) => String(id || '').replace(/^session-/, '')

/**
 * 讀出所有會話的 { id, title, lastPromptAt }，按最近活動倒序。
 * @param {string} dshHome DSH 家目錄（不是插件家目錄）
 * @returns {Array<{id:string,title:string,lastPromptAt:number}>}
 */
export function readSessionMeta(dshHome) {
  const dir = join(dshHome, ...SESS_DIR)
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return [] // 沒有這個目錄（版本不同 / 全新安裝）→ 當作沒有標題
  }
  const out = []
  for (const name of names) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const rows = doc?.record?.rows ?? {}
      const title = String(rows?.title?.val ?? '').trim()
      const at = Number(rows?.sessionListMetadata?.val?.lastPromptAt ?? 0)
      out.push({
        id: name.replace(/\.json$/, ''),
        title,
        lastPromptAt: Number.isFinite(at) && at > 0 ? at : 0,
      })
    } catch {
      /* 單一檔壞掉（寫到一半 / 不是我們的格式）→ 跳過，不影響其他人 */
    }
  }
  return out.sort((a, b) => b.lastPromptAt - a.lastPromptAt)
}

/**
 * 把「宿主在線的會話」與「存儲裏的標題」合起來，按最近活動倒序。
 * - 宿主列表非空：以它為主（那才是能真正塞訊息進去的會話），標題從存儲補。
 * - 宿主列表為空（會話都沒開著）：退回存儲裏最新的那一個，只為了讓設置頁還看得到名字。
 * @param {Array} agentList `ctx.agents.list()` 的原始結果
 * @param {Array} meta `readSessionMeta()` 的結果
 */
export function mergeSessionMeta(agentList, meta) {
  const byKey = new Map()
  for (const item of meta || []) byKey.set(keyOf(item.id), item)

  const rows = []
  for (const item of agentList || []) {
    const id = String(item?.session?.id ?? item?.id ?? '')
    if (!id) continue
    const fromHost = String(item?.session?.title ?? item?.title ?? '').trim()
    const hit = byKey.get(keyOf(id))
    rows.push({
      id,
      title: fromHost || hit?.title || '',
      lastPromptAt: hit?.lastPromptAt ?? 0,
    })
  }

  if (rows.length === 0) {
    // 沒有一個會話醒著：拿存儲裏最近、且有標題的那個當「最新」
    const newest = (meta || []).find((item) => item.title)
    if (newest) {
      const id = newest.id.startsWith('session-') ? newest.id : `session-${newest.id}`
      rows.push({ id, title: newest.title, lastPromptAt: newest.lastPromptAt })
    }
    return rows
  }

  return rows.sort((a, b) => (b.lastPromptAt || 0) - (a.lastPromptAt || 0))
}
