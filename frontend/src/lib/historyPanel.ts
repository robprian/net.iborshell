// Warp 式终端 history 面板（↑ 唤起）的纯逻辑层：条目过滤、高亮循环导航与
// 打开门判定。数据来源（commandHistory）与浮层渲染留在 App.vue / 组件——
// 与 commandSuggestions/quickSelect 同一分工。检索复用 searchCommands 的
// fzf 风格子序列评分；无命中（或 query 超长越界）时回落大小写不敏感子串
// 过滤并保持历史顺序，保证「输入越打越具体」永远有可预期的结果集。



/** 执行时间映射的容量上限（与 commandHistory 环形同额），超出按时间淘汰最旧。 */
export const HISTORY_TIMES_LIMIT = 100;


// —— 富元数据映射（批 4d，并行结构与时间映射同款）：命令 → {时长, 退出码}。
// OSC 633 D 帧的 lastCommandDuration/lastExitCode 在 applyCommandMarker 写入；
// 无 shell integration 的会话（无 D 帧）两值恒空，面板不渲染这两列。

export interface HistoryMetaRow {
  durationMs: number | null;
  exitCode: number | null;
}

export const HISTORY_META_LIMIT = 100;

/** 解析持久化的元数据映射：仅保留合法键值对并按容量截断。 */
export function sanitizeHistoryMeta(raw: unknown, limit = HISTORY_META_LIMIT): Record<string, HistoryMetaRow> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, HistoryMetaRow> = {};
  const rows: Array<[string, HistoryMetaRow]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { c, d, x } = item as { c?: unknown; d?: unknown; x?: unknown };
    if (typeof c !== "string" || !c.trim()) continue;
    const durationMs = typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : null;
    const exitCode = typeof x === "number" && Number.isFinite(x) ? x : null;
    if (durationMs === null && exitCode === null) continue;
    rows.push([c, { durationMs, exitCode }]);
  }
  for (const [command, row] of rows.slice(-limit)) out[command] = row;
  return out;
}

/** 记录一条元数据：合并写（时长与退出码可能分两次到达），按时间映射的存续
 *  命令集淘汰最旧。 */
export function recordHistoryMeta(
  meta: Readonly<Record<string, HistoryMetaRow>>,
  command: string,
  patch: Partial<HistoryMetaRow>,
  liveCommands: ReadonlySet<string>,
  limit = HISTORY_META_LIMIT,
): Record<string, HistoryMetaRow> {
  const trimmed = command.trim();
  if (!trimmed || !liveCommands.has(trimmed)) return { ...meta };
  const previous = meta[trimmed] ?? { durationMs: null, exitCode: null };
  const next: Record<string, HistoryMetaRow> = {};
  for (const [key, row] of Object.entries(meta)) {
    if (key !== trimmed && liveCommands.has(key)) next[key] = row;
  }
  next[trimmed] = {
    durationMs: patch.durationMs !== undefined ? patch.durationMs : previous.durationMs,
    exitCode: patch.exitCode !== undefined ? patch.exitCode : previous.exitCode,
  };
  const entries = Object.entries(next);
  if (entries.length <= limit) return next;
  return Object.fromEntries(entries.slice(-limit));
}

// —— 执行时间映射（pluginStore 键 ssh-command-history-times 的内存形态）——
// 并行结构而非改 commandHistory 形状：string[] 历史 suggestion/ghost/命令弹窗
// 多处消费，改造形状会波及全部调用点；时间只有面板用，单独一份数据零侵入。

/** 解析 localStorage/宿主档读回的时间映射：仅保留合法键值对并按容量截断。 */
export function sanitizeHistoryTimes(raw: unknown, limit = HISTORY_TIMES_LIMIT): Record<string, number> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  const rows: Array<[string, number]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { c, t } = item as { c?: unknown; t?: unknown };
    if (typeof c !== "string" || !c.trim() || typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
    rows.push([c, t]);
  }
  // 新记录在后（record 追加），容量淘汰取最新的 limit 条。
  for (const [command, ts] of rows.slice(-limit)) out[command] = ts;
  return out;
}

/** 记录一条执行时间：去重后追加，按时间淘汰最旧到上限。 */
export function recordHistoryTime(times: Readonly<Record<string, number>>, command: string, now: number, limit = HISTORY_TIMES_LIMIT): Record<string, number> {
  const trimmed = command.trim();
  if (!trimmed) return { ...times };
  const next: Record<string, number> = {};
  for (const [key, ts] of Object.entries(times)) {
    if (key !== trimmed) next[key] = ts;
  }
  next[trimmed] = now;
  const entries = Object.entries(next);
  if (entries.length <= limit) return next;
  return Object.fromEntries(entries.slice(-limit));
}

