/**
 * dsh-web-watch —— host 半端
 * ============================================================================
 * 它是什么：把 P1 那个跑通的 web-watch（Node CLI：抓 feed / JSON、去重、落快照、
 * 產出三節 digest）包成 DSH 插件。
 *
 *   1. **工具**（5 個）：web_watch_status / web_watch_pull / web_watch_read / web_watch_config / web_watch_sources
 *   2. **定时器**：每 60 秒一跳，到期（schedule.startAt + intervalHours）就跑一輪；
 *      跑完把摘要 followup 進 targetSession（留空 = 不主動塞訊息）
 *   3. **设置页**（client.js）：改開關 / 時間 / 間隔 / 目標會話 / 稱呼 / 源清單
 *   4. **家目录**（`<DSH_HOME>\web-watch\`）：config.json（schedule 唯一真值）/ sources.json（源清单 +
 *      deprecated schedule 镜像）/ index.json / pages/ / out/ / watch.log
 *
 * ⚠️ 三条纪律（全部照 dsh-bili-subagent 踩出来的）：
 *   ① `apply(ctx, config)` 传进来的 config，字段值**不保证是标量** ⇒ 逐字段按默认值的类型挑一遍，
 *      再叠自己的 config.json（见 DEFAULTS / normalize）；
 *   ② **定时器回呼里绝不让异常外冒** —— 未捕获异常会杀掉整个宿主进程（见 tick 的 try/catch）；
 *   ③ 工具返回值一律过 `safe()`：宿主只吃「无损 JSON」，塞函数/循环引用会报
 *      `value is not lossless JSON`。
 * ============================================================================
 */
import { loadHostDeps } from './hostdeps.mjs';

// 这两样从**宿主那棵树**里取（拿不到就退到裸 import；再拿不到，defineTool 用本地等价实现）。
// 起因见 lib/hostdeps.mjs 顶栏：optional peer 在桌面版 profile 永远不会被装，
// 裸 import 会让整条插件不激活。
const hostDeps = await loadHostDeps();
const z = hostDeps.z;
const defineTool = hostDeps.defineTool;

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_SCHEDULE,
  appendLog,
  createWriteQueue,
  ensureHome,
  homePaths,
  latestDigest,
  readJson,
  stateDirOf,
  writeJson,
} from './state.mjs';
import {
  ConfigError,
  SCHEDULE_MIRROR_NOTE,
  buildConfigDoc,
  normalizeSchedule,
  normalizeSources,
  toRawSource,
} from './engine/loader.mjs';
import { LIMITS, dueSourceIds, runPull } from './engine/run.mjs';
import { assertTimeZone, evaluateDue, formatLocalStamp, formatZonedIso, parseStartAt } from './engine/schedule.mjs';
import { getSourceState, readIndex } from './engine/store.mjs';
import { READ_LIMITS, readPage } from './readpage.mjs';
import { mergeSessionMeta, readSessionMeta } from './sessions.mjs';

export const name = 'web-watch';

// ⚠️ 只留真的会用到的服务：拿不到某个就不注册对应那一块（bili 那份也是这么列的）
export const inject = ['webServer', 'tools', 'settings', 'agents'];

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。另外两个条件是：
 *    **loader entry 的 id 必须等于命名空间名**（我们 patch 里就是 `web-watch`）+ **本模块导出 Config**。
 * ⚠️ 字段上故意不写 `.min()/.max()` 这类会拒收的约束：schema 校验不过 ⇒ cordis 拒收这条 entry
 *    ⇒ **整条插件不激活** ✗。范围一律在 checkPatch() 里钳（写和读两头都过）。
 */
