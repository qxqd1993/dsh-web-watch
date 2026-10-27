/**
 * lib/extract.mjs —— 零依賴正文抽取器（B）
 * ============================================================================
 * `extractMain(html, { url, maxChars, status })` → { ok, title, text, chars, ratio, tier, reason }
 *
 * 1. 擋住了就說 blocked（HTTP 403/429、Cloudflare `Just a moment...` /
 *    `Enable JavaScript and cookies`），**不把挑戰頁當正文**；
 * 2. token 掃標籤（不建 DOM）：script/style/noscript/template/svg/form/head 跳過；
 *    nav/header/footer/aside 整段砍；class/id 命中 boilerplate 的容器只標記不砍
 *    （CGTN 把正文放在 class="…comment" 的外殼裡，硬砍會砍掉文章）；
 * 3. 正文：article / main / role=main / itemprop=articleBody 優先，否則按
 *    「段落字數 × (1 − 連結密度) + 段落數 × 20」取最高分 —— 包住整頁的外層 div
 *    文字多但段落純度低，贏不過真正裝正文的那一層；
 * 4. 段落清理：純連結列、版權行、連續短行（<15 字且無標點）；分級 full/partial/shell/blocked。
 * ratio = 抽出字數 / 純去標籤 baseline 字數。`maxChars` 只截回傳 text。
 * ============================================================================
 */

import { collapse, decodeEntities, stripTags } from './engine/xml.mjs';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'form', 'head', 'iframe',
  'canvas', 'object', 'embed', 'button', 'select', 'option', 'textarea', 'input']);

/** 只對「可能是容器」的標籤看 class/id，免得 href 裏的 share 也被砍。 */
const CONTAINER_TAGS = new Set(['div', 'section', 'header', 'footer', 'nav', 'aside', 'ul', 'ol', 'span', 'table']);

const BOILER = /(?:^|[\s_-])(?:nav|menu|sidebar|footer|header|share|related|recommend|comment|cookie|subscribe|newsletter|advert|promo|breadcrumb)(?:$|[\s_-])/i;

/** 命中 boilerplate 詞、但同時是正文外殼時不能砍（反例：CGTN 的 new-detailWrap-v3 cg-share-page）。 */
const CONTENT_WRAP = /(?:detail|article|story|post|entry)[-_]?(?:wrap|wrapper|body|content|text|main|inner)/i;

const BLOCKED_MARKERS = [
  [/just a moment\.\.\./i, 'Cloudflare 挑戰頁（Just a moment...）'],
  [/enable javascript and cookies/i, '站點要求 JavaScript 與 Cookie（Enable JavaScript and cookies）'],
  [/attention required!\s*\|\s*cloudflare/i, 'Cloudflare 攔截頁（Attention Required）'],
];

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
const BLOCK_CLOSE = /<\/(?:p|div|section|article|main|li|ul|ol|h[1-6]|blockquote|pre|tr|td|th|figcaption|dd|dt|table)\s*>/gi;

function oneLine(value) {
  return collapse(decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' ')));
}

