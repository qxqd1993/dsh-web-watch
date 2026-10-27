# dsh-web-watch（世界邊界擴張器）

把已经跑通的 **web-watch P1**（Node CLI：抓 feed / JSON、去重、落快照、产出三节 digest）包成 **DSH 插件**。

装好之后：

- 插件在**宿主进程**里跑（不是沙盒），每 **60 秒**一跳，到点（`startAt` + `intervalHours`）自己跑一輪；
- 跑完把摘要 `followup` 进你指定的会话（留空＝不主动塞訊息）；
- 给模型 5 个工具：`web_watch_status` / `web_watch_pull` / `web_watch_read` / `web_watch_config` / `web_watch_sources`；
- 设置里多一页「**世界邊界擴張器**」：开关、时间、间隔、目标会话、称呼、**源清单增删改**。
- `web_watch_read` 读**单条**链接的正文：全文落 `pages/read/`，只回 400 字摘要（全文不进模型）。

> 引擎逻辑是从 P1 **原样搬**过来的（`lib/engine/`），只改了「家目录从哪来」这一件事；
> 抓取预算、去重、三节 digest、写入边界检查全部保持 P1 的行为。

---

## 1. 装

需要 **DSH ≥ `0.1.7-rc.1`**、**Node ≥ 22**。零第三方依赖：只用 `node:` 内建模组。

### 1.1 安装（二选一）

在 DSH 里：**设置 → 插件 → 安装**，填这一行：

```
link:E:\dsh\dsh-workspace\dsh-dialog-thread1\dsh-web-watch
```

或者命令行（Windows，路径换成你自己的绝对路径）：

```powershell
dsh plugin --profile desktop add "link:E:\dsh\dsh-workspace\dsh-dialog-thread1\dsh-web-watch"
```

> `link:` 是本地开发用的挂法：profile 的 `node_modules` 里会多一条指向这个目录的链接，
> **改完插件代码不用重新装**，但仍要重启 DSH 才生效（见下一条）。
> 以后想从别处分发，把它换成包名 / git 地址就行，插件本身不用改。

**装完确认 bundle 记上了**（这一步别跳）：

