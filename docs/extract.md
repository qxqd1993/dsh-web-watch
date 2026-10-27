# `extractMain` 契約（正文抽取器）

`lib/extract.mjs` 是一個**零依賴、同步、不碰網路也不寫檔**的正文抽取器：給它一份已經抓下來的
HTML，它回一份結構化結果。套件子路徑 `dsh-web-watch/extract` 就是這個檔案。

```js
import { extractMain } from 'dsh-web-watch/extract';

const doc = extractMain(html, { url: 'https://example.com/a', status: 200 });
if (doc.ok) console.log(doc.title, doc.text);
```

> 這個模組**不**做 URL 安全檢查，也不負責抓取 / 解壓 / 大小限制 —— 那些是呼叫方
>（`lib/readpage.mjs`、`lib/engine/run.mjs`）的事。它只回答「這份 HTML 的正文是哪一段」。

---

## 1. 輸入

```js
extractMain(html, { url, status, maxChars, strategy } = {})
```

| 參數 | 型別 | 預設 | 用途 |
| --- | --- | --- | --- |
| `html` | `string` | 必填（`null`/`undefined` 會被 `String()` 轉成 `''`） | 完整 HTML。只去掉開頭的 BOM，其餘原樣分析。 |
| `url` | `string` | `''` | **只**原樣傳給 `strategy` 的 context；不參與評分、不發請求、不做校驗。 |
| `status` | `number` | `0` | HTTP status。`403` / `429` 直接判 `blocked`（即使 body 看起來正常）；`0` = 未知。 |
| `maxChars` | `number` | `0` | 只截**回傳的** `text` / `chars`；`0`、負數、非有限數 = 不截。內部判斷與 `ratio` 仍用完整正文。 |
| `strategy` | `function \| null` | `undefined` | 自訂抽取策略（見 §4）。`undefined` / `null` = 用內建算法。 |

`options` 傳 `null` / 非物件時視同 `{}`（不拋錯），每個欄位各自用預設值。

`extractMain` 是同步函式：沒有 Promise、沒有 callback、沒有 registry。要非同步的抽取請在外面先
`await` 好，再丟一份字串進來。

---

## 2. 輸出

回傳一個普通物件：

| 欄位 | 型別 | 語義 |
| --- | --- | --- |
| `ok` | `boolean` | **`tier === 'full'` 或 `tier === 'partial'`** 時為 `true`；`blocked` / `shell` 為 `false`。 |
| `title` | `string` | `<title>`，沒有就 `og:title`，都沒有就 `''`。已解 HTML entity、空白已收斂。 |
| `text` | `string` | 預設算法下是一行一段（`\n` 分隔）；自訂策略的 `text` 原樣回傳（見 §4）。`blocked` / `shell` / 策略失效時為 `''`。套用 `maxChars` 後就是最終值。 |
| `chars` | `number` | **回傳 `text` 的長度**（UTF-16 code unit，不是 byte）。套用 `maxChars` 後計算。 |
| `ratio` | `number` | **截斷前**的正文長度 `/ baseline`，保留 3 位小數；`baseline` 為 0 時為 0。所以 `maxChars` 生效時，`ratio` 可能高於「所見 `chars`」的比例。 |
| `tier` | `'blocked' \| 'shell' \| 'partial' \| 'full'` | 信度分級（見 §3）。機器判斷請看它和 `ok`，不要解析 `reason`。 |
| `reason` | `string` | 給人看的一句中文說明：用了哪種算法、幾段、為何降級、是否截斷、或策略失效的原因。**沒有錯誤碼。** |

`baseline` 的定義（`ratio` 的分母）：同一份 `html` 去掉所有標籤、解 entity、收斂空白後的字數 ——
也就是「整頁純文字」的長度，包含導覽與頁腳。

`blocked` / 策略失效時回傳的固定形狀是：

```js
{ ok: false, title, text: '', chars: 0, ratio: 0, tier: 'shell', reason: '…' }
```

（`blocked` 則是 `tier: 'blocked'`、其餘相同。）

---

## 3. `tier` 判定門檻與 `ok` 的關係

依序判斷，**先命中先回傳**：

| # | 條件 | `tier` | `ok` |
| --- | --- | --- | --- |
| 1 | `status` 是 `403` / `429`，或 HTML 命中 Cloudflare 挑戰頁標記 | `blocked` | `false` |
| 2 | `strategy` 不是函式 / 拋錯 / 回傳形狀不對 | `shell` | `false` |
| 3 | 正文長度 `0` | `shell` | `false` |
| 4 | 正文 `< 400` 字，且原始 HTML `> 50KB` | `shell`（疑似 JS 殼） | `false` |
| 5 | 正文 `< 800` 字 | `partial` | **`true`** |
| 6 | 段落數 `< 3`，或 `ratio < 0.1` | `partial` | **`true`** |
| 7 | 以上都不是 | `full` | **`true`** |