function attrText(attrs, name) {
  const m = String(attrs).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function pickTitle(html) {
  const m = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (m) return oneLine(m[1]);
  const og = String(html).match(/<meta\b[^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  return og ? oneLine(og[1]) : '';
}

/** 'hard' = 整段砍；'soft' = 只標記、不當候選；'' = 正常元素。 */
function boilerplateKind(tag, attrs) {
  if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside') return 'hard';
  const role = attrText(attrs, 'role').toLowerCase();
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return 'hard';
  if (!CONTAINER_TAGS.has(tag)) return '';
  const hint = `${attrText(attrs, 'class')} ${attrText(attrs, 'id')}`;
  if (CONTENT_WRAP.test(hint)) return '';
  return BOILER.test(hint) ? 'soft' : '';
}

/** token 掃描：跳過不要的子樹，累計每個開啟中元素的字數 / 段落字數 / 連結字數。 */
function scan(html) {
  const blocks = [];
  const open = [];
  let skip = null;
  let linkDepth = 0;
  let paraDepth = 0;
  let last = 0;

  const addText = (chunk) => {
    const len = collapse(chunk).length;
    if (!len) return;
    for (const el of open) {
      el.text += len;
      if (linkDepth > 0) el.link += len;
      if (paraDepth > 0) el.ptext += len;
    }
  };

  const finish = (el, end) => {
    if (el.text < 80) return;
    blocks.push({ tag: el.tag, attrs: el.attrs, start: el.start, end, text: el.text,
      ptext: el.ptext, para: el.tag === 'p' ? 1 : el.para, link: el.link, boiler: el.boiler });
  };

  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > last) addText(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClosing = m[4] === '/';

    if (skip) {
      if (!closing && !selfClosing && tag === skip.tag) skip.depth += 1;
      else if (closing && tag === skip.tag) skip.depth === 0 ? (skip = null) : (skip.depth -= 1);
      continue;
    }
    if (closing) {
      let at = -1;
      for (let i = open.length - 1; i >= 0; i -= 1) if (open[i].tag === tag) { at = i; break; }
      if (at < 0) continue;
      while (open.length > at) {
        const el = open.pop();
        if (el.tag === 'a') linkDepth = Math.max(0, linkDepth - 1);
        if (el.tag === 'p') paraDepth = Math.max(0, paraDepth - 1);
        finish(el, last);
      }
      if (tag === 'p') for (const el of open) el.para += 1;
      continue;
    }
    if (SKIP_TAGS.has(tag)) { if (!selfClosing) skip = { tag, depth: 0 }; continue; }
    if (selfClosing) continue;
    const kind = boilerplateKind(tag, attrs);
    if (kind === 'hard') { skip = { tag, depth: 0 }; continue; }
    open.push({ tag, attrs, start: m.index, text: 0, ptext: 0, para: 0, link: 0, boiler: kind === 'soft' });
    if (tag === 'a') linkDepth += 1;
    if (tag === 'p') paraDepth += 1;
  }
  if (html.length > last) addText(html.slice(last));
  while (open.length > 0) finish(open.pop(), html.length);
  return blocks;
}

/** 選正文區塊：顯式語意優先，其次文本密度。 */
function pickBlock(blocks) {
  const isArticle = (b) => /itemprop\s*=\s*["']?articleBody/i.test(b.attrs);
  const isMain = (b) => b.tag === 'main' || /\brole\s*=\s*["']?main\b/i.test(b.attrs);
  const big = blocks.filter((b) => b.text >= 200 && !b.boiler);
  const explicit = big.filter((b) => isArticle(b) || b.tag === 'article' || isMain(b));
  if (explicit.length > 0) {
    explicit.sort((a, b) => {
      const rank = (x) => (isArticle(x) ? 3 : x.tag === 'article' ? 2 : 1);
      return rank(b) - rank(a) || b.text - a.text;
    });
    const how = isArticle(explicit[0]) ? 'articleBody' : explicit[0].tag === 'article' ? 'article' : 'main';
    return { block: explicit[0], how };
  }
  let best = null;
  let bestScore = 0;
  for (const b of big) {
    if (b.tag === 'body' || b.tag === 'html') continue;
    const density = Math.min(1, b.link / Math.max(1, b.text));
    const base = b.ptext > 0 ? b.ptext : b.text * 0.5;
    const score = base * (1 - density) + b.para * 20;
    if (score > bestScore && (b.para >= 1 || b.ptext >= 200 || b.text >= 600)) { best = b; bestScore = score; }
  }
  return best ? { block: best, how: `density:${best.tag}` } : null;
}

/** 把選中區塊轉成「一行一段」的文字。 */
function toText(html, block) {
  let slice = html.slice(block.start, block.end);
  // 選中的區塊裡可能夾著 <script>/<style>（外殼包住整頁時很常見）：連內容一起砍，
  // 不然 toText 只去標籤，JS/CSS 會留在正文尾巴（euobserver 第一版就漏過 googletag…）。
  slice = slice.replace(/<(script|style|noscript|template|svg|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  slice = slice.replace(/<a\b[^>]*>/gi, '\u0001').replace(/<\/a\s*>/gi, '\u0002');
  slice = slice.replace(/<(?:br|hr)\b[^>]*>/gi, '\n').replace(BLOCK_CLOSE, '\n');
  slice = decodeEntities(slice.replace(/<[^>]*>/g, ' '));

  const lines = [];
  for (const raw of slice.split(/\n+/)) {
    const withoutLinks = collapse(raw.replace(/\u0001[\s\S]*?\u0002/g, ' '));
    const line = collapse(raw.replace(/[\u0001\u0002]/g, ' '));
    if (!line) continue;
    if (/[\u0001\u0002]/.test(raw) && withoutLinks.length < 5) continue; // 純連結列
    if (line.length < 120 && /^(?:©|copyright\b|all rights reserved)/i.test(line)) continue;
    if (line.length < 120 && /©/.test(line) && /rights reserved|copyright/i.test(line)) continue;
    lines.push(line);
  }
  // 連續短行（<15 字且無標點）是導覽/標籤殘渣：只有「連續 ≥2 行」才丟，單獨的短標題留著。
  const short = (line) => line.length < 15 && !/[.!?。！？,，;；:：]/.test(line);
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && short(lines[j])) j += 1;
    if (j - i >= 2) i = j;
    else kept.push(lines[i++]);
  }
  return kept;
}

/**
 * 段落級去雜（2026-10-25 補）。
 * 起因：euobserver 的文章抽出來乾淨，但頭尾各拖一串 —— 圖注、標題重複、
 * `Unlock article and share`（付費牆殘留）、`Latest from Bulgaria` / `Topics` /
 * `Author Bio` / `+ Follow author`。這些不是正文，卻把 chars 撐高、讓 ratio 虛胖，
 * 也讓 400 字摘錄從圖注開始（讀者以為那就是導航）。
 *
 * 三種處理，分開做：
 *   ① 全域丟掉純 UI 字串（`Read more`、`Unlock article…`）—— 出現在哪都不要；
 *   ② 版面尾巴：從第一個尾段標記（`Latest from…` / `Topics` / `Author Bio` …）起整段切掉；
 *   ③ 版面頭部：丟掉與標題重複的行、署名行、圖注行。
 */
const UI_NOISE = /^(?:unlock article(?: and share)?|read more|share this article|follow topic by email|sign up(?: for our newsletter)?|subscribe(?: to our newsletter)?|\d+\s+comments?)$/i;
/** 行內清洗：這些字串常常跟別的殘渣黏在同一行（"2 Comments Unlock article and share"）。 */
const UI_INLINE = [
  /unlock article(?: and share)?/gi,
  /^\d+\s+comments?\s+/i,
  /\s+\d+\s+comments?$/i,
];
/** 尾巴標記：命中即從該行起整段切（付費牆 / 電子報 / 相關推薦 / 作者欄）。 */
const TRAILER = /^(?:latest from\b|topics$|author bio$|\+?\s*follow author\b|related(?: stories| articles| coverage| reading)?$|more from\b|you may also like$)|(?:become a subscriber|read without limits|already a subscriber|keep up to date|sign up for (?:our|the) newsletter|to read this story|log in or subscribe|subscribe to continue)/i;
/** 獨立成行的日期（LA Times 的關聯清單 / 發佈時間）："Oct. 23, 2026 3 AM PT"、"Sept. 25, 2026" */
const DATE_LINE = /^[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s*\d{4}(?:\s+\d{1,2}\s*(?:AM|PM)(?:\s*[A-Z]{2})?)?$/i;
const BYLINE = /^by\s+\S/i;
const CAPTION = /\((?:source|photo|image|credit|picture)\s*:[^)]*\)|\bsource\s*:\s*\S/i;
/** 麵包屑：「China 22:57, 21-Oct-2026」「Africa 22:25, 23-Oct-2026」 */
const BREADCRUMB = /^[A-Za-z][A-Za-z &'’]{1,24}\s+\d{1,2}:\d{2},\s*\d{1,2}-[A-Za-z]{3}-\d{4}$/;
/** 只有時間+日期的第二行（麵包屑被拆成兩行時） */
const CRUMB_DATE = /^\d{1,2}:\d{2},\s*\d{1,2}-[A-Za-z]{3}-\d{4}$/;
/** LA Times 那種編輯部署名行：「Staff Writer Follow Photography by …」 */
const STAFF_LINE = /^(?:staff writer|photography by|visual (?:story|report)|columnist)\b/i;
/** 閱讀時間 / 分享列 / 播放器殘骸（LA Times 那類）。 */
const READER_CHROME = /^(?:\d{1,2}\s+min\b|click here to listen|share via\b|copy link\b|print$|url copied!?$|1x$|\d{1,2}:\d{2}\s+\d{1,2}:\d{2}$|this is read by\b|close extra sharing options$|\d{1,5}$|see more from the .* in google search|set us as preferred)/i;

function normForTitle(value) {
  return String(value ?? '')
    .replace(/\s*[|–—-]\s*[^|–—-]{2,24}$/, '') // 去掉站名尾巴（"… – EUobserver"）
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function trimBoilerplate(lines, title) {
  // ① 行內清洗（"2 Comments Unlock article and share" 這種黏在一行的），空的就丟
  const cleaned = [];
  for (const raw of lines) {
    let line = raw;
    for (const re of UI_INLINE) line = line.replace(re, ' ');
    line = collapse(line);
    if (line) cleaned.push(line);
  }
  let kept = cleaned.filter((line) => !UI_NOISE.test(line.trim()));

  // ② 尾巴：第一個尾段標記起全部切掉（含付費牆 / 電子報 / 相關推薦）
  const trailerAt = kept.findIndex((line) => TRAILER.test(line.trim()));
  if (trailerAt > 0) kept = kept.slice(0, trailerAt);

  // ③ 頭部：標題重複 / 署名 / 圖注 / 麵包屑 / 閱讀器殘骸 —— **連續**砍
  const t = normForTitle(title);
  while (kept.length > 1) {
    const head = kept[0].trim();
    const isTitleish =
      t.length > 8 && (normForTitle(head) === t || (head.length > 20 && t.startsWith(normForTitle(head))));
    // 麵包屑被拆成兩行：「China」+「22:57, 21-Oct-2026」→ 兩行一起丟
    const splitCrumb = /^[A-Za-z][A-Za-z &'’]{1,24}$/.test(head) && CRUMB_DATE.test(kept[1].trim());
    if (splitCrumb) { kept = kept.slice(2); continue; }
    if (
      isTitleish ||
      UI_NOISE.test(head) ||
      BYLINE.test(head) ||
      CAPTION.test(head) ||
      BREADCRUMB.test(head) ||
      CRUMB_DATE.test(head) ||
      STAFF_LINE.test(head) ||
      READER_CHROME.test(head) ||
      DATE_LINE.test(head)
    ) {
      kept = kept.slice(1);
    } else break;
  }
  // 尾巴也可能殘留 UI 字 / 日期列 / 全大寫欄目名（切完尾段後再清一次）
  const tailJunk = (line) =>
    UI_NOISE.test(line) ||
    TRAILER.test(line) ||
    DATE_LINE.test(line) ||
    /^[A-Z][A-Z\s&]{3,24}$/.test(line) ||
    /^[A-Z][a-z]{2,14}$/.test(line); // 尾巴上單獨一個詞：多半是欄目名（Voices / Topics）
  while (kept.length > 1 && tailJunk(kept[kept.length - 1].trim())) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

export function extractMain(html, { url = '', maxChars = 0, status = 0 } = {}) {
  const raw = String(html ?? '').replace(/^\uFEFF/, '');
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const title = pickTitle(raw);
  let blocked = status === 403 || status === 429 ? `HTTP ${status}（站點拒絕：可能是 Cloudflare / 驗證牆）` : '';
  if (!blocked) for (const [re, why] of BLOCKED_MARKERS) if (re.test(raw)) { blocked = why; break; }
  if (blocked) return { ok: false, title, text: '', chars: 0, ratio: 0, tier: 'blocked', reason: blocked };

  const picked = pickBlock(scan(raw));
  let lines = picked ? toText(raw, picked.block) : [];
  let how = picked ? picked.how : 'none';
  // 段落級去雜（頭部標題重複/署名/圖注、尾部 Latest from / Topics / Author Bio、全域 UI 字串）
  if (lines.length) {
    const trimmed = trimBoilerplate(lines, title);
    if (trimmed.length && trimmed.join('\n').length >= 200) lines = trimmed;
  }
  const baselineChars = collapse(decodeEntities(stripTags(raw))).length;

  // 密度法完全挑不到（或清完是空）→ 退回去標籤 baseline，並照實標低信度。
  let text = lines.join('\n');
  if (text.length < 200) {
    const fallback = collapse(decodeEntities(stripTags(raw)));
    if (fallback.length > text.length) { text = fallback; lines = [fallback]; how = 'strip-tags-fallback'; }
  }
  const chars = text.length;
  const paras = lines.filter((line) => line.length >= 40).length;
  const ratio = baselineChars > 0 ? Number((chars / baselineChars).toFixed(3)) : 0;

  let tier = 'full';
  let reason = `正文抽取（${how}，${paras} 段）`;
  if (chars === 0) { tier = 'shell'; reason = '抽不到任何正文文字'; }
  else if (chars < 400 && rawBytes > 50 * 1024) { tier = 'shell'; reason = `只抽到 ${chars} 字（原始 ${Math.round(rawBytes / 1024)}KB，疑似 JS 殼）`; }
  else if (chars < 800) { tier = 'partial'; reason = `正文偏短（${chars} 字）`; }
  else if (paras < 3 || ratio < 0.1) { tier = 'partial'; reason = `正文佔比低（段落 ${paras}，ratio ${ratio}）`; }

  let outText = text;
  if (Number.isFinite(maxChars) && maxChars > 0 && outText.length > maxChars) {
    outText = outText.slice(0, maxChars);
    reason = `${reason}；已截到 maxChars=${maxChars}`;
  }
  return { ok: tier === 'full' || tier === 'partial', title, text: outText, chars: outText.length, ratio, tier, reason };
}