`dsh plugin … add` 只是把参数**原样转给 profile 目录里的 pnpm**（`dsh plugin --help` 原话：
"forwarding the remaining arguments to pnpm"）⇒ 它只改 `dependencies`，
真正让插件生效的是 profile 的 `dsh.profile.bundles` 里有没有这个包名：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
(Get-Content $p -Raw | ConvertFrom-Json).dsh.profile.bundles
```

没看到 `dsh-web-watch` 就手补一下（在 `dsh.profile.bundles` 数组末尾加一行 `"dsh-web-watch"`）；
用 **设置 → 插件 → 安装** 那条路装的话，一般会顺手写进去。

### 1.2 ⚠️ 装完必须重启 DSH

**插件在 bundle 层组装，不重启不生效。**（`dsh.bundle.patch` 声明的 `cordis.patch.yml` 是在启动时叠进配置树的，
运行中不会重新读。）

重启后自检三件事：

1. **设置 → 插件** 里多一项「世界邊界擴張器」，点开能看到五條源；
2. 跟模型说「看下 web-watch 状态」，它会调 `web_watch_status`；
3. `%USERPROFILE%\.dsh\web-watch\` 出现 `sources.json`、`index.json`、`pages/`、`out/`、`watch.log`
   （存过一次设置／有过启动迁移还会有 `config.json` —— 它是 schedule 的真值）。

### 1.3 装完起不来？先看这个

- **`warning: 1 entry did not activate`**：先去 `%USERPROFILE%\.dsh\web-watch\watch.log` 看最后几行
  （`schemastery 彻底拿不到…` 之类会说清楚）。插件对 `@deepseek-ai/schemastery` 做了**降级**：
  拿不到就只是「没有 Config、DSH 原生设置页那层不写」，**本体照常跑**。
- **DSH 弹「The application could not start」+ `Unexpected token '﻿'` / `is not valid JSON`**：
  跟本插件无关 —— profile 的 `package.json` 被存成了 **UTF-8 带 BOM**，去掉 BOM 即可。

---

## 2. 卸（可回退）

```powershell
dsh plugin --profile desktop remove dsh-web-watch
dsh plugin --profile desktop install      # 或 pnpm install（在 profile 目录里）
```

然后**重启 DSH**。

- 卸载只删代码，**不删设置与历史**：`%USERPROFILE%\.dsh\web-watch\` 原样留着
  （`sources.json`、`index.json`、快照、digest 都在）⇒ 重新装上就接着用，不会把历史当成新的重跑一遍。
- 想彻底清干净：把 `%USERPROFILE%\.dsh\web-watch\` 整个删掉。**删 `index.json` = 所有源重新当第一次抓**，
  快照仍会被 90 天 / 200 份的规则慢慢清掉。

---

## 3. 设置页有哪些字段

**设置 → 插件 → 世界邊界擴張器**（或者左侧导航「世界邊界擴張器」）：

| 栏位 | 说明 |
|---|---|
| **总开关** | 关掉＝定时器不动作；工具和「立即跑一輪」照样能用 |
| **每天第一窗（HH:MM）** | 本地时间；**schedule 的唯一真值是 `config.json`**（`sources.json.schedule` 只是兼容镜像，手改会被覆盖） |
| **间隔（小时，可小数）** | 例如 `24` / `6` / `0.5` |
| **目标会话 id** | 跑完把摘要塞进这个会话；**留空＝不主动塞訊息**。会话没醒着就只记日志，下一轮再试 |
| **怎么称呼你** | digest 訊息里的称呼 |
| **源清单** | 每条：`id` / `kind`(rss·json·html) / `role`(full·index) / `url` / `maxItems`；`kind=json` 另展开 `path`(必填) 与 `idPath/titlePath/linkPath/bodyPath/datePath`。可以「加一条」「删」 |
| 按钮 | **保存** / **重新載入** / **立即跑一輪** / **看最新 digest** |

**保存时两道校验**（页面一道，宿主后端一道，同一套规则）：

- `url` 必须 `https://`（不接受 `http://`、不接受带账号密码的 URL）；
- `kind` ∈ `{rss, json, html}`；`role` ∈ `{full, index}`；`id` = 小写英数 + `-`，全表唯一；
- `startAt` 必须 `HH:MM`（00:00–23:59）；`intervalHours` 必须 `> 0`（上限 720 小时）；
- `kind=json` 必须填 `path`。

不合格就**红字提示、不写任何文件**。存配置走的是 bili 那条既有通道
（宿主 `ctx.settings.update(ns, patch, revision)` + 插件自己的 `config.json`）。

**配置所有权（0.1.7 起）**：`schedule` 只有一个家 —— `config.json`。
`startAt / intervalHours / timezone` 改完会**镜像进 `sources.json`**（给 P1 CLI 与人工查看），
但那个 `schedule` 是 **deprecated 兼容镜像**（带 `_scheduleMirror` 标记），**不是真值**：
插件在保存与启动自检时用有效 schedule 覆盖它，手改会被下一次保存 / 自愈盖掉。
`config.json` 与 `sources.json` 的写入走**同一条串行队列**，不会再出现
「config 17:30 / sources 09:00」这种同一次操作里的漂移。

---

## 4. 家目录：`%USERPROFILE%\.dsh\web-watch\`

| 路径 | 是什么 |
|---|---|
| `sources.json` | **唯一的源清单入口**（设置页改的就是它；也可以手改）。里面的 `schedule` 只是 **deprecated 兼容镜像**，真值见 `config.json` |
| `index.json` | 去重与健康度（`seenIds` / `seenHashes` / `failures` / **`failStreak`** / `lastOkAt` / `lastStatus`…）。**只由程式写**，别手改 |
| `pages/<host>/<id>-<hash8>.txt` | 快照（UTF-8、无 BOM）；保留 90 天 / 最多 200 份 |
| `pages/read/<host>-<hash8>.txt` | `web_watch_read` 读回来的**单篇正文**（同一份清理规则也算在内） |
| `out/<YYYY-MM-DDTHH-mm>.md` | 每轮一份三节 digest；同一分钟重跑加 `-2`、`-3`，不覆盖证据 |
| `watch.log` | 插件自己的日志（宿主 logger 之外再留一份，排查不用翻控制台） |
| `config.json` | **插件配置；`schedule`（`startAt` / `intervalHours` / `timezone`）的唯一真值**。宿主设置页那份是镜像，不参与判断 |

