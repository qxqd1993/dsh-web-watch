# CHANGELOG

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
