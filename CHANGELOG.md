# CHANGELOG

## 0.1.10 — 2026-10-28

### 加（契約＋strategy＋外部導出；算法與輸出一行沒改）

- **契約文件 `docs/extract.md`**：把 `extractMain` 當成一個有契約的小庫寫清楚 ——
  - 輸入：`html`、`{ url, status, maxChars, strategy }` 的型別、預設與用途（`url` 只傳給 strategy；
    `status` 403/429 直接 blocked；`maxChars` 只截回傳值）；
  - 輸出：`ok / title / text / chars / ratio / tier / reason` 的型別與語義（`ratio` 用**截斷前**正文算、
    baseline 是整頁去標籤字數）；
  - `tier ∈ blocked/shell/partial/full` 的**判定順序與門檻**（0 字、<400 且 >50KB、<800、
    段落 <3 或 ratio <0.1），以及 `ok = tier 是 full 或 partial`；
  - 錯誤語義：`reason` 永遠是人話、沒有錯誤碼；機器判斷看 `tier` + `ok`；
  - 穩定度承諾：契約在 1.x 內不變；算法／門檻可調，但必須讓 `probe/extract-eval.mjs` 的 fixtures 全過。
- **可替換策略 `strategy`（一行式擴展點，沒有 registry）**：`extractMain(html, { strategy })` 會呼叫
  `strategy(html, { title, status, url })`，期望回 `{ text, how? }`。`text` 原樣採用；`chars/ratio/tier/maxChars`
  照舊由 `extractMain` 算。不傳 / 傳 `null` 用**現行算法**（原封不動搬進 `defaultStrategy`）。
  非法策略（不是函式 / 拋錯 / 形狀不對）⇒ `tier:'shell'` + `ok:false`，**不把例外丟給調用方**；
  blocked 優先於 strategy，命中就不呼叫它。`lib/readpage.mjs` / `lib/engine/run.mjs` 不傳 strategy，
  語義完全不變。
- **對外導出**：`package.json` 的 `exports` 新增 `"./extract": "./lib/extract.mjs"`，第三方可用
  `import { extractMain } from 'dsh-web-watch/extract'`；`files` 補 `docs/`、`probe/extract-strategy.mjs`。
  README 加了三行「第三方怎麼用」＋建議先跑 fixtures。
- **測試**：
  - 新增 `probe/extract-strategy.mjs`（10 項）：證明自訂策略真的被呼叫、拿到 `{ title, status, url }`、
    只回第一段時輸出確實改變；四種非法策略都在 `extractMain` 邊界被降級成 shell 且不拋；
    `strategy:null` 等於預設；blocked 優先且不呼叫 strategy。
  - `scripts/smoke.mjs` 新增 3 項（注入生效、預設路徑不串味、非法策略安全降級），`--offline` 從 73 → **76/76**；
    repo 檢出佈局（沒有兄弟 `web-watch/`）從 66 → **69/69**（7 項 P1 CLI 跳過）。
  - `probe/extract-eval.mjs` 的 10 條 fixtures 輸出**逐字元相同**（改前/改後 diff `IDENTICAL`，
    10/10 通過），證明這輪只加契約與擴展點、沒有動算法。
- **結果**：`node --check` 全過；`node probe/extract-eval.mjs` 10 條全過（字數與 0.1.9 一致）；
  `node probe/extract-strategy.mjs` 全過；`node scripts/smoke.mjs --offline` 76/76；repo 佈局 69/69。
  帶真網路的部分本輪未重跑。
- **為什麼不拆獨立 repo / npm 包（YAGNI）**：它現在就是**一個零依賴檔案**，唯一消費者是本插件
  （`readpage` / `run.mjs`）；拆包要另立 repo、發佈流程、版本對齊與 fixture 同步，換來的只是
  「聽起來比較模組化」。這一輪真正缺的是**契約與可替換點**，不是套件邊界 —— 用 `docs/extract.md`
  ＋ fixtures 固定住，外部要用的話 `dsh-web-watch/extract` 這個子路徑已經夠了。等真的出現第二個
  獨立消費者（或需要獨立版本節奏）再拆，成本才划算。
- **版本**：`0.1.9 → 0.1.10`。

## 0.1.9 — 2026-10-27

### 安全（SSRF：擋掉伺服器端請求偽造）