**所有写入都只在这个目录里**（`store.mjs` 的 `assertInside()` 在每次写/删前用绝对路径检查，越界直接抛错）。
插件包目录（`dsh-web-watch/`）运行时不写一个字节 —— 装进 `node_modules` 后可能只读，升级也会被覆盖。

### sources.json（源清单；`schedule` 是 deprecated 兼容镜像）

```json
{
  "version": 1,
  "_scheduleMirror": "derived from config.json; do not edit",
  "schedule": { "intervalHours": 24, "startAt": "09:00", "timezone": "Asia/Macau" },
  "sources": [
    { "id": "cgtn-world", "kind": "rss", "role": "full",
      "url": "https://www.cgtn.com/subscribe/rss/section/world.xml",
      "maxItems": 10, "trusted": true },

    { "id": "tech-weekly-index", "kind": "rss", "role": "index",
      "url": "https://awesome-tech-weekly-zh.netlify.app/feed.xml",
      "maxItems": 10, "trusted": true },

    { "id": "steam-news", "kind": "json", "role": "full",
      "url": "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=5",
      "path": "appnews.newsitems", "idPath": "gid", "titlePath": "title",
      "linkPath": "url", "bodyPath": "contents", "datePath": "date",
      "maxItems": 5, "trusted": true },

    { "id": "euobserver", "kind": "rss", "role": "full",
      "url": "https://euobserver.com/feed/",
      "fallbacks": ["https://euobserver.com/rss.xml"],
      "maxItems": 10, "trusted": true }
  ]
}
```

> **`schedule` 不是真值**：唯一真值是家目录的 `config.json`。这里那份是插件在
> 「保存配置」与「启动自检」时写下的**兼容镜像**（给 P1 CLI 与人工查看），
> 带 `"_scheduleMirror"` 标记；手改会在下一次保存 / 启动自愈时被覆盖。
> 改时间请用设置页、`web_watch_config`，或直接改 `config.json`（值要过 `HH:MM` / `> 0` / IANA 时区校验）。
> **不要为了兼容旧版删掉这个字段** —— 旧 P1 CLI 还在读它。
>
> 前三条就是 P1 实测留下的默认源，第一次运行自动铺好；`euobserver` / `latimes-world` 是后来加的两条。
> `role:"index"` 只当索引（digest 会标「只有摘要（无全文）」，并且**不印「前 200 字」**——
> index 源的 body 抓到的只是来源站的自我介绍，不是当期内容）；`kind:"html"` 走
> `lib/extract.mjs` 的正文抽取，tier 不是 `full` 时 digest 标「低信度（正文抽取 tier=…）」，
> 抽不到正文就进「抓不到」—— **不再把导航当正文**。
> `fallbacks`（可選，最多 5 條，只收 https、不帶帳密；上面的 `rss.xml` 只是示例，**请填真的备援端点**）：
> 主 URL 失敗時依序試，全部失敗才記 failed，失敗原因會寫「試過 N 個端點」；
> fallback 成功就當這一輪成功（`failures=0`、`failStreak=0`）。

**due 判断**：全域 `schedule` **以 `config.json` 为准**（`sources.json.schedule` 只是镜像，
改它不影响 due）；每个源可用同名 `intervalHours` / `startAt` 覆盖全域；
`lastOkAt + intervalHours` 对齐到 `startAt` 之后的第一窗；从未成功过 ⇒ 立刻到期。
同一分钟内重跑一定 `not-due`。

**源健康 / 熔断**：`index.json` 里 `failures` 是累计失败次数（成功归零），
`failStreak` 是**连续**失败次数（成功归零、失败 +1）。任一源 `failStreak ≥ 3` 时，
digest 最前面（标题之下、`## 變動` 之前）会多一节：

