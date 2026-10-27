/**
 * lib/hostdeps.mjs —— 从**宿主那棵树**里取 `@deepseek-ai/*`
 * ============================================================================
 * 为什么要有它（照 dsh-bili-subagent 的 lib/hostdeps.mjs，2026-10-16 那次事故）：
 *   插件顶栏裸 `import '@deepseek-ai/schemastery'` 会要命 —— 它在 package.json 里是
 *   **optional peer**，桌面版 profile 是 `autoInstallPeers: false` ⇒ 永远不装 ⇒
 *   裸 import 抛错 ⇒ **整条插件不激活**，DSH 只留一句
 *   `warning: 1 entry did not activate … failed to import`。
 *
 * ⭐ 策略（跟 bili 一样，两条一起走）：
 *   ① **优先从宿主那棵树里解析**（跟宿主用同一份，行为最一致）；
 *   ② 解析不到就 bare import（靠 profile 树 / 自己的 node_modules）；
 *   ③ `schemastery` 彻底拿不到 ⇒ 返回 null，**插件照常加载**（只是没有 Config、
 *      设置页降级成「改不了宿主那层、只写 config.json」）—— 绝不因为一个 import
 *      就让整条插件不激活。
 *
 * 本机实测（bili 的 duty.log，2026-10-24）：
 *   `schemastery：从宿主树取到（C:/Users/.../.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs）`
 *   `dsh-tools：宿主树里没有，用自己依赖里那份`
 * ⇒ 所以下面这套候选根**必须**包含 profile 树，不然这台机器上就拿不到 schemastery。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 插件自己那棵树（真装成依赖时才有）—— 用模块位置算，别依赖 cwd */
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai');

/** 可能藏着宿主 `@deepseek-ai` 包的地方（按可能性排序，不写死某一台机器） */
export function candidateRoots() {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(process.env.DSH_HOST_MODULES);

  // ① profile 树：桌面版就在这儿（本机实测的第一命中）
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    for (const name of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', name, 'node_modules', '@deepseek-ai'));
    }
  } catch {
    /* 没有就算了 */
  }

  // ② APPDATA 下的全局 npm / 桌面版应用树
  const appdata = process.env.APPDATA;
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules');
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
    push(join(npm, '@deepseek-ai'));
    try {
      for (const name of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', name, 'node_modules', '@deepseek-ai'));
      }
    } catch {
      /* 没有就算了 */
    }
  }

  // ③ 类 Unix 的常见全局位置
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
  push('/usr/local/lib/node_modules/@deepseek-ai');
  push('/usr/lib/node_modules/@deepseek-ai');

  // ④ 插件自己那份（放最后：前面优先「跟宿主同一份」）
  push(SELF_MODULES);
  return out;
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name);
    const pkgFile = join(dir, 'package.json');
    if (!existsSync(pkgFile)) return null;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    const dot = pkg.exports?.['.'];
    const rel = typeof dot === 'string' ? dot : dot?.import || dot?.default || pkg.module || pkg.main;
    if (!rel) return null;
    const file = join(dir, String(rel).replace(/^\.\//, ''));
    return existsSync(file) ? pathToFileURL(file).href : null;
  } catch {
    return null;
  }
}

/** 试从宿主树里 import 一个包；拿不到返回 null（失败原因写进 notes，方便排查） */
async function fromHostTree(name, log) {
  const fails = [];
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue; // 自己那份交给下面的 bare import
    const url = entryUrlFor(root, name);
    if (!url) continue;
    try {
      const mod = await import(url);
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`);
      return mod;
    } catch (e) {
      fails.push(`${e?.code || 'ERR'}:${root}`);
    }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`);
  return null;
}

/** 兜底：拿不到宿主的 defineTool 时用（**不是**自创协议，就是原样返回 spec） */
function localDefineTool(options, log) {
  // 宿主的 defineTool 会做 spec→JSONSchema 转换 + 参数校验；我们的 parameters / output.schema
  // **本来就是标准 JSON Schema**（bili 那边也是这么顶上的），所以这里只补同样的校验。
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`);
    }
    for (const [key, value] of Object.entries(schema.properties || {})) check(value, `${where}.properties.${key}`);
  };
  check(options.parameters, 'parameters');
  check(options.output?.schema, 'output.schema');
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上了（工具 ${options.name}）`);
  return options;
}

/**
 * 取回宿主半端要用的一点点东西。
 * @returns {Promise<{z:any, defineTool:Function, notes:string[]}>}
 */
export async function loadHostDeps() {
  const notes = [];
  const log = (msg) => notes.push(msg);

  // ① schemastery（Config 要用；宿主设置层要用**它自己那份**读 volatile 字段）
  let zMod = await fromHostTree('schemastery', log);
  if (!zMod) {
    try {
      zMod = await import('@deepseek-ai/schemastery');
      log('schemastery：宿主树里没有，用自己依赖里那份');
    } catch (e) {
      log(
        `⚠️ schemastery 彻底拿不到（${e?.code || ''} ${String(e?.message || '').slice(0, 120)}）——` +
          '这一份插件没有 Config，DSH 原生设置页那层会降级（插件本体照常跑）',
      );
    }
  }
  const z = zMod?.default ?? zMod ?? null;

  // ② defineTool（拿不到就用本地等价实现 —— 工具注册不能因为缺个包就整条不起）
  let dtMod = await fromHostTree('dsh-tools', log);
  if (!dtMod) {
    try {
      dtMod = await import('@deepseek-ai/dsh-tools');
      log('dsh-tools：宿主树里没有，用自己依赖里那份');
    } catch (e) {
      log(`dsh-tools 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`);
      dtMod = null;
    }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log));

  return { z, defineTool, notes };
}