- **對抗性測試補洞（同日，Lead 複核後）**：子代理原本的表 30/30 全綠，但用外部清單去攻，
  發現 **6to4（`2002::/16`）與 Teredo（`2001:0::/32`）** 這兩類「內嵌 IPv4 的隧道段」沒被擋 ——
  它們可以經中繼把請求帶進內網。已補上 6to4 / Teredo / benchmarking `2001:2::/48` /
  discard `100::/64` / local-use NAT64 `64:ff9b:1::/48`，案例表從 30 條增到 **36 條**。
  ⇒ 教訓：**「自己的測試全綠」不等於「清單完整」**，要拿外部的對抗清單去撞。

- **動機**：插件跑在宿主進程裏，`fetch` 有完整網路權限；而 `web_watch_read` 與定時抓源
  過去都接受**任意** https URL。於是一條被投毒的 feed（或一句「幫我讀這個連結」）就能讓
  `https://169.254.169.254/latest/meta-data/`、`https://10.0.0.5/`、`https://127.0.0.1:8443/`
  的內容被拉進 digest —— 而 digest 是會進模型上下文的。典型 SSRF，且能直接外帶內網資料。
- **新增 `lib/safeurl.mjs`（零依賴、不發請求、不寫檔）**：
  - `checkPublicHttpsUrl(raw, { resolve })`：形狀（只 `https:`、埠只能 443 / 省略、不帶帳密）
    + IP 字面值（loopback / link-local / 私有 / `0.0.0.0` / CGNAT / 組播保留 / 文件用段 /
    IPv4-mapped 與 NAT64 內嵌的私有 IPv4）+ 主機名（`localhost` / `*.local` / `*.internal` / `*.localhost`）
    + `dns.lookup(host, { all: true })` 解析出**所有** A/AAAA（任一落內網就拒，防「公開域名指向內網」）；
    解析失敗 / 5s 超時 ⇒ `dns-failed`。code：`not-https` / `has-credentials` / `bad-port` /
    `private-host` / `dns-failed` / `bad-url`。
  - `checkPublicHttpsUrlSync(raw)`：同一套規則但**不碰 DNS**，給配置校驗用。
  - `resolve` 可注入（測試不打真 DNS）；**故意不快取**判定結果（避免把 stale 判斷帶進請求路徑）。
- **三個入口全部必經**：
  1. `lib/readpage.mjs`：抓取前檢查；redirect 改成**自己跟**（`redirect:'manual'`，≤5 跳），
     **每一跳重新檢查**，最後再核對 `response.url` 的 host ⇒「公開 URL → 302 內網」在發請求前就被擋；
     失敗新增 `code: 'unsafe-url'`（`http://` / 非法 URL / 解析失敗仍回原本的 `unreachable`，不改既有語義）。
  2. `lib/engine/run.mjs`：主 URL 與**每一個** `fallbacks` 都先檢查（不合格 ⇒ 該端點跳過、`failure.code = "unsafe-url"`、
     照常計 `failures` / `failStreak`，請求不發出去）；redirect 也改成自己跟、逐跳檢查（新增 `LIMITS.maxRedirects = 5`）。
  3. `lib/engine/loader.mjs`：`normalizeSource` 在**配置階段**就拒私有 / 本機**字面值**（含 `fallbacks`）；
     ⚠️ 這裡**故意不解析 DNS** —— 配置校驗不能變成阻塞的網路請求。
- **測試（全部離線，零真 DNS）**：
  - 新增 `probe/safeurl-cases.mjs`：30 條案例表（`http://` / 帳密 / `:8080` / `127.0.0.1` / `[::1]` /
    `169.254.169.254` / `10.1.2.3` / `172.20.0.1` / `192.168.1.1` / `0.0.0.0` / `localhost` / `foo.local` /
    公開域名→公開 IP / 公開域名→`192.168.1.1` / 混合 A 記錄 / 解析失敗 / 十進位與十六進位寫法的 127.0.0.1 /
    `::ffff:` 包裝 / `fe80::` / `fd00::` / `100.100.100.200` / `metadata.google.internal` / 對照組放行）；
    `node probe/safeurl-cases.mjs` 直接印 URL / 期望 / 實際 / 原因四欄。
  - `scripts/smoke.mjs` 新增 12 項：案例表（1）+ 端到端（`web_watch_read` 對內網 URL 與工具入口
    都回 `unsafe-url` 且**零請求**、源配置 / `fallbacks` 的私有 URL 被 `ConfigError` 拒、假 fetch 模擬
    `302 → 169.254.169.254` 只發 1 個請求）+ 設置頁 `POST /sources` 拒絕內網源且沒寫進檔（2）+
    引擎端 3 條（私有源 ⇒ `unsafe-url` + `failStreak=1` + 0 請求、引擎 `302` 到內網只發 1 個請求、
    不安全主 URL + 安全 fallback 走 fallback 成功）。
  - 既有離線測試改為**注入假 resolver**（`.example` 這種域名以前靠「真的連不上」兜著，現在不該讓
    任何測試依賴真 DNS）。