export const Config = !z
  ? undefined
  : z.object({
      /** 总开关：关掉就只有手动跑，定时器不动作 */
      enabled: z.boolean().default(true).extra('volatile', true),
      /** 每天第一窗的开始时间（HH:MM，本地时间 = timezone） */
      startAt: z.string().default(DEFAULT_SCHEDULE.startAt).extra('volatile', true),
      /** 两轮之间隔几小时（可小数，例如 0.5 = 半小时） */
      intervalHours: z.number().default(DEFAULT_SCHEDULE.intervalHours).extra('volatile', true),
      /** 时区（IANA，例如 Asia/Macau） */
      timezone: z.string().default(DEFAULT_SCHEDULE.timezone).extra('volatile', true),
      /** 跑完把摘要塞进哪个会话（留空 = 不主动塞訊息） */
      targetSession: z.string().default('').extra('volatile', true),
      /** 主人的称呼（digest 訊息里用得到） */
      ownerName: z.string().default('你').extra('volatile', true),
    });

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  let myVer = '';
  const myVersion = () => {
    if (myVer) return myVer;
    try {
      myVer = String(JSON.parse(readFileSync(join(pluginDir, '..', 'package.json'), 'utf8')).version || '');
    } catch {
      myVer = '';
    }
    return myVer;
  };

  const stateDir = stateDirOf(ctx);
  const paths = homePaths(stateDir);
  ensureHome(stateDir);

  const log = (msg) => {
    appendLog(stateDir, msg);
    try {
      ctx.logger?.info?.(`[web-watch] ${msg}`);
    } catch {
      /* 没有 logger 就算了 */
    }
  };

  // 宿主依赖是从哪儿取的（排查「为什么设置页降级了」看 watch.log 这一行）
  for (const note of hostDeps.notes) log(note);

  /**
   * ⚠️ 2026-10-14 bili 那次事故的教训，照抄（见 bili index.js:209-218）：
   *   `apply(ctx, config)` 里那个 config，字段值**不保证是标量** —— 对象也是「真值」，
   *   `if (!cfg.enabled)` 这类守卫会失效，一路走到字符串方法上抛 TypeError；
   *   而如果那是在**定时器回调**里，没人接 ⇒ 整个 dsh 进程被带走。
   *   ⇒ ① 逐字段按默认值的类型挑一遍；② tick 里 try/catch 兜死。
   */
  const DEFAULTS = {
    enabled: true,
    startAt: DEFAULT_SCHEDULE.startAt,
    intervalHours: DEFAULT_SCHEDULE.intervalHours,
    timezone: DEFAULT_SCHEDULE.timezone,
    targetSession: '',
    ownerName: '你',
  };

  const normalize = (src, base) => {
    const out = { ...base };
    for (const key of Object.keys(base)) {
      const value = src?.[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(base[key])) {
        if (Array.isArray(value)) out[key] = value.filter((item) => typeof item === 'string');
      } else if (typeof base[key] === 'number') {
        const n = Number(value);
        if (Number.isFinite(n)) out[key] = n;
      } else if (typeof base[key] === 'boolean') {
        if (typeof value === 'boolean') out[key] = value;
      } else if (typeof base[key] === 'string') {
        if (typeof value === 'string') out[key] = value;
      }
    }
    return out;
  };

  /**
   * 讀 sources.json（同步的 —— apply 裏不能 await）。壞掉就回 {error}，不拋。
   * ⚠️ 0.1.7：`schedule` 只是**兼容鏡像（deprecated）**，這裏**不再校驗它**，壞了也不擋任何事；
   *    真值只從 config.json 來（見 loadCfg / effectiveSchedule）。鏡像原樣帶出，啟動自癒用。
   */
  const readDoc = () => {
    const raw = readJson(paths.sources, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { doc: null, mirror: null, marker: null, error: `讀不到或讀不懂 ${paths.sources}` };
    }
    try {
      if (raw.version !== 1) throw new ConfigError(`sources.json version 必須是 1（收到 ${String(raw.version)}）`);
      return {
        doc: { version: 1, sources: normalizeSources(raw.sources) },
        mirror:
          raw.schedule && typeof raw.schedule === 'object' && !Array.isArray(raw.schedule) ? raw.schedule : null,
        marker: typeof raw._scheduleMirror === 'string' ? raw._scheduleMirror : null,
        error: null,
      };
    } catch (e) {
      return { doc: null, mirror: null, marker: null, error: String(e?.message ?? e) };
    }
  };

  const cfgFile = paths.config;

  /**
   * 我们那一行设置表单（拿不到就返回 null ⇒ 一切按 config.json / sources.json 来）。
   * ⚠️ DSH 自带的「插件设置」页**不需要注册** —— describe() 自己扫 profile 里**带 volatile 字段**的条目；
   *    命名空间 ns **等于 loader 条目的 id**（我们 patch 里是 `web-watch`）。
   * 另外两条（读宿主源码得来的，别想当然）：
   *    ① `apply(ctx, config)` 收到的 config 就是 fiber.config 本体，volatile 字段一改宿主**就地**改它
   *       ⇒ 启动时快照的 cfg 永远看不到设置页的改动，用之前得 refreshCfg()；
   *    ② describe() 每行给三层：value（生效值）/ base（继承层）/ user（用户显式设过的那层）。
   */
  const CFG_SIG = ['startAt', 'intervalHours', 'ownerName'];
  let settingsRow = { at: 0, row: null };
  const settingsDesc = (fresh = false) => {
    const t = Date.now();
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row; // 挡 UI 轮询
    let row = null;
    try {
      const rows = ctx.settings?.describe?.() || [];
      row = rows.find((item) => item?.value && CFG_SIG.every((key) => key in item.value)) || null;
    } catch (e) {
      log(`讀 DSH 設置表單失敗（不影響跑）：${e?.message ?? e}`);
    }
    settingsRow = { at: t, row };
    return row;
  };

  /**
   * 配置从哪来（0.1.7 起「一个值只有一个家」）：
   *   **schedule（startAt / intervalHours / timezone）只认插件自己的 config.json + 内置 DEFAULT_SCHEDULE**；
   *   `sources.json.schedule` 已退役成兼容镜像，**永远不参与判断**（哪怕手改了也一样，启动自检会覆盖）。
   *   其余非排程设置（enabled / targetSession / ownerName）仍尊重 DSH 原生表单里用户显式设过的值。
   *
   * 为什么不再从 sources.json 取基线：0.1.6 的「保存」会同时走两条路（config.json + sources.json），
   * 两条路各读一份 cfg；一旦一条读到旧值，就会出现 config 17:30 / sources 09:00 的漂移。
   * 现在只有一个真值 + 一条写入队列（writeQueue），镜像只是「写出去的结果」。
   */
  const SCHEDULE_KEYS = Object.freeze(['startAt', 'intervalHours', 'timezone']);
  const NON_SCHEDULE_KEYS = Object.freeze(['enabled', 'targetSession', 'ownerName']);

  /** 原樣讀 config.json（只為了判斷「這個鍵有沒有被顯式寫過」）。讀不懂就當沒有。 */
  const cfgRaw = () => {
    const raw = readJson(cfgFile, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  };
  const hasScheduleKeys = (raw) =>
    SCHEDULE_KEYS.some((key) => raw?.[key] !== undefined && raw?.[key] !== null);

  /** schedule 的來源：config.json（至少寫過一個 schedule 鍵）或 defaults。status / 設置頁會回報。 */
  const scheduleSource = () => (hasScheduleKeys(cfgRaw()) ? 'config.json' : 'defaults');

  /** 有效 schedule（引擎要的那三欄）。 */
  const effectiveSchedule = () => ({
    intervalHours: cfg.intervalHours,
    startAt: cfg.startAt,
    timezone: cfg.timezone,
  });

  /** 從一個 cfg 快照取 schedule（寫入隊列裏用，保證「寫哪份 cfg 就鏡像哪份」）。 */
  const scheduleOf = (value) => ({
    intervalHours: value.intervalHours,
    startAt: value.startAt,
    timezone: value.timezone,
  });

  /** 兩份 schedule 是否等值（鏡像比對用；容忍 number / string 差異）。 */
  const sameSchedule = (a, b) =>
    Boolean(a) &&
    typeof a === 'object' &&
    a.startAt === b.startAt &&
    Number(a.intervalHours) === Number(b.intervalHours) &&
    a.timezone === b.timezone;

  const loadCfg = () => {
    // schedule 只从 config.json 叠到 DEFAULTS 上；sources.json 连基线都不当。
    const out = normalize(cfgRaw(), { ...DEFAULTS });
    const row = settingsDesc();
    if (!row) return out;
    const user = row.user || {};
    const fromHost = normalize(row.value, out);
    for (const key of NON_SCHEDULE_KEYS) if (user[key] !== undefined) out[key] = fromHost[key];
    return out;
  };

  const cfg = loadCfg();
  const refreshCfg = () => {
    Object.assign(cfg, loadCfg());
  };

  /**
   * ⭐ 所有会动 config.json / sources.json 的「读 + 写」都排进这一条队列（0.1.7）。
   *    队列里才读 cfg、才落盘，保证不会出现「一边读到旧值」的交错。
   */
  const writeQueue = createWriteQueue();

  /**
   * **写入口**的校驗：不合格就抛 ConfigError（设置页会显示、工具会回 ok:false），
   * 绝不「钳一下继续」—— 钳是读路径的事（loadCfg 的 normalize），写路径必须说实话。
   */
  const checkPatch = (patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ConfigError('patch 必須是物件');
    }
    const out = {};
    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') throw new ConfigError('enabled 必須是 true / false');
      out.enabled = patch.enabled;
    }
    if ('startAt' in patch) {
      try {
        out.startAt = parseStartAt(String(patch.startAt ?? ''));
      } catch (e) {
        throw new ConfigError(e.message);
      }
    }
    if ('intervalHours' in patch) {
      const n = Number(patch.intervalHours);
      if (!Number.isFinite(n) || n <= 0) throw new ConfigError('intervalHours 必須是 > 0 的數字（可小數）');
      if (n > 24 * 30) throw new ConfigError('intervalHours 太大（上限 720 小時）');
      out.intervalHours = n;
    }
    if ('timezone' in patch) {
      try {
        out.timezone = assertTimeZone(String(patch.timezone ?? ''));
      } catch (e) {
        throw new ConfigError(e.message);
      }
    }
    if ('targetSession' in patch) {
      if (typeof patch.targetSession !== 'string') throw new ConfigError('targetSession 必須是會話 id 字串（留空＝不塞訊息）');
      out.targetSession = patch.targetSession.trim();
    }
    if ('ownerName' in patch) {
      if (typeof patch.ownerName !== 'string' || patch.ownerName.trim() === '') {
        throw new ConfigError('ownerName 必須是非空字串');
      }
      out.ownerName = patch.ownerName.trim();
    }
    return out;
  };

  /**
   * ⭐ 同时写一份到宿主：不写的话会出现死结 —— 某个键一旦在原生设置页设过就由宿主说了算，
   *    插件页再改那个键就成了"改了没反应"。写失败不算致命（config.json 那份还在），把话带回给用户。
   *    （照 bili index.js:363-380）
   */
  const saveCfgHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh);
      if (!row?.ns || typeof ctx.settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 這邊沒有可寫的設置表單（值只落在插件自己的 config.json 裏）'), {
          noForm: true,
        });
      }
      await ctx.settings.update(row.ns, patch, row.revision);
      return row.ns;
    };
    try {
      return { ok: true, ns: await attempt(false) };
    } catch (e) {
      if (!e?.noForm) {
        try {
          return { ok: true, ns: await attempt(true), retried: true };
        } catch (e2) {
          e = e2;
        }
      }
      log(`寫 DSH 設置失敗：${e?.message ?? e}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  };

  /**
   * 把 schedule **镜像**进 sources.json —— 这是 **deprecated 兼容镜像**：
   *   - 只给 P1 CLI（旧版）与人工查看；
   *   - 真值永远是 config.json；手改这里会被下一次保存 / 启动自愈覆盖；
   *   - **只能在 writeQueue 里调用**（调用方保证），跟 saveSources / persistCfg 串行。
   */
  const mirrorSchedule = (schedule, snapshot = null) => {
    const current = snapshot || readDoc();
    if (!current.doc) {
      // 讀不懂就别覆盖 —— 手改坏了的 sources.json 也不該被我們悄悄换成默认三条
      log(`不鏡像 schedule：${current.error}`);
      return { ok: false, error: current.error || '讀不到 sources.json' };
    }
    try {
      const next = buildConfigDoc({ schedule, sources: current.doc.sources.map(toRawSource) });
      writeJson(paths.sources, next, stateDir);
      return { ok: true, file: paths.sources };
    } catch (e) {
      log(`寫 sources.json 的 schedule 失敗：${e?.message ?? e}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  };

  /**
   * ⭐ 落配置的**唯一入口**：插件自己那份 config.json + DSH 原生设置页那份，
   *    校验完一起写；schedule 有变就镜像进 sources.json（见 bili 的 persistCfg）。
   * ⚠️ 0.1.7：config.json + 镜像的「读 → 写」整段排进 writeQueue；镜像用的 schedule
   *    必须来自**同一次要写下去的 cfg 快照**，否则并发时会写出「config 17:30 / sources 09:00」。
   */
  const persistCfg = async (patch) => {
    const clean = checkPatch(patch);
    Object.assign(cfg, clean);
    const needsMirror = SCHEDULE_KEYS.some((key) => key in clean);
    const written = await writeQueue.enqueue(() => {
      const snapshot = { ...cfg };
      try {
        writeJson(cfgFile, snapshot, stateDir);
      } catch (e) {
        log(`寫 config.json 失敗：${e?.message ?? e}`);
        // config.json 沒寫成就不鏡像：鏡像必須跟真值一致，不能寫出「真值舊、鏡像新」
        return { mirrored: null, writeError: String(e?.message ?? e) };
      }
      let mirrored = null;
      if (needsMirror) mirrored = mirrorSchedule(scheduleOf(snapshot));
      return { mirrored, writeError: null };
    });
    const host = await saveCfgHost(clean);
    return { clean, host, mirrored: written.mirrored, writeError: written.writeError };
  };

  /**
   * 校驗 + 寫源清單（設置頁 / 工具都走這條）。
   * ⚠️ 0.1.7：排進 writeQueue，且 schedule 在隊列**執行時**才從 cfg 取 —— 不會讀到舊 cfg。
   */
  const saveSources = async (rawSources) => {
    return writeQueue.enqueue(() => {
      const schedule = scheduleOf(cfg);
      const doc = buildConfigDoc({ schedule, sources: rawSources });
      writeJson(paths.sources, doc, stateDir);
      // 寫回的精靈：把 null 欄位去掉後再讀一次，確認能讀回來
      const check = readDoc();
      if (check.error) throw new ConfigError(`寫進去了但讀不回來：${check.error}`);
      log(`sources.json 已更新（${doc.sources.length} 條源；schedule 鏡像 ${schedule.startAt}）`);
      return check.doc;
    });
  };

  const docOrThrow = () => {
    const { doc, error } = readDoc();
    if (!doc) throw new ConfigError(error || '讀不到 sources.json');
    return doc;
  };

  /**
   * 啟動自檢（排進同一條寫入隊列）：
   *   ① **一次性遷移**：config.json 裏還沒有任何 schedule 鍵、而 sources.json 帶了非預設值時，
   *      把舊值接進 config.json（只為了升級時不丟設定；接完就以 config.json 為準）。
   *   ② **鏡像自癒**：`sources.json.schedule` 跟有效 schedule 不一致就重寫，並記一行
   *      `啟動自癒：sources.json.schedule 09:00 → 17:30（真值 config.json）`。
   * apply 不能 await，所以這裏只排隊；測試 / 卸載要等落地就用 apply 回傳的 whenIdle()。
   */
  const startupSync = writeQueue.enqueue(() => {
    const { doc, mirror, marker, error } = readDoc();
    if (!doc) {
      log(`啟動自檢：略過 schedule 鏡像（${error}）`);
      return { migrated: false, healed: false, error };
    }

    if (!hasScheduleKeys(cfgRaw()) && mirror && !sameSchedule(mirror, DEFAULT_SCHEDULE)) {
      try {
        const old = normalizeSchedule(mirror, 'sources.json schedule');
        const nextCfg = { ...cfg, ...old };
        writeJson(cfgFile, nextCfg, stateDir);
        Object.assign(cfg, nextCfg);
        log(`遷移：sources.json.schedule → config.json（${old.startAt} / ${old.intervalHours}h / ${old.timezone}，一次性）`);
        return { migrated: true, healed: false };
      } catch (e) {
        log(`遷移 schedule 失敗（繼續用預設）：${e?.message ?? e}`);
      }
    }

    const want = effectiveSchedule();
    if (sameSchedule(mirror, want)) {
      // 值沒漂，但舊檔沒有 deprecated 標記：補一次，讓手改的人一眼看得出來
      if (marker === SCHEDULE_MIRROR_NOTE) return { migrated: false, healed: false };
      const tagged = mirrorSchedule(want, { doc });
      if (tagged.ok) log('啟動自檢：sources.json.schedule 與真值一致，補上 _scheduleMirror 標記');
      return { migrated: false, healed: false, tagged: tagged.ok };
    }
    const oldAt = typeof mirror?.startAt === 'string' && mirror.startAt ? mirror.startAt : '(缺失)';
    const result = mirrorSchedule(want, { doc });
    if (result.ok) {
      log(`啟動自癒：sources.json.schedule ${oldAt} → ${want.startAt}（真值 config.json）`);
      return { migrated: false, healed: true };
    }
    return { migrated: false, healed: false, error: result.error };
  });
  startupSync.catch((e) => log(`啟動自檢出錯（已兜住）：${e?.stack ?? e}`));

  /* ───────────────────────── 工具 ───────────────────────── */

  /** 上一次自动跑的结果（给 status 用）。 */
  let lastRun = null;
  /** 正在跑（防重入：定时器 60 秒一跳，一輪可能跑几十秒）。 */
  let pulling = false;

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };

  /** 工具返回值一律过一遍这里：宿主只吃「无损 JSON」（bili 2026-10-14 撞过）。 */
  const safe = (value) => {
    if (
      value === undefined ||
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  };

  const tool = (spec) =>
    ctx.tools.register(
      defineTool({
        ...spec,
        output: textOutput,
        async execute(args, exec) {
          return safe(await spec.execute(args || {}, exec));
        },
      }),
    );

  /** 每個源的健康度（工具 / 設置頁共用）。 */
  const healthOf = async (sources, schedule) => {
    const now = new Date();
    let index = { version: 1, updatedAt: null, sources: {} };
    try {
      index = await readIndex(stateDir);
    } catch (e) {
      log(`讀 index.json 失敗：${e?.message ?? e}`);
    }
    const rows = [];
    for (const source of sources) {
      const state = getSourceState(index, source.id);
      let due = { due: true, reason: 'never-run', nextAt: null };
      try {
        due = evaluateDue({ source, state, schedule, now });
      } catch (e) {
        due = { due: false, reason: `無法判斷due：${e?.message ?? e}`, nextAt: null };
      }
      rows.push({
        id: source.id,
        kind: source.kind,
        role: source.role,
        url: source.url,
        maxItems: source.maxItems,
        intervalHours: source.intervalHours ?? null,
        startAt: source.startAt ?? null,
        failures: state.failures,
        failStreak: state.failStreak,
        lastStatus: state.lastStatus,
        lastOkAt: state.lastOkAt,
        lastRunAt: state.lastRunAt,
        lastCount: state.lastCount,
        due: due.due,
        dueReason: due.reason,
        nextAt: due.nextAt ? due.nextAt.toISOString() : null,
        nextAtLocal: due.nextAt ? formatZonedIso(due.nextAt, schedule.timezone) : null,
      });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
  };

  /** 摘要（工具/HTTP 共用；别把整包 results 丢给模型，里面是全文）。 */
  const summarize = (summary) => ({
    ok: true,
    dryRun: Boolean(summary.dryRun),
    ran: summary.ran,
    counts: summary.counts,
    top: summary.top,
    unchanged: summary.unchanged,
    failed: summary.failed,
    digest: summary.digestName,
    digestPath: summary.digestPath,
    cleanup: summary.cleanup,
    requests: summary.requests,
    bytes: summary.bytes,
    checks: summary.dryRun
      ? 'dry-run（不寫檔，自檢略過）'
      : summary.checks
        ? `${summary.checksOk}/${summary.checksTotal} ok`
        : undefined,
  });

  /* ── 1) 狀態 ── */
  tool({
    name: 'web_watch_status',
    description:
      '看「世界邊界擴張器」(web-watch) 現在怎麼樣：開沒開、下次什麼時候到期、每個源的 failures / lastStatus、最新 digest 在哪。\n'
      + 'scheduleSource 說明時間的真值從哪來（config.json / defaults）。\n'
      + '不跑網路，純讀狀態。',
    parameters: {},
    async execute() {
      refreshCfg();
      const { doc, error } = readDoc();
      const schedule = effectiveSchedule();
      const sources = doc ? doc.sources : [];
      return {
        ok: true,
        enabled: cfg.enabled,
        version: myVersion(),
        home: stateDir,
        schedule,
        scheduleSource: scheduleSource(),
        sourcesCount: sources.length,
        sourcesError: error || null,
        health: sources.length ? await healthOf(sources, schedule) : [],
        lastDigest: latestDigest(stateDir),
        pulling,
        lastRun: lastRun ? { at: lastRun.at, digest: lastRun.digest, counts: lastRun.counts } : null,
        log: paths.log,
        limits: LIMITS,
        hint: '手動跑一輪用 web_watch_pull；只讀單篇正文用 web_watch_read（只回摘要、全文落檔）；改配置用 web_watch_config；源清單見 web_watch_sources',
      };
    },
  });

  /* ── 2) 手動跑一輪 ── */
  tool({
    name: 'web_watch_pull',
    description:
      '手動跑一輪 web-watch（抓 feed / JSON → 去重 → 落快照 → 出 digest）。\n'
      + '回傳摘要：新增幾條 / 沒變幾源 / 抓不到幾源 + 前 3 條標題與連結 + digest 路徑。\n'
      + 'powerUser：`source` 只跑指定的源；`dryRun` 只抓不寫檔（印將要寫什麼）。',
    parameters: {
      source: { type: 'string', description: '只跑這個源 id（省略 = 全部；可用源見 web_watch_sources）' },
      dryRun: { type: 'boolean', description: 'true = 只抓不寫檔（不寫 index / 快照 / digest）' },
    },
    async execute(args) {
      refreshCfg();
      const dryRun = args?.dryRun === true || args?.dryRun === 'true';
      try {
        const doc = docOrThrow();
        const only = String(args?.source ?? '').trim() ? [String(args.source).trim()] : [];
        const summary = await runPull({
          homeDir: stateDir,
          sources: doc.sources,
          schedule: effectiveSchedule(),
          only,
          dryRun,
          log,
        });
        if (!summary.dryRun) {
          lastRun = { at: summary.at, digest: summary.digestName, counts: summary.counts };
        }
        log(`手動跑一輪：變動 ${summary.counts.newEntries} 條 / 沒變 ${summary.counts.unchangedSources} 源 / 抓不到 ${summary.counts.failedSources} 源`);
        return summarize(summary);
      } catch (e) {
        if (e instanceof ConfigError) return { ok: false, error: e.message };
        throw e;
      }
    },
  });

  /* ── 3) 讀單篇正文（只回摘要，全文落檔） ── */
  tool({
    name: 'web_watch_read',
    description:
      '讀**一條**連結的正文（例如索引源指到的那篇）：抓 HTML → 抽正文 → 全文存到家目錄，'
      + '**只回摘要**（excerpt 最多 400 字），不把全文丟給模型。\n'
      + '回傳 `{ok, url, title, chars, ratio, tier, excerpt, savedTo}`；失敗回 `{ok:false, code, reason}`，'
      + 'code ∈ blocked / unreachable / not-html / too-large / rate-limited。\n'
      + `硬限制：只收 https、timeout ${READ_LIMITS.timeoutMs / 1000}s、單檔 ≤ ${READ_LIMITS.maxBytes / 1024 / 1024}MB、`
      + `redirect ≤ ${READ_LIMITS.maxRedirects}、同 host 間隔 ≥ ${READ_LIMITS.minHostGapMs}ms、每分鐘最多 ${READ_LIMITS.perMinute} 次。`,
    parameters: {
      url: { type: 'string', description: '要讀的 https 連結（一次一條）' },
      source: { type: 'string', description: '可選：這條連結屬於哪個源 id（只做校驗，不影響抓取）' },
    },
    async execute(args) {
      refreshCfg();
      const url = String(args?.url ?? '').trim();
      if (!url) return { ok: false, url: '', code: 'unreachable', reason: 'url 是必填的（一次一條 https 連結）' };
      const wantedSource = String(args?.source ?? '').trim();
      if (wantedSource) {
        try {
          const doc = docOrThrow();
          if (!doc.sources.some((item) => item.id === wantedSource)) {
            return { ok: false, url, code: 'unreachable', reason: `source ${wantedSource} 不在源清單裡（見 web_watch_sources）` };
          }
        } catch (e) {
          if (e instanceof ConfigError) return { ok: false, url, code: 'unreachable', reason: e.message };
          throw e;
        }
      }
      const result = await readPage({ root: stateDir, url });
      log(
        result.ok
          ? `讀一條：${result.tier} ${result.chars} 字 → ${result.savedTo}`
          : `讀一條失敗：${result.code} ${result.reason}（${url}）`,
      );
      return result;
    },
  });

  /* ── 4) 配置 ── */
  tool({
    name: 'web_watch_config',
    description:
      '讀 / 改「世界邊界擴張器」的設置。不給 `patch` 就是讀；給了就改（只認這幾個欄位，改完立刻持久化）。\n'
      + '例：`{"enabled":true,"startAt":"09:00","intervalHours":24,"targetSession":"","ownerName":"你"}`。\n'
      + '⚠️ 不合格的值（startAt 不是 HH:MM、intervalHours ≤ 0、url 不是 https…）會被拒絕並說明原因，不會寫進去。',
    parameters: {
      patch: { type: 'object', additionalProperties: true, description: '要改的欄位（可省）' },
    },
    async execute(args) {
      let host = null;
      let mirrored = null;
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        try {
          const saved = await persistCfg(args.patch);
          host = saved.host;
          mirrored = saved.mirrored;
        } catch (e) {
          if (e instanceof ConfigError) return { ok: false, error: e.message };
          throw e;
        }
      } else {
        refreshCfg();
      }
      return {
        ok: true,
        config: cfg,
        schedule: effectiveSchedule(),
        scheduleSource: scheduleSource(),
        home: stateDir,
        configFile: paths.config,
        sourcesFile: paths.sources,
        host,
        mirroredSchedule: mirrored,
      };
    },
  });

  /* ── 5) 源清單 ── */
  tool({
    name: 'web_watch_sources',
    description:
      '列出源清單與健康度（failures / lastStatus / 下次到期）。\n'
      + '也可以改：`action:"add"` / `"update"`（带 source 物件，update 时 id 必须已存在）、`action:"remove"`（只带 id）。\n'
      + '源物件形狀：`{id,kind,role,url,maxItems}`；kind=json 另需 `path`（另有 titlePath/linkPath/bodyPath/datePath/idPath）；'
      + '可選 `fallbacks:[https URL…]`（主 URL 失敗時依序試，最多 5 條）。',
    parameters: {
      action: { type: 'string', description: 'list（默认）/ add / update / remove' },
      source: { type: 'object', additionalProperties: true, description: 'action=add/update 时的源物件' },
      id: { type: 'string', description: 'action=remove 时的源 id' },
    },
    async execute(args) {
      refreshCfg();
      const schedule = effectiveSchedule();
      try {
        return await runSourcesAction(args, schedule);
      } catch (e) {
        if (e instanceof ConfigError) return { ok: false, error: e.message };
        throw e;
      }
    },
  });

  async function runSourcesAction(args, schedule) {
      const doc = docOrThrow();
      const action = String(args?.action || 'list').toLowerCase();
      if (action === 'list') {
        return {
          ok: true,
          home: stateDir,
          file: paths.sources,
          count: doc.sources.length,
          schedule,
          sources: doc.sources.map(toRawSource),
          health: await healthOf(doc.sources, schedule),
        };
      }
      if (action === 'add' || action === 'update') {
        if (!args?.source || typeof args.source !== 'object' || Array.isArray(args.source)) {
          return { ok: false, error: 'action=add/update 需要 source 物件' };
        }
        const normalized = normalizeSources([args.source])[0];
        const list = doc.sources.slice();
        const at = list.findIndex((item) => item.id === normalized.id);
        if (action === 'add') {
          if (at >= 0) return { ok: false, error: `源 ${normalized.id} 已存在（要用 update）` };
          list.push(normalized);
        } else if (at < 0) {
          return { ok: false, error: `源 ${normalized.id} 不存在（要用 add）` };
        } else {
          list[at] = normalized;
        }
        const saved = await saveSources(list);
        return { ok: true, action, sources: saved.sources.map(toRawSource), health: await healthOf(saved.sources, schedule) };
      }
      if (action === 'remove') {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: 'action=remove 需要 id' };
        const list = doc.sources.filter((item) => item.id !== id);
        if (list.length === doc.sources.length) return { ok: false, error: `源 ${id} 不存在` };
        if (list.length === 0) return { ok: false, error: '至少要留一个源（sources 不能空）' };
        const saved = await saveSources(list);
        return { ok: true, action, removed: id, sources: saved.sources.map(toRawSource) };
      }
      return { ok: false, error: `不认识的 action：${action}（list / add / update / remove）` };
  }

  /* ─────────────── 跑一轮 + 定时器 ─────────────── */

  /**
   * 往会话里塞一句话（照 bili index.js:1332-1377 的 triggerFeiyuScan）。
   * ⚠️ 只做「塞訊息」这一件事：找不到会话就记一笔日志、返回 false，**不临时新建会话**
   *    （bili 会建一个，那是它刷 B 站的需要；web-watch 没这个必要，少动一次会话列表）。
   */
  const notifySession = async (text) => {
    const target = String(cfg.targetSession || '').trim();
    if (!target) return { ok: false, reason: 'targetSession 留空（不主動塞訊息）' };
    if (!text) return { ok: false, reason: '沒有內容' };
    let agent = null;
    try {
      agent = ctx.agents?.get?.(target);
    } catch {
      /* 拿不到就往下找 */
    }
    if (!agent) {
      const list = (() => {
        try {
          return ctx.agents?.list?.() || [];
        } catch {
          return [];
        }
      })();
      agent = list.find((item) => String(item?.session?.id ?? item?.id ?? '') === target) || null;
    }
    if (!agent) return { ok: false, reason: `目標會話現在沒醒着（先去那儿说句话）：${target.slice(0, 24)}…` };
    if (typeof agent.followup !== 'function') return { ok: false, reason: '目標會話沒有 followup（版本不合？）' };
    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'web-watch-digest' },
    };
    try {
      await agent.followup(msg);
      log(`已把這一輪摘要塞進會話 ${target.slice(0, 24)}…`);
      return { ok: true, session: target };
    } catch (e) {
      log(`塞訊息失敗：${e?.message ?? e}`);
      return { ok: false, reason: String(e?.message ?? e) };
    }
  };

  /** 給人看的一段摘要（tick 塞進會話的就是它）。 */
  const messageFor = (summary) => {
    const owner = String(cfg.ownerName || '你');
    const lines = [
      `【web-watch】${formatLocalStamp(new Date(summary.at), summary.timezone)} 這一輪跑完了（${owner} 的世界邊界擴張器）。`,
      `變動 ${summary.counts.newEntries} 條 / 沒變 ${summary.counts.unchangedSources} 源 / 抓不到 ${summary.counts.failedSources} 源`,
    ];
    for (const item of summary.top) lines.push(`· [${item.source}] ${item.title} —— ${item.link}`);
    if (summary.failed.length) {
      lines.push(`抓不到的：${summary.failed.map((item) => `${item.id}（${item.reason}，累計 ${item.failures} 次）`).join('、')}`);
    }
    if (summary.digestName) lines.push(`digest：${summary.digestPath}`);
    lines.push('（这是后台定时跑的，不用你回；要改就改设置页「世界邊界擴張器」。）');
    return lines.join('\n');
  };

  /**
   * 定時器的一跳：**里面绝不让异常外冒**（未捕获异常会杀掉宿主进程）。
   * 到期才跑；跑完按 targetSession 塞訊息。
   */
  const tick = async () => {
    try {
      refreshCfg();
      if (!cfg.enabled) return { ran: false, reason: 'disabled' };
      if (pulling) return { ran: false, reason: 'busy' };
      const { doc, error } = readDoc();
      if (!doc) {
        log(`定時器：${error}`);
        return { ran: false, reason: 'config-error' };
      }
      const schedule = effectiveSchedule();
      const now = new Date();
      const plan = await dueSourceIds({ homeDir: stateDir, sources: doc.sources, schedule, now });
      if (plan.due.length === 0) return { ran: false, reason: 'not-due', skipped: plan.skipped };

      pulling = true;
      let summary = null;
      try {
        summary = await runPull({
          homeDir: stateDir,
          sources: doc.sources,
          schedule,
          only: plan.due,
          now,
          log,
          skippedCount: plan.skipped.length,
        });
        lastRun = { at: summary.at, digest: summary.digestName, counts: summary.counts };
        log(
          `定時器跑完：變動 ${summary.counts.newEntries} 條 / 沒變 ${summary.counts.unchangedSources} 源 / 抓不到 ${summary.counts.failedSources} 源`,
        );
      } finally {
        pulling = false;
      }
      const delivered = await notifySession(messageFor(summary));
      return { ran: true, summary: summarize(summary), delivered };
    } catch (e) {
      try {
        log(`定時器這一跳出錯（已兜住，不影響宿主）：${e?.stack ?? e}`);
      } catch {
        /* 连日志都写不进去也只能算了 */
      }
      return { ran: false, reason: 'error' };
    }
  };

  try {
    const timer = setInterval(
      () =>
        // ⚠️ 这里**必须**把 Promise 交出去（隐式返回）：回调返回的 Promise 要是 reject 了，
        //    除了 Node 的 unhandledRejection 没人接 —— 而 tick 内部已经兜了 try/catch，
        //    外面这一层是最后的保险丝，顺带让 smoke 能 await 一次跳（测起来不用等 60 秒）。
        tick().catch((e) => {
          try {
            log(`定時器（外層）${e?.message ?? e}`);
          } catch {
            /* 兜底 */
          }
        }),
      60_000,
    );
    timer.unref?.(); // 别因为这个定时器让进程不肯退出
    ctx.effect(() => () => clearInterval(timer), 'web-watch: 60 秒定時器');
  } catch (e) {
    log(`定時器沒起來：${e?.message ?? e}`);
  }

  /* ─────────────── HTTP（设置页用） ───────────────
   * 照 bili 的写法：自己注册一条 prefix 路由（`/api/bili-duty/*` → 我们 `/api/web-watch/*`），
   * 页面的每一次读写都走宿主后端：读 → 现读 sources.json / index.json；写 → persistCfg / saveSources。
   * **没有另建 web server、没有新的鉴权方式**：同一台宿主、同一个 webServer.register。
   */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      let done = false;
      // ⚠️ 超过 1MB 得**先把 Promise 收掉**再掐断：只 destroy 的话它永远不 settle（照 bili）
      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) {
          data = '';
          finish({});
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          finish(JSON.parse(data || '{}'));
        } catch {
          finish({});
        }
      });
      req.on('error', () => finish({}));
    });

  /** 会话列表（设置页「目标会话」下拉用；拿不到就给空，页面可以手填 id）。
   *  ⭐ 2026-10-25：宿主 `ctx.agents.list()` 的会话对象**不带 title**，所以以前只能把 id
   *     印两次。标题其实在 projcache 里 —— 见 lib/sessions.mjs（盡力而為，讀不到就留空）。 */
  const listSessions = () => {
    try {
      const list = ctx.agents?.list?.() || [];
      const meta = readSessionMeta(dirname(stateDir));
      return mergeSessionMeta(list, meta);
    } catch {
      return [];
    }
  };

  /** 设置页要的全貌（一次给齐：配置、默认值、源、健康度、最近一轮）。 */
  const pageState = async () => {
    refreshCfg();
    const { doc, error } = readDoc();
    const schedule = effectiveSchedule();
    return {
      ok: true,
      version: myVersion(),
      home: stateDir,
      files: { config: paths.config, sources: paths.sources, index: paths.index, out: paths.out, log: paths.log },
      config: cfg,
      defaults: DEFAULTS,
      schedule,
      scheduleSource: scheduleSource(),
      sources: doc ? doc.sources.map(toRawSource) : [],
      health: doc ? await healthOf(doc.sources, schedule) : [],
      sourcesError: error,
      sessions: listSessions(),
      pulling,
      lastRun,
      lastDigest: latestDigest(stateDir),
      limits: LIMITS,
    };
  };

  const handle = async (req, res, url) => {
    const route = url.pathname;
    if (req.method === 'GET' && route === '/api/web-watch/status') {
      return sendJson(res, 200, await pageState());
    }
    if (req.method === 'GET' && route === '/api/web-watch/config') {
      refreshCfg();
      return sendJson(res, 200, {
        ok: true,
        config: cfg,
        defaults: DEFAULTS,
        schedule: effectiveSchedule(),
        scheduleSource: scheduleSource(),
        home: stateDir,
      });
    }
    if (req.method === 'POST' && route === '/api/web-watch/config') {
      const body = await readBody(req);
      const patch = {};
      for (const key of Object.keys(DEFAULTS)) if (key in body) patch[key] = body[key];
      try {
        const saved = await persistCfg(patch);
        log(`設置已更新：${JSON.stringify(saved.clean)}（DSH 那邊${saved.host?.ok ? '已同步' : '沒寫成：' + (saved.host?.error || '')}）`);
        return sendJson(res, 200, {
          ok: true,
          config: cfg,
          schedule: effectiveSchedule(),
          host: saved.host,
          mirrored: saved.mirrored,
        });
      } catch (e) {
        if (e instanceof ConfigError) return sendJson(res, 400, { ok: false, error: e.message });
        throw e;
      }
    }
    if (req.method === 'GET' && route === '/api/web-watch/sources') {
      refreshCfg();
      const { doc, error } = readDoc();
      const schedule = effectiveSchedule();
      return sendJson(res, 200, {
        ok: true,
        sources: doc ? doc.sources.map(toRawSource) : [],
        health: doc ? await healthOf(doc.sources, schedule) : [],
        error,
        schedule,
      });
    }
    if (req.method === 'POST' && route === '/api/web-watch/sources') {
      const body = await readBody(req);
      try {
        refreshCfg();
        const saved = await saveSources(Array.isArray(body?.sources) ? body.sources : []);
        return sendJson(res, 200, { ok: true, sources: saved.sources.map(toRawSource) });
      } catch (e) {
        if (e instanceof ConfigError) return sendJson(res, 400, { ok: false, error: e.message });
        throw e;
      }
    }
    // 「立即跑一輪」：**起完就返回**，结果靠页面轮询 /status（照 bili 的 install 那段）
    if (req.method === 'POST' && route === '/api/web-watch/run') {
      if (pulling) return sendJson(res, 200, { ok: true, busy: true, hint: '正在跑，别重复起' });
      refreshCfg();
      const { doc, error } = readDoc();
      if (!doc) return sendJson(res, 400, { ok: false, error: error || '讀不到 sources.json' });
      pulling = true;
      const schedule = effectiveSchedule();
      const startedAt = new Date().toISOString();
      Promise.resolve(
        (async () => {
          try {
            const summary = await runPull({ homeDir: stateDir, sources: doc.sources, schedule, log });
            lastRun = { at: summary.at, digest: summary.digestName, counts: summary.counts };
            return summary;
          } finally {
            pulling = false;
          }
        })(),
      )
        .then((summary) => {
          log(`設置頁跑一輪：變動 ${summary.counts.newEntries} 條（digest ${summary.digestName}）`);
        })
        .catch((e) => log(`設置頁跑一輪失敗（已兜住）：${e?.stack ?? e}`));
      return sendJson(res, 200, { ok: true, started: true, at: startedAt, hint: '在後台跑了 —— 下面會顯示結果，別重複點' });
    }
    // 最新 digest 的文字（浏览器开不了本地文件，照 bili 的 /report）
    if (req.method === 'GET' && route === '/api/web-watch/digest') {
      const latest = latestDigest(stateDir);
      if (!latest) return sendJson(res, 200, { ok: true, exists: false, text: '' });
      let text = '';
      try {
        text = readFileSync(latest.file, 'utf8').slice(0, 200_000);
      } catch {
        text = '';
      }
      return sendJson(res, 200, { ok: true, exists: true, name: latest.name, file: latest.file, text });
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${route}` });
  };

  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/api/web-watch',
          handler: async (req, res) => {
            try {
              await handle(req, res, new URL(req.url, 'http://127.0.0.1'));
            } catch (e) {
              sendJson(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      'web-watch: /api/web-watch 路由',
    );
  } catch (e) {
    log(`HTTP 路由沒掛上（設置頁會降級，工具照常）：${e?.message ?? e}`);
  }

  log(
    `已掛載（家=${stateDir}，v${myVersion() || '?'}，enabled=${cfg.enabled}，` +
      `startAt=${cfg.startAt}（來源=${scheduleSource()}），interval=${cfg.intervalHours}h，` +
      `目標會話=${cfg.targetSession ? cfg.targetSession.slice(0, 16) + '…' : '（不塞訊息）'}）`,
  );

  // 測試把手（DSH 不讀 apply 的回傳值）：等所有排隊寫入落地（smoke 驗啟動自癒 / 併發寫）。
  return { stateDir, paths, whenIdle: () => writeQueue.whenIdle() };
}