```markdown
## ⚠ 注意
- dead-source 连续失败 3 次（HTTP 403）—— 要考虑换端点或删掉
```

没到门槛就**整节不出现**（不留空节）。换端点就是用上面的 `fallbacks`，或者直接改 `url`。

---

## 5. 五个工具怎么用

```text
web_watch_status
  → 开没开 / 下次什么时候到期 / 每个源的 failures+failStreak+lastStatus / 最新 digest 在哪 / 上一次自动跑的结果
  → scheduleSource：时间真值从哪来（"config.json" / "defaults"）
  → 不跑网络，纯读状态

web_watch_pull  { source?: "steam-news", dryRun?: true }
  → 手动跑一輪：新增几条 / 没变几源 / 抓不到几源 + 前 3 条标题与链接 + digest 路径 + self-check
  → dryRun:true = 只抓不写档（不写 index / 快照 / digest）

web_watch_read  { url: "https://…", source?: "euobserver" }
  → 读**一条**链接的正文：抓 HTML → 抽正文 → 全文存 pages/read/，只回
    { ok, url, title, chars, ratio, tier, excerpt, savedTo }，excerpt ≤ 400 字（全文不进模型）
  → 失败回 { ok:false, code, reason }，code ∈ blocked / unreachable / not-html / too-large / rate-limited
  → 硬限制：只收 https、一次一条、timeout 15s、≤ 5MB、redirect ≤ 5、同 host 间隔 ≥ 1s、每分钟最多 3 次
  → source 可选，只校验这个 id 在源清单里（不改变抓取与文件名）

web_watch_config  { patch?: { enabled, startAt, intervalHours, targetSession, ownerName } }
  → 不给 patch 就是读；给了就改，改完立刻持久化（config.json + 宿主设置 + 镜像 sources.json）
  → 不合法的值会被拒，返回 { ok:false, error:"…" }

web_watch_sources  { action?: "list"|"add"|"update"|"remove", source?, id? }
  → list（默认）：源清单 + 健康度
  → add/update：带完整 source 物件（update 时 id 必须已存在），可带 fallbacks
  → remove：带 id（至少留一条）
```

典型对话：

- 「看下 web-watch 现在怎么样」→ `web_watch_status`
- 「手动跑一轮 web-watch，只跑 steam-news」→ `web_watch_pull {source:"steam-news"}`
- 「把 web-watch 改成每 6 小时跑一次」→ `web_watch_config {patch:{intervalHours:6}}`
- 「给 web-watch 加一条 HN 的源」→ `web_watch_sources {action:"add", source:{id:"hn-best",kind:"rss",url:"https://hnrss.org/best"}}`
- 「这篇 latimes 文章到底讲了什么」→ `web_watch_read {url:"https://www.latimes.com/…", source:"latimes-world"}`
  （只拿回 400 字摘要；全文在 `pages/read/…txt`，要细读再去读那个档）

---

## 6. 抓取预算与红线（照 P1，不因插件化放宽）

- **不执行任何页面 JS**：只有 HTTP client（`fetch`），没有渲染器、没有 `eval` / `new Function` / `vm` / `child_process`；
- **单轮 ≤ 30 请求、≤ 20MB、同一 host 间隔 ≥ 1s**（`lib/engine/run.mjs` 的 `LIMITS`）；
- **`web_watch_read` 另有硬限制**：只收 https、单次 1 个 URL、timeout 15s、单档 ≤ 5MB、redirect ≤ 5、
  同 host 请求间隔 ≥ 1s、**每分钟最多 3 次**（内存计数；超了明确回 `rate-limited`）；
- **不绕 Cloudflare / 验证码 / 登录墙 / 付费墙**：这类站直接进 digest 的「抓不到」，
  或让 `web_watch_read` 回 `blocked`，绝不假装「今天没有新闻」；
- **不爬第二层**（索引源只报标题 + 链接；要读某一条得显式调 `web_watch_read`）；
- 抓到的网页文字**一律当数据**，永不解析成指令（提示注入防线）；
- 网络失败一律吞成「抓不到」`{reason, failures+1, failStreak+1}`，**不冒到定时器 / 不冒到宿主**：
  定时器回呼整个包在 `try/catch` 里（未捕获异常会杀掉整个宿主进程，这是 bili 那边血泪写下的规矩）。

