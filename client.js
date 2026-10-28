/**
 * dsh-web-watch —— 浏览器半端（**设置在「设置」里的一页**）
 * ============================================================================
 * ⭐ 这个文件的结构是照 dsh-bili-subagent/client.js 抄的（那不是猜的，是从官方包里挖出来的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * 进「设置 → 插件」的写法（bili client.js:982-988）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'web-watch', order: 40, label: '藍色大肥魚的報箱' },
 *       () => h(Panel),
 *     ))
 *
 * 存取走**宿主后端**（bili 的同一条通道，见其 index.js:1739-1760）：
 *   GET  /api/web-watch/status   ← 配置 + 源清单 + 健康度 + 最近一輪
 *   POST /api/web-watch/config   ← 改配置（后端校验 → ctx.settings.update + config.json）
 *   POST /api/web-watch/sources  ← 改源清單（后端用引擎的同一份校驗）
 *   POST /api/web-watch/run      ← 立即跑一輪（起完就返回，页面轮询看结果）
 *   GET  /api/web-watch/digest   ← 最新 digest 的文字
 *
 * 保存时**先在页面上校验**（url 必须 https、kind ∈ {rss,json,html}、startAt HH:MM、intervalHours > 0），
 * 不合法就红字提示、**不发请求**；后端还有一份同样的校验（两道闸，谁也不靠谁）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  // ⚠️ 这一行必须等于 package.json 的 name（加载器按包名找工厂，对不上就报
  //    "web boot: 1 entry did not activate … loaded without registering <包名>"）。
  id: 'dsh-web-watch',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/web-watch';

    const asJson = async (res) => {
      if (res.ok) return res.json();
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : '';
      throw new Error(`HTTP ${res.status}${why}`);
    };
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }));
    const jpost = async (p, body) =>
      asJson(
        await fetch(API + p, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }),
      );

    const KINDS = ['rss', 'json', 'html'];
    const ROLES = ['full', 'index'];

    const CSS = `
[data-ww-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:760px;}
[data-ww-sec]{display:flex;flex-direction:column;gap:8px;}
[data-ww-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ww-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-ww-grow]{flex:1 1 auto;min-width:0;}
/* ⚠️ label 必須 nowrap：中文沒有自然斷點，這欄一旦被壓窄就是「一個漢字一行」的豎條。
   flex:0 0 auto 是給「label 直接當行內 flex item」的情況兜底（目前都是包在 grow 裡）。 */
