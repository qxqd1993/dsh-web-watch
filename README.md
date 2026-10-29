# dsh-web-watch（蓝色大肥鱼的报箱）

> 把 web-watch 的「抓取 → 去重 → 快照 → 三节摘要」流水线封装成 DSH 插件：
> 按计划自动巡检你订阅的信息源，把变化整理成 digest，并投递到你指定的会话。

| 项目   | 说明                                                                   |
| ---- | -------------------------------------------------------------------- |
| 形态   | DSH 插件，运行在**宿主进程**（非沙盒），60 秒一跳                                       |
| 运行时  | Node.js ≥ 22，零第三方依赖（仅 `node:` 内建模块）                                  |
| 宿主版本 | DSH ≥ `0.1.7-rc.1`                                                   |
| 数据目录 | `%USERPROFILE%\.dsh\web-watch\`（macOS / Linux 为 `~/.dsh/web-watch/`） |
| 当前版本 | `0.2.0`                                                             |
| 许可证  | MIT                                                                  |

---

## 目录

1. [项目简介](#1-项目简介)
2. [功能特性](#2-功能特性)
3. [快速开始](#3-快速开始)
4. [配置](#4-配置)
5. [数据目录](#5-数据目录)
6. [工具接口](#6-工具接口)
7. [安全边界](#7-安全边界)
8. [架构与目录结构](#8-架构与目录结构)
9. [测试与自检](#9-测试与自检)
10. [已知限制](#10-已知限制)
11. [历史沿革](#11-历史沿革)
12. [相关文档](#12-相关文档)
13. [许可证](#13-许可证)

---

## 1. 项目简介

**dsh-web-watch** 把 web-watch 的抓取引擎封装进 DSH 插件体系：抓取 RSS / JSON / HTML、按 GUID 与正文哈希去重、落快照、产出三节 digest，并按时投递到会话。引擎逻辑沿用 P1，只把**家目录（状态目录）改为由宿主上下文决定**；从 CLI 到插件的来历见 [第 11 章](#11-历史沿革)。

因此，插件化的收益是「自动化与交付」，而不是「重写抓取逻辑」：

- **自动巡检**：插件常驻宿主进程，每 60 秒检查一次是否到期，到期即跑一轮；
- **结果直达会话**：摘要以 `followup` 形式投递到指定会话，无需人工轮询；
- **模型可操作**：向模型暴露 5 个工具，覆盖查状态、手动跑、读正文、改配置、维护源清单；
- **可视化配置**：设置页新增「世界邊界擴張器」一节，可开关、改时间、增删改源。

### 设计取舍

- **状态与代码分离**：所有写入只发生在数据目录内，插件包目录运行时不写一个字节（装进 `node_modules` 后可能只读，升级也会被覆盖）。
- **配置单一真值**：调度参数（`startAt` / `intervalHours` / `timezone`）只认 `config.json`，宿主设置页与 `sources.json` 中的副本均为镜像。
- **失败即数据**：网络失败一律落成「抓不到」，不冒泡到定时器或宿主进程；未捕获异常会杀掉整个宿主，这是硬红线。

---

## 2. 功能特性

- **多协议源**：`kind` 支持 `rss` / `json` / `html`；`role` 区分全文源（`full`）与索引源（`index`）。
- **计划调度**：全局 `startAt` + `intervalHours`，每个源可用同名字段覆盖；支持小数小时间隔。
- **可靠去重**：GUID 与正文 SHA-256 双通道，跨轮次不重复计数。
- **三节 digest**：按状态分组呈现（变动、抓不到等），每个源只出现在其中一节；`index` 源只报标题与链接，不伪造正文摘要。
- **源健康与熔断**：记录累计失败 `failures` 与连续失败 `failStreak`；连续失败 ≥ 3 次时 digest 顶部插入 `## ⚠ 注意` 告警节。
- **多端点备援**：每个源可配置最多 5 个 `fallbacks`，主 URL 失败后依序尝试，全部失败才计为失败。
- **单篇精读**：`web_watch_read` 抓取单条链接正文，全文落盘，只向模型回传 ≤ 400 字摘要。
- **正文抽取**：零依赖启发式抽取器，输出 `tier`（`full` / `partial` / `shell` / `blocked`）标明信度，并支持自定义 `strategy`。
- **SSRF 防护**：仅放行公开 `https:443`，覆盖 IP 字面值、DNS 解析结果与逐跳重定向检查。
- **可离线验证**：提供烟雾测试、SSRF 案例表与抽取器评测，无需 DSH 即可复跑。

---

## 3. 快速开始

### 3.1 安装

任选一种方式。安装前请准备插件目录的**绝对路径**（下文以 `link:` 本地挂载为例）。

**方式一：图形界面**

进入 **设置 → 插件 → 安装**，填入：

```text
link:/absolute/path/to/dsh-web-watch
```

**方式二：命令行**

```powershell
dsh plugin --profile desktop add "link:/absolute/path/to/dsh-web-watch"
```

> `link:` 是本地开发用的挂载方式：profile 的 `node_modules` 中会生成一条指向该目录的链接。
> 改完插件代码无需重新安装，但**仍需重启 DSH** 才生效。
> 正式分发时把 `link:` 换成包名或 Git 地址即可，插件本身不必修改。

**方式三：从 Git tag 安装（正式分发用）**

```powershell
dsh plugin --profile desktop add "github:qxqd1993/dsh-web-watch#v0.2.1"
```