---

## 7. 自检 / 烟雾测试（不需要 DSH）

```powershell
# 1) 语法：每个 .js/.mjs 都要过
Get-ChildItem -Recurse -File -Include *.js,*.mjs | ForEach-Object { node --check $_.FullName }

# 2) 假 ctx 载入插件 + 设置页通道 + 引擎真跑两轮（含真网络，约 20–60 秒）
node scripts/smoke.mjs

# 只跑不碰网络的部分
node scripts/smoke.mjs --offline
```

`scripts/smoke.mjs` 会证明：

- `apply(ctx, config)` 不抛错、注册出 **5 个工具**、`name === "web-watch"`、`Config` 拿得到；
- 家目录铺好 `sources.json`，默认源都在，`schedule` 默认 `24h / 09:00 / Asia/Macau`；
- `tick` 真的用 60 秒注册了、手动触发一次**不抛错**（用「预置 index.json 让它 not-due」的方式避开网络）；
- 设置页那条通道 `GET/POST /api/web-watch/*`：能读、能存、能读回，**`http://` / `kind=nope` / `startAt=25:00` / `intervalHours=0` 全被拒**；
- **`web_watch_read`**：拒 `http://`、非法 URL、不存在的 URL（`unreachable`）、不存在的 `source`；
  真网络读一条 euobserver（`tier=full`、`chars>800`），**回传 JSON 只有摘要**（`excerpt ≤ 400`、
  `savedTo` 在家目录内、存档是 `# 标题` + source 行 + 正文）；假 fetch 验 `not-html` / `too-large` / `403 blocked` /
  每分钟第 4 次 `rate-limited`；
- **熔断（C）**：`failStreak=3` 时 digest 出现 `## ⚠ 注意` 且排在 `## 變動` 之前，`failStreak=2` 时整节不出现；
  fallback 第 2 个端成功 ⇒ `failedSources=0`、`failures=0`、`failStreak=0`；两个都失败 ⇒
  原因带「試過 2 個端點」；`fallbacks` 里的 `http://` 被配置校验拒绝；
- 引擎：默认源跑一輪 → digest 三节合计 = 默认源数；**上轮抓成功的源立刻再跑 = 0 新增**（去重没被移植弄坏）；
  所有写入都在家目录内；self-check 11/11；
- **配置所有权（0.1.7）**：`config.json` 17:30 / `sources.json` 09:00 启动后，镜像是 17:30 且 `watch.log`
  有一行 `啟動自癒…`；`_scheduleMirror` 标记在；`scheduleSource` 正确（`config.json` / `defaults`）；
  升级迁移（只有 `sources.json` 17:30）会把值写进 `config.json`；
  `persistCfg` 与 `saveSources` **并发**触发后，`config.json` 与 `sources.json.schedule` 一致且源不丢；
- **P1 CLI 三層**（`web-watch/pull.mjs`，真实子进程跑 `--tick`）：只有 sources 09:00 ⇒ 迁进 `config.json` 并 log；
  再把 sources 改 08:00 ⇒ 仍用 config 的 **09:00**（退役）；两边都没有 ⇒ `defaults`。
  离线 `61/61 ok`；带真网络 `78/78 ok`（原有 57 项不退化）。

正文抽取器另有一个**可离线重跑**的评测（B）：

```powershell
node probe/extract-eval.mjs            # 用 probe/fixtures/ 里的真网页离线跑
node probe/extract-eval.mjs --refresh  # 重新抓 10 条、重写 fixtures
```

它会打印 rawBytes / baseline 字数 / 抽出字数 / ratio / tier / 前 120 字的表，
并对「euobserver + cgtn ≥ 800 字」「arabnews 403 ⇒ blocked」做断言。

---

## 8. 已知限制 / 没把握的地方