[data-ww-label]{font-size:13px;flex:0 0 auto;white-space:nowrap;}
[data-ww-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ww-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-ww-sw][data-on]{background:#3b82f6;}
[data-ww-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-ww-sw][data-on] i{left:19px;}
[data-ww-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-ww-input]:focus{outline:none;border-color:#3b82f6;}
[data-ww-num]{width:76px;text-align:center;flex:none;}
[data-ww-when]{width:96px;flex:none;text-align:center;}
/* ⚠️ 這是「目標會話 id」「怎麼稱呼你」那幾行 label 變豎條的真兇：
   上面 [data-ww-input]{width:100%} 會變成 flex-basis，而在 flex 行裡「100%」＝整行寬，
   於是它獨佔了整行；同行的 [data-ww-grow] flex-basis 是 0（scaled shrink factor = 1×0 = 0），
   在收縮階段連 1px 都分不到 → 文字欄變成 0 寬 → 中文逐字換行。
   這裡只改「行內那種要撐滿剩餘寬度的輸入框」：給它一個 160px 的 basis 讓它跟文字欄分寬度；
   帶固定寬度修飾（when / num）的不在此列，仍然 flex:none + 固定 px。
   列容器（[data-ww-src] / grid）裡的輸入框不受影響，還是 width:100%。 */
[data-ww-row] > input[data-ww-input]:not([data-ww-when]):not([data-ww-num]){
  flex:1 1 160px;min-width:0;width:auto;}
input[data-ww-input][data-ww-err]{border-color:#ef4444;}
select[data-ww-input]{width:auto;min-width:92px;max-width:120px;flex:0 0 auto;}
[data-ww-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-ww-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-ww-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-ww-btn][disabled]{opacity:.5;cursor:default;}
[data-ww-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ww-msg][data-warn]{color:#f59e0b;}
[data-ww-msg][data-good]{color:#22c55e;}
[data-ww-src]{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;
  padding:8px 10px;display:flex;flex-direction:column;gap:6px;}
[data-ww-src][data-bad]{border-color:#f59e0b;}
[data-ww-src-h]{display:flex;align-items:center;gap:8px;}
[data-ww-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-ww-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-ww-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:220px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
`;

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange }) {
      return h(
        'button',
        {
          'data-ww-sw': '',
          'data-on': on ? '' : undefined,
          title: on ? '已开' : '已关',
          onClick: () => onChange(!on),
        },
        h('i'),
      );
    }

    function Btn({ children, onClick, disabled, primary }) {
      return h(
        'button',
        { 'data-ww-btn': '', 'data-primary': primary ? '' : undefined, disabled: Boolean(disabled), onClick },
        children,
      );
    }

    function Msg({ text, tone }) {
      if (!text) return null;
      return h(
        'div',
        {
          'data-ww-msg': '',
          'data-warn': tone === 'warn' ? '' : undefined,
          'data-good': tone === 'good' ? '' : undefined,
        },
        text,
      );
    }

    /* ────────────── 草稿 ↔ 服务端 ────────────── */

    const rowOf = (source) => ({
      id: String(source.id ?? ''),
      kind: String(source.kind ?? 'rss'),
      role: String(source.role ?? 'full'),
      url: String(source.url ?? ''),
      maxItems: String(source.maxItems ?? 10),
      path: String(source.path ?? ''),
      idPath: String(source.idPath ?? ''),
      titlePath: String(source.titlePath ?? ''),
      linkPath: String(source.linkPath ?? ''),
      bodyPath: String(source.bodyPath ?? ''),
      datePath: String(source.datePath ?? ''),
    });

    /** 草稿 → 送後端的形狀（空字串一律不送：後端嫌 empty string 不合法）。 */
    const rawOf = (row) => {
      const out = {
        id: String(row.id ?? '').trim(),
        kind: row.kind,
        role: row.role || 'full',
        url: String(row.url ?? '').trim(),
        maxItems: Number(row.maxItems) || 10,
      };
      if (row.kind === 'json') {
        out.path = String(row.path ?? '').trim();
        for (const key of ['idPath', 'titlePath', 'linkPath', 'bodyPath', 'datePath']) {
          const value = String(row[key] ?? '').trim();
          if (value) out[key] = value;
        }
      }
      return out;
    };

    /**
     * 页面这道的校驗（后端还有一道同样的）。
     * @returns {string[]} 人话错误清单（空 = 通过）
     */
    function validate(draft, rows) {
      const errors = [];
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(draft.startAt ?? ''))) {
        errors.push(`开始时间要是 HH:MM（00:00–23:59），现在是「${draft.startAt || '空'}」`);
      }
      const interval = Number(draft.intervalHours);
      if (!Number.isFinite(interval) || interval <= 0) errors.push('间隔要 > 0（可小数，例如 0.5）');
      else if (interval > 720) errors.push('间隔上限 720 小时');
      if (!String(draft.ownerName ?? '').trim()) errors.push('称呼不能空');

      if (rows.length === 0) errors.push('至少要留一条源');
      const seen = new Set();
      rows.forEach((row, index) => {
        const at = `第 ${index + 1} 条源`;
        const id = String(row.id ?? '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) errors.push(`${at}：id 只能小写英数跟 -（1–64 字）`);
        else if (seen.has(id)) errors.push(`${at}：id 重复（${id}）`);
        else seen.add(id);

        if (!KINDS.includes(row.kind)) errors.push(`${at}：kind 只能是 rss / json / html`);
        let parsed = null;
        try {
          parsed = new URL(String(row.url ?? '').trim());
        } catch {
          parsed = null;
        }
        if (!parsed) errors.push(`${at}：url 不是合法链接`);
        else if (parsed.protocol !== 'https:') errors.push(`${at}：url 必须是 https（现在是 ${parsed.protocol}）`);

        const max = Number(row.maxItems);
        if (!Number.isInteger(max) || max < 1 || max > 100) errors.push(`${at}：maxItems 要 1–100 的整数`);
        if (row.kind === 'json' && !String(row.path ?? '').trim()) errors.push(`${at}：kind=json 必须填 path`);
        if (!ROLES.includes(row.role)) errors.push(`${at}：role 只能是 full / index`);
      });
      return errors;
    }

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      const [st, setSt] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [rows, setRows] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [tone, setTone] = React.useState('');
      const [digest, setDigest] = React.useState(null);
      // ⚠️ 输入框绑「本地草稿」：页面每 5 秒轮询 /status，直接绑服务端那份会把打字冲到一半的人冲没
      const dirty = React.useRef(false);

      const touch = () => {
        dirty.current = true;
      };

      const load = async (force) => {
        try {
          const data = await jget('/status');
          if (!data?.ok) {
            setMsg(data?.error || '讀不到狀態');
            setTone('warn');
            return;
          }
          setSt(data);
          if (!dirty.current || force) {
            setDraft({
              enabled: Boolean(data.config?.enabled),
              startAt: String(data.config?.startAt ?? '09:00'),
              intervalHours: String(data.config?.intervalHours ?? 24),
              targetSession: String(data.config?.targetSession ?? ''),
              ownerName: String(data.config?.ownerName ?? '你'),
            });
            setRows((data.sources || []).map(rowOf));
            dirty.current = false;
          }
        } catch (e) {
          setMsg(`讀狀態失敗：${e?.message ?? e}`);
          setTone('warn');
        }
      };

      React.useEffect(() => {
        load(true);
        const timer = setInterval(() => load(false), 5000);
        return () => clearInterval(timer);
      }, []);

      const onSave = async () => {
        const errors = validate(draft || {}, rows || []);
        if (errors.length) {
          setMsg(`先修这些：${errors.join('；')}`);
          setTone('warn');
          return;
        }
        setBusy('save');
        setMsg('');
        try {
          const savedCfg = await jpost('/config', {
            enabled: Boolean(draft.enabled),
            startAt: draft.startAt,
            intervalHours: Number(draft.intervalHours),
            targetSession: draft.targetSession,
            ownerName: draft.ownerName,
          });
          if (!savedCfg?.ok) throw new Error(savedCfg?.error || '存配置失败');
          const savedSrc = await jpost('/sources', { sources: (rows || []).map(rawOf) });
          if (!savedSrc?.ok) throw new Error(savedSrc?.error || '存源清单失败');
          dirty.current = false;
          const hostNote =
            savedCfg.host && savedCfg.host.ok === false
              ? `（DSH 那边没写成：${savedCfg.host.error} —— 值在 config.json 里）`
              : '';
          setMsg(`已存好：配置 + ${savedSrc.sources?.length ?? 0} 条源${hostNote}`);
          setTone(hostNote ? 'warn' : 'good');
          await load(true);
        } catch (e) {
          setMsg(`存失败：${e?.message ?? e}`);
          setTone('warn');
        } finally {
          setBusy('');
        }
      };

      const onRun = async () => {
        setBusy('run');
        setMsg('');
        try {
          const started = await jpost('/run', {});
          if (!started?.ok) throw new Error(started?.error || '起不来');
          setMsg(started.busy ? '已经在跑了，别重复点' : '在后台跑了 —— 跑完这里会显示结果（大概几十秒）');
          setTone('good');
          setTimeout(() => load(true), 4000);
        } catch (e) {
          setMsg(`跑失败：${e?.message ?? e}`);
          setTone('warn');
        } finally {
          setBusy('');
        }
      };

      const onDigest = async () => {
        if (digest !== null) {
          setDigest(null);
          return;
        }
        try {
          const data = await jget('/digest');
          setDigest(data?.text || '（还没有 digest：先跑一輪）');
        } catch (e) {
          setDigest(`讀不到 digest：${e?.message ?? e}`);
        }
      };

      const patchRow = (index, patch) => {
        touch();
        setRows((prev) => prev.map((row, at) => (at === index ? { ...row, ...patch } : row)));
      };

      if (!draft || !rows) {
        return h('div', { 'data-ww-page': '' }, h(Msg, { text: msg || '读取中…', tone: 'warn' }));
      }

      const health = st?.health || [];
      const healthOf = (id) => health.find((item) => item.id === id) || null;
      const errors = validate(draft, rows);
      const lastRun = st?.lastRun;
      const latest = st?.lastDigest;

      return h(
        'div',
        { 'data-ww-page': '' },

        /* ── 总开关 + 节奏 ── */
        h(
          'div',
          { 'data-ww-sec': '' },
          h('div', { 'data-ww-h': '' }, '藍色大肥魚的報箱（web-watch）'),
          h(
            'div',
            { 'data-ww-row': '' },
            h(
              'div',
              { 'data-ww-grow': '' },
              h('div', { 'data-ww-label': '' }, '总开关'),
              h('div', { 'data-ww-note': '' }, '关掉 = 定时器不动作；工具和「立即跑一輪」仍然能用'),
            ),
            h(Switch, {
              on: Boolean(draft.enabled),
              onChange: (value) => {
                touch();
                setDraft({ ...draft, enabled: value });
              },
            }),
          ),
          h(
            'div',
            { 'data-ww-row': '' },
            h('div', { 'data-ww-grow': '' }, h('div', { 'data-ww-label': '' }, '每天第一窗（HH:MM）'), h('div', { 'data-ww-note': '' }, `時間來源：${st?.scheduleSource || 'config.json'}`)),
            h('input', {
              'data-ww-input': '',
              'data-ww-when': '',
              'data-ww-err': /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.startAt) ? undefined : '',
              value: draft.startAt,
              placeholder: '09:00',
              onChange: (e) => {
                touch();
                setDraft({ ...draft, startAt: e.target.value });
              },
            }),
          ),
          h(
            'div',
            { 'data-ww-row': '' },
            h(
              'div',
              { 'data-ww-grow': '' },
              h('div', { 'data-ww-label': '' }, '间隔（小时，可小数）'),
              h('div', { 'data-ww-note': '' }, `时区：${st?.schedule?.timezone || 'Asia/Macau'}（在 sources.json 里改）`),
            ),
            h('input', {
              'data-ww-input': '',
              'data-ww-num': '',
              value: draft.intervalHours,
              placeholder: '24',
              onChange: (e) => {
                touch();
                setDraft({ ...draft, intervalHours: e.target.value });
              },
            }),
          ),
        ),

        /* ── 目标会话 + 称呼 ── */
        h(
          'div',
          { 'data-ww-sec': '' },
          h('div', { 'data-ww-h': '' }, '跑完把摘要塞给谁'),
          h(
            'div',
            { 'data-ww-row': '' },
            h(
              'div',
              { 'data-ww-grow': '' },
              h('div', { 'data-ww-label': '' }, '目标会话 id（留空＝不主动塞訊息）'),
              h('div', { 'data-ww-note': '' }, '填了才会有「到点跑完，摘要 followup 进会话」；会话没醒着就只记日志'),
            ),
            h('input', {
              'data-ww-input': '',
              value: draft.targetSession,
              placeholder: '（留空）',
              onChange: (e) => {
                touch();
                setDraft({ ...draft, targetSession: e.target.value });
              },
            }),
          ),
          // ⭐ 2026-10-25：原本是「可选会话：id（id…）」—— 宿主没给标题，id 只能印两次。
          //    现在只报「最新会话」一个，有标题就带标题；没有就只写完整 id（不做截断，
          //    截断反而让两串 uuid 更像乱码）。
          st?.sessions?.length
            ? h(
                'div',
                { 'data-ww-note': '' },
                (() => {
                  const latest = st.sessions[0];
                  const title = String(latest?.title || '').trim();
                  return title ? `最新会话：${title}（${latest.id}）` : `最新会话：${latest?.id || ''}`;
                })(),
              )
            : null,
          h(
            'div',
            { 'data-ww-row': '' },
            h('div', { 'data-ww-grow': '' }, h('div', { 'data-ww-label': '' }, '怎么称呼你')),
            h('input', {
              'data-ww-input': '',
              value: draft.ownerName,
              placeholder: '你',
              onChange: (e) => {
                touch();
                setDraft({ ...draft, ownerName: e.target.value });
              },
            }),
          ),
        ),

        /* ── 源清单 ── */
        h(
          'div',
          { 'data-ww-sec': '' },
          h(
            'div',
            { 'data-ww-row': '' },
            h(
              'div',
              { 'data-ww-grow': '' },
              h('div', { 'data-ww-h': '' }, `源清单（${rows.length} 条）`),
              h('div', { 'data-ww-note': '' }, 'url 只接受 https；kind=json 另需 path（其余 *Path 可留空用默认）'),
            ),
            h(
              Btn,
              {
                onClick: () => {
                  touch();
                  setRows([
                    ...rows,
                    {
                      id: `source-${rows.length + 1}`,
                      kind: 'rss',
                      role: 'full',
                      url: '',
                      maxItems: '10',
                      path: '',
                      idPath: '',
                      titlePath: '',
                      linkPath: '',
                      bodyPath: '',
                      datePath: '',
                    },
                  ]);
                },
              },
              '+ 加一条',
            ),
          ),
          ...rows.map((row, index) => {
            const info = healthOf(String(row.id).trim());
            const bad =
              info && Number(info.failures) > 0 ? true : false;
            return h(
              'div',
              { 'data-ww-src': '', 'data-bad': bad ? '' : undefined, key: `${index}-${row.id}` },
              h(
                'div',
                { 'data-ww-src-h': '' },
                h('input', {
                  'data-ww-input': '',
                  style: { width: '150px', flex: 'none' },
                  value: row.id,
                  placeholder: 'id',
                  onChange: (e) => patchRow(index, { id: e.target.value }),
                }),
                h(
                  'select',
                  {
                    'data-ww-input': '',
                    value: row.kind,
                    onChange: (e) => patchRow(index, { kind: e.target.value }),
                  },
                  ...KINDS.map((kind) => h('option', { key: kind, value: kind }, kind)),
                ),
                h(
                  'select',
                  {
                    'data-ww-input': '',
                    value: row.role,
                    onChange: (e) => patchRow(index, { role: e.target.value }),
                  },
                  ...ROLES.map((role) => h('option', { key: role, value: role }, role)),
                ),
                h('input', {
                  'data-ww-input': '',
                  'data-ww-num': '',
                  value: row.maxItems,
                  placeholder: '10',
                  onChange: (e) => patchRow(index, { maxItems: e.target.value }),
                }),
                h('div', { 'data-ww-grow': '' }),
                h(
                  Btn,
                  {
                    disabled: rows.length <= 1,
                    onClick: () => {
                      touch();
                      setRows(rows.filter((_item, at) => at !== index));
                    },
                  },
                  '删',
                ),
              ),
              h('input', {
                'data-ww-input': '',
                value: row.url,
                placeholder: 'https://…',
                onChange: (e) => patchRow(index, { url: e.target.value }),
              }),
              row.kind === 'json'
                ? h(
                    'div',
                    { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' } },
                    ...[
                      ['path', 'path（必填，例如 appnews.newsitems）'],
                      ['idPath', 'idPath（例如 gid）'],
                      ['titlePath', 'titlePath（默认 title）'],
                      ['linkPath', 'linkPath（默认 url）'],
                      ['bodyPath', 'bodyPath（默认 contents）'],
                      ['datePath', 'datePath（默认 date）'],
                    ].map(([key, placeholder]) =>
                      h('input', {
                        key,
                        'data-ww-input': '',
                        value: row[key],
                        placeholder,
                        onChange: (e) => patchRow(index, { [key]: e.target.value }),
                      }),
                    ),
                  )
                : null,
              info
                ? h(
                    'div',
                    { 'data-ww-kv': '' },
                    `健康度：${Number(info.failures) > 0 ? `连续/累计失败 ${info.failures} 次` : '正常'}` +
                      ` · 上次：${info.lastStatus || '没跑过'}` +
                      ` · 到期：${info.nextAtLocal || '从未成功（下一轮就跑）'}`,
                  )
                : null,
            );
          }),
        ),

        /* ── 动作 ── */
        h(
          'div',
          { 'data-ww-row': '' },
          h(Btn, { primary: true, disabled: busy === 'save' || errors.length > 0, onClick: onSave }, busy === 'save' ? '保存中…' : '保存'),
          h(Btn, { onClick: () => load(true) }, '重新載入'),
          h(Btn, { disabled: busy === 'run' || st?.pulling, onClick: onRun }, st?.pulling ? '跑着呢…' : '立即跑一輪'),
          h(Btn, { onClick: onDigest }, digest !== null ? '收起 digest' : '看最新 digest'),
        ),
        errors.length
          ? h(Msg, { text: `还有 ${errors.length} 处要改：${errors.slice(0, 4).join('；')}`, tone: 'warn' })
          : null,
        h(Msg, { text: msg, tone }),

        /* ── 状态 ── */
        h(
          'div',
          { 'data-ww-sec': '' },
          h('div', { 'data-ww-h': '' }, '它现在什么状态'),
          h(
            'div',
            { 'data-ww-kv': '' },
            `家目录：${st?.home || '?'}`,
            h('br'),
            `源文件：${st?.files?.sources || '?'}`,
            h('br'),
            `最新 digest：${latest ? latest.name : '（还没有）'}` +
              (lastRun ? ` · 最近一輪：${lastRun.at}（變動 ${lastRun.counts?.newEntries ?? 0} / 沒變 ${lastRun.counts?.unchangedSources ?? 0} / 抓不到 ${lastRun.counts?.failedSources ?? 0}）` : ''),
            latest ? h('br') : null,
            latest ? `digest 路徑：${latest.file}` : null,
          ),
          digest !== null ? h('pre', { 'data-ww-pre': '' }, digest) : null,
        ),
      );
    }

    /* ────────────── 注册到「设置 → 插件」 ────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-web-watch');
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-web-watch: 设置页样式');

        // ⭐ 进「设置」：label 就是左侧导航里那一项（照 bili client.js:982-988）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'web-watch', order: 40, label: '藍色大肥魚的報箱' },
            () => h(Panel),
          ),
        );
      },
    };
  },
});