`dsh plugin` 会把参数转交给 profile 的 **pnpm**，所以 `github:` 简写能用（需要本机有 `git`）。

> ⚠️ **npm 12 起默认关闭了 git / remote 型依赖**（`allow-git=none`、`allow-remote=none`）。
> 如果你直接用 npm 而不是 pnpm，会遇到 `EALLOWGIT` / `EALLOWREMOTE`。两种解法：
> `npm install --allow-git=all github:qxqd1993/dsh-web-watch#v0.2.1`，或装上 tag 的 tarball：
> `npm install --allow-remote=all https://codeload.github.com/qxqd1993/dsh-web-watch/tar.gz/refs/tags/v0.2.1`。
> （2026-10-29 实测：后者安装成功，`version 0.2.1`，安装后 `smoke --offline` 69/69、`extract-eval` 10/10。）

### 3.2 确认 bundle 已注册

`dsh plugin … add` 只是把参数**原样转交给 profile 目录的 pnpm**（`dsh plugin --help` 原文为 "forwarding the remaining arguments to pnpm"），它只修改 `dependencies`。真正让插件生效的是 profile 的 `dsh.profile.bundles` 中是否存在该包名：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
(Get-Content $p -Raw | ConvertFrom-Json).dsh.profile.bundles
```

若输出中没有 `dsh-web-watch`，请在 `dsh.profile.bundles` 数组末尾手动补一行 `"dsh-web-watch"`。若通过 **设置 → 插件 → 安装** 这条路径安装，通常会一并写入。

### 3.3 重启 DSH

**插件在 bundle 层组装，不重启不生效。** `dsh.bundle.patch` 声明的 `cordis.patch.yml` 只在启动时叠入配置树，运行期间不会重新读取。

### 3.4 安装后自检

重启后依次确认三件事：

1. **设置 → 插件** 中多出「蓝色大肥鱼的报箱」，点开能看到默认源；
2. 对模型说「看下 web-watch 状态」，模型会调用 `web_watch_status`；
3. 数据目录出现 `sources.json`、`index.json`、`pages/`、`out/`、`watch.log`；若保存过设置或执行过启动迁移，还会有 `config.json`（调度的真值）。

### 3.5 卸载

```powershell
dsh plugin --profile desktop remove dsh-web-watch
dsh plugin --profile desktop install      # 或在 profile 目录执行 pnpm install
```

随后**重启 DSH**。

- 卸载只删除代码，**不删除设置与历史**：数据目录原样保留（`sources.json`、`index.json`、快照、digest 都在），重新安装后可接着用，历史不会被当成新内容重跑。
- 如需彻底清理，删除整个数据目录即可。注意：**删除 `index.json` 会让所有源重新按首次抓取处理**；快照仍会按 90 天 / 200 份的规则逐步淘汰。

### 3.6 常见安装问题

| 现象                                                                                                       | 处理                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 启动日志出现 `warning: 1 entry did not activate`                                                               | 查看 `watch.log` 末尾。插件对 `@deepseek-ai/schemastery` 做了降级：拿不到时只是没有 `Config`、DSH 原生设置页不写，本体照常运行 |
| DSH 提示 `The application could not start`，伴随 `Unexpected token '…'`（引号内为不可见的 BOM 字符）/ `is not valid JSON` | 与本插件无关：profile 的 `package.json` 被保存为 **UTF-8 with BOM**，去除 BOM 即可                          |

---

## 4. 配置

### 4.1 设置页字段

入口：**设置 → 插件 → 世界邊界擴張器**，或左侧导航同名项。

| 字段               | 说明                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **总开关**          | 关闭后定时器不再动作；工具与「立即跑一輪」仍可用                                                                                                                                                             |
| **每天第一窗（HH:MM）** | 本地时间；调度唯一真值为 `config.json`                                                                                                                                                           |
| **间隔（小时，可小数）**   | 例如 `24`、`6`、`0.5`；上限 720 小时                                                                                                                                                          |
| **目标会话 id**      | 每轮结束后把摘要送入该会话；**留空表示不主动投递**。会话未唤醒时仅记日志，下一轮重试。设置页会尽力显示最近会话的标题（读取 DSH 内部存储，读不到则退回显示 id）                                                                                                |
| **怎么称呼你**        | digest 消息中的称呼                                                                                                                                                                        |
| **源清单**          | 每条包含 `id` / `kind`（`rss`、`json`、`html`）/ `role`（`full`、`index`）/ `url` / `maxItems`；`kind=json` 时额外展开 `path`（必填）与 `idPath` / `titlePath` / `linkPath` / `bodyPath` / `datePath`，支持增删 |
| 按钮               | **保存** / **重新載入** / **立即跑一輪** / **看最新 digest**                                                                                                                                       |

### 4.2 校验规则

设置页与宿主后端各执行一道校验，规则同一套；不通过时红字提示，**不写任何文件**：

- `url` 必须为 `https://`，不接受 `http://`，不接受内含账号密码的 URL；
- `kind` ∈ `{rss, json, html}`，`role` ∈ `{full, index}`；
- `id` 只能是小写英文字母、数字与 `-`，且全表唯一；
- `startAt` 必须符合 `HH:MM`（`00:00`–`23:59`）；
- `intervalHours` 必须 `> 0`，且不超过 720；
- `kind=json` 必须填写 `path`。

配置写入复用宿主既有通道：`ctx.settings.update(ns, patch, revision)` 加插件自身的 `config.json`。