- 「正文長度」= 完整正文（未套 `maxChars`）。
- 「段落數」= 每個非空行長度 `≥ 40` 的數量。內建策略算的是清理後的行；自訂策略算的是
  `text.split('\n')` 的非空行。
- 「原始 HTML 大小」= 去掉 BOM 後的 UTF-8 byte 數。
- `blocked` 標記（不分大小寫）：`Just a moment...`、`Enable JavaScript and cookies`、
  `Attention Required! | Cloudflare`。
- `blocked` 是抓取層的事實，**優先於** `strategy`：命中就不會呼叫它。
- 門檻數字是 0.1.10 的實作值，後續可能微調；調整必須讓 `probe/extract-eval.mjs` 的
  fixtures 全過（見 §6）。分級集合與 `ok` 的對應關係才是契約。

---

## 4. `strategy`：一行式替換策略

```js
extractMain(html, {
  strategy(html, { title, status, url }) {
    return { text: '<你要的正文>', how: 'first-paragraph' }; // how 可省略
  },
});
```

- 呼叫時機：沒被判 `blocked` 之後（HTML 可以是空字串；空字串結果會落到 `shell`）。
- 參數：`html` 是去 BOM 後的字串；context 是 `{ title, status, url }`，其中 `title` 是
  `extractMain` 已經挑好的標題，`status` / `url` 就是輸入值。
- 回傳：**必須**是物件，且 `text` 是字串；`how` 可省略（非空字串，預設 `'custom'`）。
  `how` 只會出現在 `tier` 為 `full` 時的「正文抽取（<how>，N 段）」描述裡；一旦降級成
  `partial` / `shell`，`reason` 會改成降級原因（`how` 不再出現）。
- `text` **原樣採用**：不 trim、不再去雜、不做 strip-tags fallback。`chars` / `ratio` /
  `tier` / `maxChars` 仍由 `extractMain` 照 §2、§3 計算。
- 回傳空字串是合法的（結果會落到 `tier:'shell'`「抽不到任何正文文字」）。
- **不支援 async**：回傳 Promise 會被視為形狀不對（沒有 `text` 字串）。

非法策略不會把例外丟給調用方，而是安全降級：

| 情況 | 結果 |
| --- | --- |
| `strategy` 不是函式（例如 `'x'` / `{}`） | `tier:'shell'`，`reason` 說明「不是函式」 |
| 呼叫時拋錯 | `tier:'shell'`，`reason` 帶錯誤訊息（截到 120 字） |
| 回傳 `null` / 非物件 / `text` 不是字串 | `tier:'shell'`，`reason` 說明必須回傳 `{ text: string, how?: string }` |

這就是擴展點的全部 —— 一個函式，沒有註冊表、沒有優先級、沒有外掛載入。

---

## 5. 錯誤語義

- **`extractMain` 對壞輸入不拋錯**：`html` 不是字串會被 `String()` 轉掉；`options` 缺欄位用
  預設值；`strategy` 壞掉會降級（§4）。正常情況下它永遠回一個結果物件。
  （只有記憶體耗盡之類的執行環境錯誤才會冒出去。）
- **`reason` 永遠是人話**，不是錯誤碼：`blocked` 會說「HTTP 403…」或 Cloudflare 挑戰頁；
  `shell` 會說抽不到字 / JS 殼 / 策略失效原因；`partial` 會說「正文偏短」或「正文佔比低」；
  截斷會追加「已截到 maxChars=…」。
- 機器判斷請用 **`tier` + `ok`**；`reason` 的文字可能隨版本調整，不要拿來做字串比對。
- 與 `lib/readpage.mjs` 的分工：`readpage` 會把 `tier` 映射成 `code`（`blocked` /
  `not-html`），那是外層的錯誤語義；`extractMain` 本身沒有 `code`。

---

## 6. 穩定度承諾

- **契約在 1.x 內不變**：輸入參數、輸出欄位名稱與型別、`tier` 的四個值、`ok` 的定義、
  `strategy` 的簽名與「不拋錯」保證，都不會在 1.x 內破壞性變更。
- **算法與門檻可以變**（本來就是啟發式）：`tier` 的具體數字門檻、選區塊的評分、去雜規則
  都可能在 patch / minor 調整。**但任何調整都必須讓下面兩個探針全過**：
  - `node probe/extract-eval.mjs` —— 10 條真網頁 fixtures（逐條字數與分級）
  - `node probe/extract-strategy.mjs` —— `strategy` 注入與非法策略降級
- `reason` 的文字、`how` 的命名、`ratio` 的小數位不屬於穩定契約。
- 不會在 1.x 內移除或改名既有欄位；新增欄位只會是可選的、不影響既有讀取。

驗證方式（全部離線，不碰網路）：

```powershell
node probe/extract-eval.mjs
node probe/extract-strategy.mjs
node scripts/smoke.mjs --offline
```