- **結果**：離線 `73/73 ok`（原 61）、帶真網路 `90/90 ok`（原 78，5 條真源全部抓得到、self-check 11/11）；
  repo 檢出佈局（沒有兄弟 `web-watch/`）離線 `66/66 ok`。
- **限制（本版故意不做）**：**DNS rebinding 未解** —— 解析與 `fetch` 實際連線是兩次獨立解析，
  中間可能被換掉。正解是 pinned-IP（解析一次 → 用該 IP 連、SNI/Host 照舊，需改用 `node:https` + 自訂
  `lookup`，還要處理 TLS 與 IPv6），工程量另計。另外不做網路層出口限制，且在判定與連線之間仍有時間窗。
  詳見 README「安全邊界：SSRF（0.1.9）」。
- **版本**：`0.1.8 → 0.1.9`。

## 0.1.8 — 2026-10-27

### 修（只動測試，不動產品行為）

- **CI 在乾淨檢出上必定紅**，原因有兩個，都是煙霧測試對環境的假設：
  1. 「導出 Config」寫成硬斷言 —— 但 `@deepseek-ai/schemastery` 是**可選** peer dep，CI 不裝它時插件本來就該走降級。
     現在改成用**跟插件同一套偵測**（`loadHostDeps()`）判斷：宿主有 `z` 就要求有 `Config`，沒有就要求沒有。
     （不能用本模組 `import('@deepseek-ai/schemastery')` —— 那在「有 DSH 家目錄但沒有本地 node_modules」的環境會誤判。）
  2. P1 CLI 的測試假設「插件目錄旁邊有 `web-watch/`」—— 那是**工作區**的佈局，repo 檢出時不存在。
     現在偵測不到就整段跳過並印一行說明，不再算失敗。
- 結果：本地 61/61、repo 檢出佈局 54/54（7 項 CLI 測試被跳過）。

## 0.1.7 — 2026-10-26

### 修（配置所有權：一個值只有一個家）

- **事故**：2026-10-25 21:27:28 把「每天第一窗」改成 17:30 的那次保存，`config.json` 與
  `sources.json` 各走一條路，每條路自己「讀一份 cfg → 寫檔」；其中一條讀到舊值 ⇒
  `config.json` = 17:30、`sources.json` 仍 09:00，兩個檔的 mtime 卻停在同一秒
  （見 `watch.log` 的 `2026-10-25T13:27:28` 兩行）。根因不是值算錯，是**配置有兩個家**。
- **結構決策（方案 B：單一真值 + 遷移 + 自癒）**：
  - `schedule`（`startAt` / `intervalHours` / `timezone`）的唯一真值是
    `<家目錄>\config.json` + 內建 `DEFAULT_SCHEDULE`。`loadCfg()` / `effectiveSchedule()`
    **不再把 `sources.json.schedule` 當基線**（連校驗都不做 —— 它是鏡像，壞了不該擋抓取）。
  - `sources.json.schedule` 降級成**兼容鏡像（deprecated）**：只在「保存配置」與「啟動自檢」
    由插件寫入；JSON 帶 `"_scheduleMirror": "derived from config.json; do not edit"`。
    欄位**保留**，舊版 P1 CLI 照樣讀得到。
  - **啟動自癒**：`apply()` 排入一次比對，有效 schedule 與鏡像不一致就重寫鏡像，並記一行
    `啟動自癒：sources.json.schedule 09:00 → 17:30（真值 config.json）`。
    若 `config.json` 還沒有任何 schedule 鍵、而 `sources.json` 帶了非預設值，先做一次
    **遷移**（避免升級時把既有 17:30 丟成預設）。
  - **寫入串行化**：`lib/state.mjs` 新增 `createWriteQueue()`；`persistCfg`
    （config.json + 鏡像）、`saveSources`、啟動遷移/自癒共用同一條 promise 隊列。
    鏡像用的 schedule 取自**同一次要寫下去的 cfg 快照**，不會再出現「一邊新、一邊舊」。
    log 不排隊（寫不進去也不影響一致性）。
  - **可觀測**：`web_watch_status` 與 `GET /api/web-watch/status` 多回 `scheduleSource`
    （`config.json` / `defaults`）；設置頁「每天第一窗」下面多一行小字
    `時間來源：config.json`（只加這一行，未動排版）。
  - **P1 CLI**（`web-watch/pull.mjs`）：三層優先級
    `config.json` → `sources.json.schedule`（命中即**一次性遷移**進 config.json 並 log）→
    `DEFAULT_SCHEDULE`。遷移後即使再改 sources 也不會生效（退役）。
    `web-watch/lib/loader.mjs` 拆出 `loadSources()`（不再強制 schedule），新增
    `web-watch/lib/schedule-source.mjs`；CLI 多印一行 `[schedule] …（來源：…）`，
    `--tick` 的 `not-due` 路徑也看得到。