### 4.3 配置所有权

`schedule` 只有一个归属地：`config.json`。

- 修改 `startAt` / `intervalHours` / `timezone` 后，值会**镜像写入** `sources.json`，供旧版 P1 CLI 与人工查看；
- `sources.json.schedule` 是 **deprecated 兼容镜像**（带 `_scheduleMirror` 标记），**不是真值**，手改无效；
- 插件在「保存配置」与「启动自检」时用有效 schedule 覆盖该镜像；
- `config.json` 与 `sources.json` 的写入走**同一条串行队列**，避免同一次操作中出现两文件时间漂移。

> **不要为了兼容旧版删除该字段**——旧 P1 CLI 仍在读取它（缘由见 [第 11 章](#11-历史沿革)）。

---

## 5. 数据目录

所有状态位于 `%USERPROFILE%\.dsh\web-watch\`（macOS / Linux：`~/.dsh/web-watch/`）。

| 路径                              | 用途                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sources.json`                  | **源清单的唯一入口**（设置页修改的就是它，也可手工编辑）。其中 `schedule` 仅为兼容镜像                                                          |
| `index.json`                    | 去重与健康度数据（`seenIds` / `seenHashes` / `failures` / `failStreak` / `lastOkAt` / `lastStatus` 等）。**只由程序写入**，请勿手改 |
| `pages/<host>/<id>-<hash8>.txt` | 每轮快照（UTF-8，无 BOM），保留 90 天或最多 200 份                                                                           |
| `pages/read/<host>-<hash8>.txt` | `web_watch_read` 抓取的单篇正文，遵循同一套清理规则                                                                           |
| `out/<YYYY-MM-DDTHH-mm>.md`     | 每轮一份三节 digest；同一分钟内重跑追加 `-2`、`-3`，不覆盖已有证据                                                                    |
| `watch.log`                     | 插件自有日志，宿主 logger 之外另留一份，便于排查                                                                                 |
| `config.json`                   | 插件配置；`schedule`（`startAt` / `intervalHours` / `timezone`）**唯一真值**。宿主设置页中的副本仅作镜像，不参与判定                        |

写入边界由 `store.mjs` 的 `assertInside()` 保证：每次写 / 删前以绝对路径检查，越界直接抛错。

### 5.1 `sources.json` 示例

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

各字段行为约定：

- **`role: "index"`**：只当索引使用。digest 会标注「只有摘要（无全文）」，且**不打印「前 200 字」**——索引源抓到的 body 通常是站点自我介绍，而非当期内容。
- **`kind: "html"`**：走 `lib/extract.mjs` 的正文抽取。`tier` 不是 `full` 时，digest 标注「低信度（正文抽取 tier=…）」；抽不到正文归入「抓不到」，不会把导航文本当作正文。
- **`fallbacks`**：可选，最多 5 条，同样只接受 `https` 且不得带账号密码。主 URL 失败时依序尝试，全部失败才记 `failed`，失败原因注明「試過 N 個端點」；任一备援成功即视为本轮成功（`failures=0`、`failStreak=0`）。示例中的 `rss.xml` 仅为占位，**请填写真实可用的备援端点**。

### 5.2 到期判定

- 全局 `schedule` 以 `config.json` 为准，`sources.json.schedule` 不参与判定；
- 每个源可用同名 `intervalHours` / `startAt` 覆盖全局值；
- 下一窗口 = `lastOkAt + intervalHours` 对齐到 `startAt` 之后的首个窗口；
- 从未成功过的源立即到期；同一分钟内重跑必定 `not-due`。

### 5.3 源健康与熔断

`index.json` 中：

- `failures`：累计失败次数，成功归零；
- `failStreak`：**连续**失败次数，成功归零，失败 +1。

任一源 `failStreak ≥ 3` 时，digest 顶部（标题之下、`## 變動` 之前）插入告警节：

```markdown
## ⚠ 注意
- dead-source 连续失败 3 次（HTTP 403）—— 要考虑换端点或删掉
```

未达阈值时整节不出现，不留空标题。更换端点可使用 `fallbacks`，或直接修改 `url`。

---

## 6. 工具接口

插件向模型注册 5 个工具。以下签名中 `?` 表示可选参数。

### `web_watch_status`

```text
web_watch_status  {}
```

不发起网络请求，纯读本地状态，返回：

- 插件是否启用、下次到期时间；
- 每个源的 `failures` / `failStreak` / `lastStatus`；
- 最新 digest 的位置、上一次自动运行的结果；
- `scheduleSource`：调度时间真值的来源（`config.json` 或 `defaults`）。

### `web_watch_pull`

```text
web_watch_pull  { source?: "steam-news", dryRun?: true }
```

手动执行一轮，返回新增条数、未变化源数、失败源数、前 3 条标题与链接、digest 路径及 self-check 结果。

- `dryRun: true` 表示只抓取、不落盘（不写 `index`、快照与 digest）。

### `web_watch_read`

```text
web_watch_read  { url: "https://…", source?: "euobserver" }
```

读取**单条**链接正文：抓取 HTML → 抽取正文 → 全文存入 `pages/read/`，仅返回：

```json
{ "ok": true, "url": "…", "title": "…", "chars": 0, "ratio": 0, "tier": "full", "excerpt": "…", "savedTo": "…" }
```

- `excerpt` 不超过 400 字，**全文不进模型上下文**；
- 失败返回 `{ ok:false, code, reason }`，`code` ∈ `blocked` / `unreachable` / `not-html` / `too-large` / `rate-limited` / `unsafe-url`；
- 硬限制：仅 `https`、仅公开地址、一次一条、超时 15 秒、单文件 ≤ 5MB、重定向 ≤ 5 跳（逐跳检查）、同主机请求间隔 ≥ 1 秒、每分钟最多 3 次；
- `source` 可选，仅用于校验该 id 是否存在于源清单，不改变抓取行为与文件名。

### `web_watch_config`

```text
web_watch_config  { patch?: { enabled, startAt, intervalHours, targetSession, ownerName } }
```

- 不传 `patch` 即读取当前配置；
- 传入则修改并立即持久化（`config.json` + 宿主设置 + 镜像 `sources.json`）；
- 非法值会被拒绝，返回 `{ ok: false, error: "…" }`。

### `web_watch_sources`

```text
web_watch_sources  { action?: "list" | "add" | "update" | "remove", source?, id? }
```

- `list`（默认）：源清单与健康度；
- `add` / `update`：携带完整 source 对象，`update` 时 `id` 必须已存在，可带 `fallbacks`；
- `remove`：携带 `id`，至少保留一条源。

### 典型用法

| 对话                    | 调用                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 「看下 web-watch 现在怎么样」  | `web_watch_status`                                                                                               |
| 「手动跑一轮，只跑 steam-news」 | `web_watch_pull { source: "steam-news" }`                                                                        |
| 「改成每 6 小时跑一次」         | `web_watch_config { patch: { intervalHours: 6 } }`                                                               |
| 「加一条 HN 的源」           | `web_watch_sources { action: "add", source: { id: "hn-best", kind: "rss", url: "https://hnrss.org/best" } }`     |
| 「这篇 latimes 文章讲了什么」   | `web_watch_read { url: "https://www.latimes.com/…", source: "latimes-world" }`，只得到 400 字摘要，全文在 `pages/read/…txt` |

---

## 7. 安全边界

### 7.1 抓取红线

以下限制对定时抓源与 `web_watch_read` 同时生效，插件化没有放宽任何一条。

- **不执行页面 JavaScript**：只有 HTTP 客户端（`fetch`），无渲染器，无 `eval` / `new Function` / `vm` / `child_process`；
- **单轮预算**：≤ 30 次请求、≤ 20MB、同主机间隔 ≥ 1 秒（见 `lib/engine/run.mjs` 的 `LIMITS`）；
- **单篇读取上限**：仅 `https`、单次 1 个 URL、超时 15 秒、单文件 ≤ 5MB、重定向 ≤ 5 跳、同主机间隔 ≥ 1 秒、每分钟最多 3 次（内存计数，超限明确返回 `rate-limited`）；
- **不绕过 Cloudflare / 验证码 / 登录墙 / 付费墙**：此类站点归入「抓不到」，或由 `web_watch_read` 返回 `blocked`，绝不伪装成「今天没有新闻」；
- **不爬第二层**：索引源只输出标题与链接，读取具体条目必须显式调用 `web_watch_read`；
- **抓取内容一律视为数据**，永不解析为指令（提示注入防线）；
- **网络失败降级为数据**：统一记为「抓不到」`{ reason, failures+1, failStreak+1 }`，不向定时器或宿主抛出。定时器回调整体包在 `try/catch` 中——未捕获异常会杀掉宿主进程。

### 7.2 SSRF 防护

插件运行在宿主进程，`fetch` 具备完整网络权限。没有这一层时，一条被投毒的 feed 或一句「帮我读这个链接」，就能把云厂商 metadata、`10.0.0.5`、`127.0.0.1:8443` 这类内网地址的内容拉进 digest，而 digest 会进入模型上下文。这正是 SSRF。当前默认拒绝：

- 仅接受 `https:`，端口必须是 **443**（或省略），URL 不得包含账号密码；
- **IP 字面值直接判定**，以下一律拒绝：
  - loopback：`127.0.0.0/8`、`::1`
  - link-local：`169.254.0.0/16`、`fe80::/10`（含各云厂商 metadata 地址）
  - 私有地址：`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`
  - `0.0.0.0`、CGNAT `100.64/10`（含阿里云 metadata）
  - 组播 / 保留段：`224/4`、`240/4`、`ff00::/8`
  - 文档用段：`192.0.2/24`、`198.51.100/24`、`203.0.113/24`、`2001:db8::/32`
  - IPv4-mapped / NAT64 中内嵌的私有 IPv4（如 `::ffff:127.0.0.1`）
  - 内嵌 IPv4 的隧道段：6to4 `2002::/16`、Teredo `2001:0::/32`、benchmarking `2001:2::/48`、discard `100::/64`、local-use NAT64 `64:ff9b:1::/48`
- 主机名为 `localhost`，或以 `.local` / `.internal` / `.localhost` 结尾 → 拒绝（带结尾点的 `localhost.` 同样拦截）；
- 其余主机名通过 `dns.lookup(host, { all: true })` 解析全部 A / AAAA 记录，任一条落在上述网段即拒绝（防「公开域名指向内网」）；解析失败或超过 5 秒 → `dns-failed`；
- **重定向逐跳检查**：`web_watch_read` 与定时抓源均自行处理重定向（`redirect: 'manual'`，≤ 5 跳），每一跳重新判定，因此「公开 URL → 302 内网」在**发出请求前**即被拦截；最后再核对一次 `response.url` 的 host；
- **判定结果不缓存**，避免把「上次解析为公开」带入请求路径、拉长 rebinding 窗口。

三个入口全部必经，而非只拦工具层：

| 入口                      | 文件                      | 行为                                                                                                            |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `web_watch_read`        | `lib/readpage.mjs`      | 抓取前、每跳重定向、最终 `response.url` 均检查；命中返回 `{ ok:false, code:"unsafe-url" }`                                        |
| 定时抓源 / `web_watch_pull` | `lib/engine/run.mjs`    | 主 URL 与**每一个** `fallbacks` 均检查；不合格则跳过该端点，`failure.code = "unsafe-url"`，照常累计 `failures` / `failStreak`；重定向逐跳检查 |
| 源清单校验                   | `lib/engine/loader.mjs` | `normalizeSource` 直接拒绝私有 / 本机**字面值**（含 `fallbacks`）。此处**故意不解析 DNS**：配置校验不能变成阻塞的网络请求，域名部分留到抓取时处理               |

失败码 `unsafe-url` 只表示「目标不安全」；`http://`、非法 URL、解析失败仍返回 `unreachable`，与既有语义保持一致。

### 7.3 残余风险（本版有意不做）

1. **DNS rebinding**：校验时解析的地址与 `fetch` 实际连接的地址是两次独立解析，中间可能被替换（TTL=0 的域名可以「第一次答公开、第二次答 `127.0.0.1`」）。正解是 **pinned-IP**：解析一次后用该 IP 建立连接、SNI / `Host` 保持不变（需改用 `node:https` 加自定义 `lookup`，或自建连接池后校验 `socket.remoteAddress`），还要处理 TLS 校验与 IPv6，工程量另计。
2. **判定与连接之间的时间窗**：同上，是同一问题的另一面；不缓存只能缩小窗口，不能消除。
3. **缺少出口防火墙 / 网络层限制**：插件在宿主进程内运行，最后一道防线应在网络层（VPC / 安全组 / egress 白名单）。本层只是应用层第一道闸。
4. **协议与端口固定为 https:443**：使用 `:8080` 的自建 feed 会被拒绝——这是**有意**的取舍，以少开一个洞。

> 本版定位是「挡住误配置与低成本的 SSRF」，而非「对抗能控制 DNS 的对手」。

---

## 8. 架构与目录结构

```
dsh-web-watch/
  .github/workflows/ci.yml  # GitHub Actions：windows-latest + Node 22（smoke --offline、SSRF 案例表、抽取器评测）
  package.json              # 形状对齐 dsh-bili-subagent（type/main/exports/files/engines/peerDependencies/dsh.bundle/dsh.client）
  cordis.patch.yml          # 自带挂载声明：- insert: [{ id: web-watch, name: dsh-web-watch, config: { enabled: true } }]
  LICENSE                   # MIT
  lib/
    index.js                # apply(ctx, config)：schema、5 个工具、60 秒 tick、/api/web-watch 路由
    state.mjs               # stateDirOf(ctx) / 家目录铺底 / 默认源 / createWriteQueue / 日志
    sessions.mjs            # 设置页「最新会话」标题：读 projcache，读不到退回 id（尽力而为，内部格式非契约）
    hostdeps.mjs            # 从宿主树取 schemastery 与 defineTool（取不到则降级，与 bili 一致）
    extract.mjs             # 正文抽取（零依赖；html adapter 与 web_watch_read 共用）
    readpage.mjs            # web_watch_read：限速 / 逐跳 redirect + SSRF / 大小 / 存档 / 只回摘要
    safeurl.mjs             # SSRF 第一层：只放行公开 https（形状 + IP 字面值 + DNS 全量 A/AAAA；零依赖）
    engine/
      run.mjs               # P1 流程编排（runPull / dueSourceIds；fallbacks / failStreak / SSRF）
      loader.mjs            # 读取 sources.json、校验、补默认值（schedule 镜像标记 + 配置阶段 SSRF 字面值检查）
      store.mjs             # 快照 / index.json / 清理 / assertInside 边界检查
      digest.mjs            # 三节摘要 + failStreak ≥ 3 的「⚠ 注意」节
      dedupe.mjs            # guid / 正文 sha256 去重
      schedule.mjs          # due 判断与时区工具
      rss.mjs jsonp.mjs html.mjs xml.mjs  # adapter 底层（html.mjs 为 identity 旧版，run.mjs 已改走 extract.mjs）
  client.js                 # 设置页（window.__ModuleLoader__.load + slots.register('settings.section')）
  docs/extract.md           # 正文抽取器契约（输入/输出、tier 门槛、strategy、稳定度承诺）
  scripts/smoke.mjs         # 无需 DSH 的烟雾测试（含 SSRF 端到端 3 条 + 引擎端 3 条 + strategy 3 条）
  probe/extract-eval.mjs    # 抽取器离线可重跑评测（probe/fixtures/*.html）
  probe/extract-strategy.mjs # strategy 扩展点的可执行契约（注入 + 非法策略降级）
  probe/safeurl-cases.mjs   # SSRF 案例表（注入 resolve，零真 DNS；smoke --offline 复用同一份）
  probe/verify-index-digest.mjs # 断言 role=index 不印「前 200 字」（离线，不随包发布）
  README.md
  CHANGELOG.md
```

### 模块职责

| 层次    | 模块                                      | 说明                        |
| ----- | --------------------------------------- | ------------------------- |
| 宿主接入  | `lib/index.js`、`client.js`              | 注册工具、定时器、设置页路由与 UI        |
| 状态与存储 | `lib/state.mjs`、`engine/store.mjs`      | 数据目录、写入队列、快照与清理、越界检查      |
| 会话元数据 | `lib/sessions.mjs`                      | 从 DSH 内部存储读会话标题，失败静默退回 id |
| 抓取    | `engine/run.mjs`、`loader.mjs`、各 adapter | 调度、端点遍历、协议解析              |
| 安全    | `lib/safeurl.mjs`、`readpage.mjs`        | URL 白名单判定、限速、逐跳校验         |
| 呈现    | `engine/digest.mjs`、`engine/dedupe.mjs` | 三节摘要、去重                   |

---

## 9. 测试与自检

以下命令**不需要 DSH** 即可运行。

```powershell
# 1) 语法检查：每个 .js / .mjs 都需通过
Get-ChildItem -Recurse -File -Include *.js,*.mjs | ForEach-Object { node --check $_.FullName }

# 2) 假 ctx 载入插件 + 设置页通道 + 引擎真跑两轮（含真实网络，约 20–60 秒）
node scripts/smoke.mjs

# 仅运行不触碰网络的部分
node scripts/smoke.mjs --offline
```

仓库自带 GitHub Actions（`.github/workflows/ci.yml`）：windows-latest + Node 22，依次运行 `scripts/smoke.mjs --offline`、`probe/safeurl-cases.mjs`、`probe/extract-eval.mjs`。

`scripts/smoke.mjs` 覆盖的范围：

- **装载**：`apply(ctx, config)` 不抛错，注册出 5 个工具，`name === "web-watch"`，`Config` 的期望与宿主是否提供 schemastery 一致（有则必须有，无则必须无）；
- **初始化**：数据目录铺好 `sources.json`，默认源齐全，`schedule` 默认 `24h / 09:00 / Asia/Macau`；
- **定时器**：`tick` 以 60 秒注册，手动触发不抛错（通过预置 `index.json` 使其 `not-due`，以避开网络）；
- **设置页通道**：`GET/POST /api/web-watch/*` 能读、能存、能读回；`http://`、`kind=nope`、`startAt=25:00`、`intervalHours=0` 全部被拒；向 `POST /sources` 提交内网 URL 会被拒且**不写入** `sources.json`；
- **`web_watch_read`**：拒绝 `http://`、非法 URL、不存在的 URL（`unreachable`）、不存在的 `source`；真实网络读取一条 euobserver（`tier=full`、`chars > 800`），返回 JSON 仅含摘要（`excerpt ≤ 400`、`savedTo` 位于数据目录内、存档格式为 `# 标题` + source 行 + 正文）；以假 fetch 验证 `not-html` / `too-large` / `403 blocked` / 每分钟第 4 次 `rate-limited`；
- **SSRF**：`probe/safeurl-cases.mjs` 的 36 条案例表（`http://`、账号密码、非 443 端口、`127.0.0.1`、`[::1]`、`169.254.169.254`、`10.x`、`172.20.x`、`192.168.x`、`0.0.0.0`、`localhost`、`foo.local`、公开域名解析到公开 IP、公开域名解析到 `192.168.1.1`、解析失败、十进制与十六进制写法的 `127.0.0.1`、`::ffff:` 包装、6to4 / Teredo / NAT64 隧道段、对照组等）全部符合预期；端到端三条：`web_watch_read` 对 `https://169.254.169.254/…` 与 `https://127.0.0.1/` 返回 `unsafe-url` **且未发出任何请求**、源配置包含私有 / `localhost` / 内网 `fallbacks` 时被 `ConfigError` 拒绝、假 fetch 模拟 `302 → 169.254.169.254` 时仅发出 1 个请求即被拦截；引擎侧：私有源产生 `failure.code="unsafe-url"` 且 `failStreak=1`、零请求，`302` 到内网只发 1 个请求，不安全主 URL 配合安全 fallback 时可切换端点成功；
- **熔断**：`failStreak=3` 时 digest 出现 `## ⚠ 注意` 且排在 `## 變動` 之前，`failStreak=2` 时该节不出现；fallback 第 2 个端点成功则 `failedSources=0`、`failures=0`、`failStreak=0`；两个端点均失败时原因含「試過 2 個端點」；`fallbacks` 中的 `http://` 被配置校验拒绝；
- **正文抽取 strategy**：自定义策略可改变 `text`；非法策略（非函数、抛错、形状不符）安全降级为 `tier:'shell'` 且不向调用方抛错；不传 strategy 时使用默认算法；
- **引擎**：默认源跑一轮后，三节合计等于默认源数；上轮成功的源立刻重跑为 0 新增（去重未被移植破坏）；所有写入位于数据目录内；self-check 11/11；
- **配置所有权**：`config.json` 为 17:30、`sources.json` 为 09:00 时启动后镜像是 17:30，且 `watch.log` 有一行 `啟動自癒…`；`_scheduleMirror` 标记存在；`scheduleSource` 判定正确（`config.json` / `defaults`）；升级迁移（仅 `sources.json` 为 17:30）会把值写入 `config.json`；`persistCfg` 与 `saveSources` **并发**触发后，`config.json` 与 `sources.json.schedule` 一致且源不丢失；
- **P1 CLI 三层**（`web-watch/pull.mjs`，真实子进程运行 `--tick`）：仅有 sources 09:00 时迁入 `config.json` 并记录日志；将 sources 改为 08:00 后仍使用 config 的 **09:00**；两边都没有时使用 `defaults`。

最近一次离线结果为 `76/76`（`0.1.10`）；仓库检出布局（无同级 `web-watch/`）为 `69/69`（7 项 P1 CLI 测试跳过）。带真实网络的部分本版未重跑。各版本的口径与数字变化见第 11 章「测试基线演变」。

### 专项探针

```powershell
node probe/safeurl-cases.mjs   # SSRF 案例表：不打真实 DNS、不访问外网，打印 URL / 期望 / 实际 / 原因
node probe/extract-eval.mjs    # 抽取器评测：使用 probe/fixtures/ 中的真实网页离线运行
node probe/extract-eval.mjs --refresh  # 重新抓取 10 条并重写 fixtures
node probe/extract-strategy.mjs        # 验证 strategy 注入生效、非法策略安全降级为 shell
node probe/verify-index-digest.mjs     # 断言 role=index 不印「前 200 字」、full 仍印（不随包发布）
```

`extract-eval.mjs` 会打印 rawBytes、基线字数、抽出字数、ratio、tier 与前 120 字，并断言「euobserver + cgtn ≥ 800 字」「arabnews 403 ⇒ blocked」。

### 独立使用抽取器

第三方项目可单独引用正文抽取器：

```js
import { extractMain } from 'dsh-web-watch/extract'
```

返回 `{ ok, title, text, chars, ratio, tier, reason }`，其中 `tier` ∈ `blocked` / `shell` / `partial` / `full`。契约详见 `docs/extract.md`。更换算法或调整阈值前，请先跑 `probe/extract-eval.mjs` 的 10 条 fixtures，确保真实网页字数不退化。

---

## 10. 已知限制

1. **依赖宿主 HTTP 路由**：设置页使用宿主 `ctx.webServer.register({ kind:'prefix' })` 注册 `/api/web-watch/*` 前缀路由，与既有 `bili` 的 `/api/bili-duty/*` 写法一致。若项目规范禁止新增 HTTP 端点，可退化为「只读页面 + 由模型通过工具修改」。
2. **设置表单依赖 `describe()` 形状**：插件通过 `CFG_SIG` 三个键（`startAt` / `intervalHours` / `ownerName`）识别自己的配置行。宿主版本若改变 `describe()` 返回结构，最坏情况是**设置页只写 `config.json`**（页面会提示「DSH 那边没写成」），功能不受影响。
3. **`kind:"html"` 为启发式抽取**：相比 identity 透传更干净，但并非精确解析。未达到 `full` 时如实标注低信度；依赖 JS 渲染的站点会判为 `shell` 并归入「抓不到」。此时应改用 feed / API 或增加 `fallbacks`，而非强行读取。抽取质量可用 `probe/extract-eval.mjs` 复核。
4. **`role:"index"` 不自动跟进第二层**：定时轮次仍只报标题与链接；读取具体条目需显式调用 `web_watch_read`。
5. **去重完全依赖 `index.json`**：删除即全部重来，这是既有行为，未额外增加开关。
6. **目标会话未唤醒时不投递**：`ctx.agents.get(id)` 取不到会话时仅记日志，下一轮重试，不临时新建会话。
7. **宿主进程内的写入异常会冒泡**：网络失败会转为「抓不到」，但磁盘满、权限不足这类写入异常会以错误形式返回给工具调用，不会静默，行为与 `bili` 一致。
8. **调度只认 `config.json`**：DSH 原生「插件设置」表单修改 `startAt` / `intervalHours` / `timezone` 不会生效；`sources.json.schedule` 手改也无效，启动自检会覆盖。改时间请使用本插件设置页、`web_watch_config`，或直接编辑 `config.json`（兼容缘由见 11.4）。
9. **SSRF 仅覆盖第一层**：私有 / loopback / link-local / `.local` 及「公开域名解析到内网」均已拦截，但 DNS rebinding 与判定/连接之间的时间窗尚未解决（正解为 pinned-IP）。定位是「挡住误配置与低成本 SSRF」，详见 [7.3 残余风险](#73-残余风险本版有意不做)。

---

## 11. 历史沿革

> 本章回答「为什么是现在这样」。正文各章描述当前行为；逐条变更与验证记录见 `CHANGELOG.md`。

### 11.1 起源：从 P1 CLI 到插件

web-watch P1 是一个 Node CLI：抓 feed / JSON / HTML、按 GUID 与正文哈希去重、落快照、产出三节 digest。`0.1.0`（2026-10-24）把它包成 DSH 插件：`lib/engine/*` 原样搬入，只把存储根目录换成插件家目录、去掉对 `process.cwd()` 的依赖，`assertInside()` 边界检查保留；`pull.mjs` 的 CLI 入口不搬，编排抽成 `runPull()`。

首版有 4 个工具（`web_watch_status` / `web_watch_pull` / `web_watch_config` / `web_watch_sources`）、60 秒 tick、设置页，以及三条默认源（`cgtn-world` / `tech-weekly-index` / `steam-news`）。`web_watch_read` 是 `0.1.5` 随正文抽取器一起加的，工具数此时才变成 5。`euobserver` 等源是后续手工添加的，不属于首次运行自动铺设的默认值。

### 11.2 关键决策与事故

**配置双家 → 单一真值（0.1.7）**。2026-10-25 21:27 的一次保存把「每天第一窗」改成 17:30，`config.json` 与 `sources.json` 各走一条写入路径；其中一条读到旧值，结果前者 17:30、后者仍是 09:00，两个文件的 mtime 却停在同一秒。根因不是算错，是配置有两个家。修法是让 `schedule` 只认 `config.json`，`sources.json.schedule` 降级为带 `_scheduleMirror` 的兼容镜像，并为旧配置加启动迁移与自愈；两个文件的写入合并到同一条串行队列。

**SSRF 缺口与对抗性补洞（0.1.9）**。插件在宿主进程内，`fetch` 有完整网络权限，而此前接受任意 https URL。`0.1.9` 新增 `lib/safeurl.mjs`，在 `readpage` / `run` / `loader` 三个入口统一拦截。首版案例表 30 条全绿，但拿外部清单对抗时发现 6to4（`2002::/16`）与 Teredo（`2001:0::/32`）两类「内嵌 IPv4 的隧道段」没挡——它们能经中继把请求带进内网；补上 6to4 / Teredo / benchmarking / discard / local-use NAT64 后，案例表变成 36 条。教训是「自己的测试全绿」不等于「清单完整」。

**正文抽取器契约化（0.1.10）**。`0.1.5` 起 `kind:"html"` 走 `extractMain()`，`0.1.6` 补 `trimBoilerplate` 清理正文头尾的图注、署名与推荐位。`0.1.10` 没有改算法，而是把 `extractMain` 写成有契约的小库（`docs/extract.md`：输入输出、`tier` 门槛、`ok` 语义、稳定度承诺），加了一行式 `strategy` 扩展点与 `dsh-web-watch/extract` 子路径导出；非法策略在边界降级为 `shell`，不抛给调用方。没有拆独立包，理由是当前只有一个消费者，缺的是契约而不是包边界。

**CI 在干净检出上必红（0.1.8）**。两处环境假设：硬断言「必须导出 Config」（schemastery 是可选的），以及 P1 CLI 测试假设插件旁边有 `web-watch/` 目录。改为与插件同一套探测逻辑、找不到就跳过；产品行为未变。

### 11.3 版本时间线

| 版本       | 日期         | 要点                                                           |
| -------- | ---------- | ------------------------------------------------------------ |
| `0.1.0`  | 2026-10-24 | 首个插件版本：4 个工具、60 秒 tick、设置页、三条默认源、引擎移植                        |
| `0.1.1`  | 2026-10-24 | 修正 dry-run 自检输出（`undefined/undefined`）                       |
| `0.1.2`  | 2026-10-25 | 修正设置页两行 label 被压成竖条                                          |
| `0.1.3`  | 2026-10-25 | digest 不再给 `role:"index"` 源印「前 200 字」                        |
| `0.1.4`  | 2026-10-25 | 设置页显示最新会话标题（读 projcache，尽力而为）                                |
| `0.1.5`  | 2026-10-25 | 新增正文抽取器、`web_watch_read`（第 5 个工具）、`failStreak` 与 `fallbacks` |
| `0.1.6`  | 2026-10-25 | 抽取器清除正文头尾杂质（`trimBoilerplate`）                               |
| `0.1.7`  | 2026-10-26 | 调度单一真值、`_scheduleMirror` 镜像、写入串行化、启动迁移与自愈                    |
| `0.1.8`  | 2026-10-27 | 仅修测试与 CI 的干净检出问题，无产品行为变更                                     |
| `0.1.9`  | 2026-10-27 | SSRF 第一层、`unsafe-url`、逐跳重定向检查；案例表 30 → 36                    |
| `0.1.10` | 2026-10-28 | 抽取器契约、`strategy` 扩展点、`/extract` 导出                           |

### 11.4 兼容与迁移

- `sources.json.schedule` 保留至今，是因为旧 P1 CLI 仍读它；插件在保存配置与启动自检时覆盖它，所以手改无效（正文见 4.3 节）。
- P1 CLI 的调度优先级有三层：`config.json` → `sources.json.schedule`（命中即一次性迁入 `config.json` 并记日志）→ `DEFAULT_SCHEDULE`。迁移后即使再改 sources 也不再生效。
- 启动自愈：有效 schedule 与镜像不一致时重写镜像，并在 `watch.log` 记一行 `啟動自癒…`；若 `config.json` 还没有 schedule 键而 sources 带了非默认值，则先迁移、再自愈。

### 11.5 测试基线演变

| 版本       | 离线    | 仓库检出布局 | 带真网络  |
| -------- | ----- | ------ | ----- |
| `0.1.7`  | 61/61 | —      | 78/78 |
| `0.1.8`  | 61/61 | 54/54  | —     |
| `0.1.9`  | 73/73 | 66/66  | 90/90 |
| `0.1.10` | 76/76 | 69/69  | 未重跑   |

口径变化：`0.1.9` 给既有测试注入假 resolver，不再依赖真实 DNS；`0.1.10` 新增 strategy 3 项。当前怎么跑、覆盖什么，见第 9 章。

> 完整历史见 `CHANGELOG.md`。

---

## 12. 相关文档

- `docs/extract.md`：正文抽取器契约（输入输出、`tier` 阈值、`strategy`、稳定度承诺）
- `CHANGELOG.md`：逐版本变更记录
- `README.md`：仓库现行的简版说明；其中部分数字早于 `0.1.10`，以本文件为准
- `probe/`：可直接运行的验证与评测脚本

---

## 13. 许可证

本项目以 **MIT** 许可证发布，详见仓库根目录的 `LICENSE`。