/** 持久化前修剪：历史环里已不存在的命令时间一并清掉。wire 形态为条目数组。 */
export function pruneHistoryTimes(times: Readonly<Record<string, number>>, history: readonly string[]): Array<{ c: string; t: number }> {
  const live = new Set(history);
  return Object.entries(times)
    .filter(([command]) => live.has(command))
    .map(([c, t]) => ({ c, t }));
}

// —— 分桶档（scope = 连接 id；本地/串口终端固定桶）——三个历史存储键保持
// 单键值内分桶（宿主 storage 无列键、按连接动态键不可声明，同
// ssh-docker-engine 先例）；旧版单映射档（裸数组）一次性迁入 legacyScope 桶。

export interface HistoryBucketOptions {
  /** 旧版全局档（升级前）的迁入目标桶。 */
  legacyScope: string;
}

export type HistoryTimesBuckets = Record<string, Record<string, number>>;
export type HistoryMetaBuckets = Record<string, Record<string, HistoryMetaRow>>;
/** 持久化 wire 形态（按作用域的条目数组）。 */
export type HistoryTimesWireBuckets = Record<string, Array<{ c: string; t: number }>>;
export type HistoryMetaWireBuckets = Record<string, Array<{ c: string; d: number | null; x: number | null }>>;

/** 解析分桶时间档：逐桶 sanitize；旧档（裸 [{c,t}] 数组）整体迁入 legacyScope。 */
export function sanitizeHistoryTimesBuckets(raw: unknown, options: HistoryBucketOptions, limit = HISTORY_TIMES_LIMIT): HistoryTimesBuckets {
  if (Array.isArray(raw)) {
    const legacy = sanitizeHistoryTimes(raw, limit);
    return Object.keys(legacy).length && options.legacyScope ? { [options.legacyScope]: legacy } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: HistoryTimesBuckets = {};
  for (const [scope, bucket] of Object.entries(raw)) {
    if (!scope.trim()) continue;
    const rows = sanitizeHistoryTimes(bucket, limit);
    if (Object.keys(rows).length) out[scope] = rows;
  }
  return out;
}

/** 解析分桶元数据档：逐桶 sanitize；旧档（裸 [{c,d,x}] 数组）整体迁入 legacyScope。 */
export function sanitizeHistoryMetaBuckets(raw: unknown, options: HistoryBucketOptions, limit = HISTORY_META_LIMIT): HistoryMetaBuckets {
  if (Array.isArray(raw)) {
    const legacy = sanitizeHistoryMeta(raw, limit);
    return Object.keys(legacy).length && options.legacyScope ? { [options.legacyScope]: legacy } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: HistoryMetaBuckets = {};
  for (const [scope, bucket] of Object.entries(raw)) {
    if (!scope.trim()) continue;
    const rows = sanitizeHistoryMeta(bucket, limit);
    if (Object.keys(rows).length) out[scope] = rows;
  }
  return out;
}

/** 持久化前修剪分桶时间档：每桶按本作用域命令环裁剪（wire 为条目数组），空桶丢弃。 */
export function pruneHistoryTimesBuckets(times: Readonly<HistoryTimesBuckets>, rings: Readonly<Record<string, readonly string[]>>): HistoryTimesWireBuckets {
  const out: HistoryTimesWireBuckets = {};
  for (const [scope, bucket] of Object.entries(times)) {
    const rows = pruneHistoryTimes(bucket, rings[scope] ?? []);
    if (rows.length) out[scope] = rows;
  }
  return out;
}

/** 持久化前过滤分桶元数据档：每桶只留本作用域命令环存续的条目，空桶丢弃。 */
export function persistableHistoryMetaBuckets(meta: Readonly<HistoryMetaBuckets>, rings: Readonly<Record<string, readonly string[]>>): HistoryMetaWireBuckets {
  const out: HistoryMetaWireBuckets = {};
  for (const [scope, bucket] of Object.entries(meta)) {
    const live = new Set(rings[scope] ?? []);
    const rows = Object.entries(bucket)
      .filter(([command]) => live.has(command))
      .map(([c, row]) => ({ c, d: row.durationMs, x: row.exitCode }));
    if (rows.length) out[scope] = rows;
  }
  return out;
}