- **測試**：`scripts/smoke.mjs` 新增 21 項 —— 啟動自癒（09:00 → 17:30 + log + 標記）、
  升級遷移（只有 sources 17:30 ⇒ config.json）、`scheduleSource`、`persistCfg` 與 `saveSources`
  併發後兩檔一致且源不丟、P1 CLI 三層優先級 / 遷移 / 退役 / defaults。
  離線 61/61；線上 78/78（原 57 項不退化）。
- **版本**：`0.1.6 → 0.1.7`。README（插件與 P1）同步「schedule 以 `config.json` 為準、
  `sources.json.schedule` 只是會被覆蓋的鏡像」。

## 0.1.6 — 2026-10-25

### 修

- **正文頭尾的雜質**（`extract.mjs` 新增 `trimBoilerplate`）。起因是讀 EUobserver 那篇時發現：
  正文乾淨，但前面拖著圖注／標題重複／`Unlock article and share`／署名，後面拖著
  `Latest from …`／`Topics`／`Author Bio`／`+ Follow author`，還有 LA Times 的閱讀時間與分享列。
  這些不是正文，卻把 `chars` 撐高（例：euobserver-bulgaria 5,342 → 2,793 字）、讓 `ratio` 虛胖，
  也讓 400 字摘錄從圖注開始。
  三層處理：① 行內清洗（`"2 Comments Unlock article and share"` 這種黏在一行的要先拆）；
  ② 尾巴從第一個尾段標記起整段切（含付費牆 `to read this story, log in or subscribe`、電子報、相關推薦、日期列）；
  ③ 頭部連續砍標題重複／署名／圖注／麵包屑（含被拆成兩行的 `China` + `22:57, 21-Oct-2026`）／閱讀器殘骸。
  仍誠實保留管不到的：CGTN 的 lead 圖說明會被當成正文第一段（它是文章內容的一部分），
  LA Times 的 `Staff Writer …` 那類多段署名只能砍到大部分。

## 0.1.5 — 2026-10-25

### 新增（B）正文抽取器 `lib/extract.mjs`

- **零依賴正文抽取**：`extractMain(html, { url, maxChars, status })` →
  `{ ok, title, text, chars, ratio, tier, reason }`。
  token 掃標籤（不建 DOM、不執行 JS），先判 blocked（HTTP 403/429、`Just a moment...`、
  `Enable JavaScript and cookies`），再砍 script/style/head、nav/header/footer/aside，
  class/id 命中 boilerplate 的容器只標記不砍（CGTN 把正文放在 `…comment` 外殼裡，硬砍會砍掉文章）；
  正文優先 `article` / `main` / `role=main` / `itemprop=articleBody`，否則按
  「段落字數 × (1 − 連結密度) + 段落數 × 20」取分。清理純連結列 / 版權行 / 連續短行。
  tier = `blocked` / `shell` / `partial` / `full`；`ratio` = 抽出字數 / 純去標籤 baseline。
- **可評測**：`probe/extract-eval.mjs` + `probe/fixtures/*.html`（10 條真連結：euobserver ×3、
  latimes ×3、cgtn ×3、arabnews 403 反例）。第一次跑抓 HTML 存 fixture（單檔 ≤ 800KB，
  超過截斷並記在 `fixtures/MANIFEST.json`），之後預設離線重跑；`--refresh` 重新抓。
  本輪結果：5 條 euobserver/cgtn 都 ≥ 800 字（4.1k–9.5k）且 tier=full，arabnews 判 blocked。