1. **设置页的路由**：`/api/web-watch/*` 是用宿主 `ctx.webServer.register({kind:'prefix'})` 注册的 prefix 路由
   —— 跟 bili 的 `/api/bili-duty/*` 完全同一种写法（它的 `client.js` 也是 `fetch('/api/bili-duty/…')`）。
   如果你说的「不要自创 HTTP 端点」是指连这条也不许，那设置页的「源清单增删改」就没有通道可用了
   —— 请告诉我，我改成「只读 + 让模型用工具改」。
2. **插件设置表单是 `ctx.settings.describe()` 扫出来的**，我们靠 `CFG_SIG` 三个键（`startAt/intervalHours/ownerName`）
   认出「哪一行是我们」。如果宿主版本改了 `describe()` 的形状，最坏情况是**设置页只写 `config.json`**
   （页面会显示「DSH 那边没写成」），功能不受影响。
3. **`kind:"html"` 现在走 `extractMain()`**：比起 identity 透传干净很多，但它是启发式的 ——
   没有达到 `full` 时会照实标低信度；遇到靠 JS 渲染的站会判 `shell` 进「抓不到」，
   这时别硬读，换 feed / API 或加 `fallbacks`。抽得准不准可以自己跑 `probe/extract-eval.mjs` 复核。
4. **`role:"index"` 不会自动跟进第二层链接**（定时轮次里仍只报标题 + 链接）；
   要读某一条，显式调 `web_watch_read`（它只读你给的那一条）。
5. **去重完全靠 `index.json`**：删掉它 = 全部重来（这是 P1 就有的行为，故意没加 `--reset` 之外的开关）。
6. **目标会话没醒着就不塞**：`ctx.agents.get(id)` 拿不到就只记日志、下一轮再试（不临时新建会话）。
7. 插件在**宿主进程**里跑：网络请求失败会进「抓不到」，但**磁盘满 / 权限**这类写入异常会冒到工具调用
   （返回错误），不会静默 —— 这一点和 bili 一致。
8. **schedule 只认 `config.json`（0.1.7 的取舍）**：DSH 原生「插件设置」表单如果再改
   `startAt / intervalHours / timezone`，不会写进 `config.json`，因此**不会生效**（会被真值盖过）。
   改时间请用本插件的设置页 / `web_watch_config`，或直接改 `config.json`。
   `sources.json.schedule` 也只是镜像：手改无效，启动自检会覆盖（欄位保留给旧版 P1 CLI）。

---

## 9. 文件结构

```
dsh-web-watch/
  package.json          # 形状对齐 dsh-bili-subagent（type/main/exports/files/engines/peerDependencies/dsh.bundle/dsh.client）
  cordis.patch.yml      # 自带挂载声明：- insert: [{ id: web-watch, name: dsh-web-watch, config: { enabled: true } }]
  lib/
    index.js            # apply(ctx, config)：schema、5 个工具、60 秒 tick、/api/web-watch 路由
    state.mjs           # stateDirOf(ctx) / 家目录铺底 / 默认源 / createWriteQueue / 日志
    hostdeps.mjs        # 从宿主树取 schemastery + defineTool（拿不到就降级，照 bili）
    extract.mjs         # 正文抽取（零依赖；html adapter 与 web_watch_read 共用）
    readpage.mjs        # web_watch_read：限速 / redirect / 大小 / 存档 / 只回摘要
    engine/
      run.mjs           # P1 pull.mjs 的编排流程（runPull / dueSourceIds；fallbacks / failStreak）
      loader.mjs        # 读 sources.json、校驗、補預設（schedule 鏡像標記也在這裏）
      store.mjs         # 快照 / index.json / 清理 / assertInside 边界检查
      digest.mjs        # 三节摘要 + failStreak ≥ 3 的「⚠ 注意」節
      dedupe.mjs        # guid / 正文 sha256 去重
      schedule.mjs      # due 判断与时区工具
      rss.mjs jsonp.mjs html.mjs xml.mjs   # adapter 底层（html.mjs 是 identity 旧版，run.mjs 已改走 extract.mjs）
  client.js             # 设置页（window.__ModuleLoader__.load + slots.register('settings.section')）
  scripts/smoke.mjs     # 无需 DSH 的烟雾测试
  probe/extract-eval.mjs # B 的离线可重跑评测（probe/fixtures/*.html）
  README.md
  CHANGELOG.md
```
