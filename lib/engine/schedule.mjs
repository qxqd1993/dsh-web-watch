/**
 * due 判斷與時區工具。
 *
 * 規則（P1）：
 *   - 每個源可用 intervalHours / startAt 覆寫全域 schedule
 *   - 上次成功時間 + interval，對齊到 startAt 之後的第一個窗
 *   - 沒有 lastOkAt（從未成功）→ due
 *   - 同一分鐘內重跑一定 not-due（candidate 嚴格大於 lastOkAt）
 *   - --now 可以改「現在」，所以可以測 due
 */

const MINUTE_MS = 60_000;

export function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new Error('schedule.timezone 必須是 IANA 時區字串（例如 Asia/Macau）');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new Error(`無法辨識時區：${timeZone}`);
  }
  return timeZone;
}

export function parseStartAt(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`startAt 必須是 HH:MM（00:00–23:59），收到：${String(value)}`);
  }
  return value;
}

/** 某個瞬間在指定時區的日曆欄位。 */
export function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** 該瞬間在指定時區的 UTC 偏移（分鐘）。 */
export function offsetMinutes(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const instant = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - instant) / MINUTE_MS);
}

/** 日曆時間（在 timeZone）→ 絕對瞬間。 */
export function zonedTimeToInstant(parts, timeZone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  let instant = guess - offsetMinutes(new Date(guess), timeZone) * MINUTE_MS;
  instant = guess - offsetMinutes(new Date(instant), timeZone) * MINUTE_MS;
  return new Date(instant);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 2026-10-23T18:00:00+08:00 */
export function formatZonedIso(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const offset = formatOffset(offsetMinutes(date, timeZone));
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}${offset}`
  );
}

/** 2026-10-24 13:40（digest 標題用） */
export function formatLocalStamp(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** 2026-10-24T13-40（digest 檔名用） */
export function formatFileStamp(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}-${pad2(parts.minute)}`;
}

/**
 * 判斷一個源現在是否到期。
 * @returns {{due:boolean, reason:string, scheduledAt:Date|null, nextAt:Date|null}}
 */
export function evaluateDue({ source, state, schedule, now }) {
  const timeZone = schedule.timezone;
  const intervalHours = source.intervalHours ?? schedule.intervalHours;
  const startAt = source.startAt ?? schedule.startAt;
  const intervalMs = Math.round(intervalHours * 3_600_000);

  const lastRaw = state?.lastOkAt;
  const last = lastRaw ? new Date(lastRaw) : null;
  if (!last || Number.isNaN(last.getTime())) {
    return { due: true, reason: 'never-run', scheduledAt: null, nextAt: null };
  }
  if (!(intervalMs > 0)) {
    throw new Error(`intervalHours 必須 > 0（源 ${source.id}）`);
  }

  const [hour, minute] = startAt.split(':').map(Number);
  const local = zonedParts(last, timeZone);
  let candidate = zonedTimeToInstant({ ...local, hour, minute, second: 0 }, timeZone);

  let guard = 0;
  while (candidate.getTime() <= last.getTime()) {
    candidate = new Date(candidate.getTime() + intervalMs);
    guard += 1;
    if (guard > 10_000) throw new Error(`無法算出 ${source.id} 的下一個窗`);
  }

  const due = now.getTime() >= candidate.getTime();
  let nextAt = candidate;
  if (due) {
    guard = 0;
    while (nextAt.getTime() <= now.getTime()) {
      nextAt = new Date(nextAt.getTime() + intervalMs);
      guard += 1;
      if (guard > 10_000) throw new Error(`無法算出 ${source.id} 的再下一個窗`);
    }
  }

  return {
    due,
    reason: due ? 'due' : 'not-due',
    scheduledAt: candidate,
    nextAt,
  };
}