- `kind:"html"` 的 adapter 從 identity 透傳改走 `extractMain`（tier 非 full 時 digest 標
  「低信度（正文抽取 tier=…）」）；抽取失敗直接進「抓不到」，不再把導覽當正文。

### 新增（A）`web_watch_read` 工具

- 讀**一條**連結的正文：`{ ok, url, title, chars, ratio, tier, excerpt, savedTo }`，
  `excerpt` 最多 400 字，**全文不進模型**；全文落 `<家目錄>\pages\read\<host>-<hash8>.txt`
  （沿用快照格式：`# 標題` / `<!-- source: url | iso -->` / 空行 / 正文，寫入前 `assertInside`）。
- 硬限制：只收 https、一次一條、timeout 15s、≤ 5MB、redirect ≤ 5、同 host 請求間隔 ≥ 1s、
  每分鐘最多 3 次（記憶體計數）；超過明確拒絕。失敗分類
  `blocked` / `unreachable` / `not-html` / `too-large` / `rate-limited`，每個都有可讀原因。
- `web_watch_status` 的 hint 與 README 工具段落同步；`scripts/smoke.mjs` 加 13 項（拒 http/非法 URL、
  真網路讀 euobserver 且回傳不含全文、not-html / too-large / 403 / 限速）。

### 新增（C）源健康與熔斷

- `index.json` 新增 `failStreak`（連續失敗；成功歸零、失敗 +1；舊 index.json 缺欄位視為 0）。
- digest 頂端：任一源 `failStreak ≥ 3` 時加 `## ⚠ 注意`，列出「連續失敗 N 次（lastStatus）——
  要考慮換端點或刪掉」；未達門檻整節不出現（不留空節）。
- 源可用 `fallbacks: [url...]`（最多 5 條，同樣只收 https、不帶帳密）：主 URL 失敗依序試，
  全部失敗才記 failed，原因註明「試過 N 個端點」；fallback 成功則 failures=0、failStreak=0。
- `runPull()` 多一個 `fetchImpl`（測試注入用）；smoke 加 9 項覆蓋 failStreak / 注意節 / fallback /
  `kind="html"` 改走 extractMain。

## 0.1.4 — 2026-10-25

### 改

- **設置頁「最新會話」看得懂名字了**：原本那行 `可选会话：session-…（session-…）` 把同一串 uuid 印了兩遍 ——
  因為宿主 `ctx.agents.list()` 的會話物件**不帶 title**。
  現在改從 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val` 取標題，
  只顯示最近活躍的那一個：有標題 → `最新會話：試運行dsh（session-99843920-…）`；取不到 → `最新會話：session-99843920-…`。
  這是**盡力而為**地讀內部存儲：目錄不存在、格式改了、單檔壞掉，一律退回只顯示 id，不影響抓取與排程
  （實作在 `lib/sessions.mjs`，11 項 probe 覆蓋正常／退化／缺目錄三種情況）。

## 0.1.3 — 2026-10-25

### 修

- **digest 對 `role:"index"` 的源印出假內容**：每條都印的「- 前 200 字：…」對 index 源（`tech-weekly-index`、
  `latimes-world` 這類）抓到的是**來源站的自我介紹**（例如 `Rust语言中文社区新闻和日报`），不是當期內容 ——
  讀者會把噪音當正文。現在 `buildDigest()` 依 `result.source.role` 分流：
  index 條目只留「來源 / 時間」+「- 只有摘要（無全文）」，**不再印前 200 字**；
  `role:"full"` 的條目完全不變（照樣印前 200 字）。三節標題、只有 index 條目時的排版都不受影響。
  抓取 / 去重 / 排程一行未動；`role` 原本就由 `run.mjs` 的 `result.source` 帶進 digest，無需改資料流。

## 0.1.2 — 2026-10-25

### 修

- **設置頁兩條 label 被壓成豎條**：`目標會話 id` / `怎麼稱呼你` 兩行的文字欄 `[data-ww-grow]` 寬度為 0 ——
  同行的裸輸入框吃了 `width:100%`，在 flex 行裡 basis = 整行，只剩 10px 缺口要收縮，
  而文字欄的 shrink factor 是 0，分不到任何寬度 → 中文沒有自然斷點 ⇒ 一字一行。
  修法：`[data-ww-grow]{flex:1 1 auto}`、`[data-ww-label]{flex:0 0 auto;white-space:nowrap}`、
  行容器加 `flex-wrap:wrap`，並給「行內的裸輸入框」補 `flex:1 1 160px;min-width:0;width:auto`。
  `[data-ww-when]` / `[data-ww-num]` / 下拉選單 / 源清單列內的 url 輸入框量測前後一致，未被波及。

## 0.1.1 — 2026-10-24

### 修

- **dry-run 的自檢在說謊**：`web_watch_pull { dryRun: true }` 原本回 `checks: "undefined/undefined ok"`、
  `cleanup.remaining: 0`。根因是 `runPull()` 的 dry-run 分支提早 return，留下空 `checks` 陣列
  （`[]` 是真值 → 格式化那行吐出 `undefined/undefined`），而 `remaining` 寫死 0，等於假裝家目錄是空的。
  現在 `checks` 明說「dry-run（不寫檔，自檢略過）」，`cleanup.remaining` 回真實快照數；
  真跑那條路不受影響（仍 `11/11 ok`）。

## 0.1.0 — 2026-10-24

第一版：把跑通的 P1 `web-watch`（Node CLI）包成可安装的 DSH 插件。

### 新增

- **插件骨架**（形状对齐 `dsh-bili-subagent`）：`package.json`（`type/main/exports/files/engines/peerDependencies/dsh.bundle/dsh.client`）、
  `cordis.patch.yml`（`- insert: [{ id: web-watch, name: dsh-web-watch, config: { enabled: true } }]`）。
- **4 个工具**：
  - `web_watch_status`：开没开 / 下次到期 / 每源 `failures`+`lastStatus` / 最新 digest；
  - `web_watch_pull`：手动跑一輪（`source` 指定单源、`dryRun` 只抓不写），回摘要 + 前 3 条标题与链接；
  - `web_watch_config`：读/改配置（`enabled/startAt/intervalHours/targetSession/ownerName`），改完持久化；
  - `web_watch_sources`：列源 + 健康度，也可 `add`/`update`/`remove`。
- **60 秒 tick**：到点才跑；回呼整体 `try/catch`（未捕获异常会杀掉宿主进程）；
  跑完按 `targetSession` 用 `ctx.agents.get(id).followup(msg)` 把摘要塞进会话；留空则不塞。
  防重入（一輪跑几十秒，60 秒一跳可能叠加）。
- **设置页**（`client.js`）：总开关 / 开始时间 / 间隔 / 目标会话 / 称呼 / 源清单增删改 +
  「立即跑一輪」「重新載入」「看最新 digest」；保存前页面校验，宿主后端再校验一次。
  存配置走 bili 那条既有通道：`ctx.settings.update(ns, patch, revision)` + `config.json`。
- **家目录** `<DSH_HOME>\web-watch\`：`sources.json` / `index.json` / `pages/` / `out/` / `watch.log` / `config.json`；
  首次运行自动铺好三条默认源（`cgtn-world` / `tech-weekly-index` / `steam-news`）。
- **引擎移植** `lib/engine/*.mjs`（9 个模块 + `run.mjs`）：逻辑照 P1 原样搬，
  只把 `store.mjs` 的 root 换成插件家目录、去掉对 `process.cwd()` 的依赖，`assertInside()` 边界检查保留；
  `pull.mjs` 的 CLI 入口不搬，编排流程抽成 `runPull({homeDir, sources, schedule, now, only, dryRun, log})`。
- `scripts/smoke.mjs`：无需 DSH 的烟雾测试（假 ctx + 假 req/res 打设置页通道 + 两条真源跑两轮验去重）。

### 已知

- `kind:"html"` 仍是 identity 空壳（P1 原样），digest 标「低信度」。
- `role:"index"` 不跟进第二层链接（P3 未做）。
- 设置页路由是插件自己注册的 prefix（`/api/web-watch`），写法与 bili 的 `/api/bili-duty` 相同。

### 依赖

- 零第三方依赖（只用 `node:` 内建模组）。
- `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 列为 **optional peer**：
  从宿主树里解析，拿不到就用本地等价实现（没有 `Config` / `defineTool` 原样返回），**插件本体照常加载**。
