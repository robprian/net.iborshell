// 快速命令栏：用户自定义常用命令片段（对标 tiny-rdm 快速命令）。
// 权威存储 pluginStore（宿主 ui-storage.json，随 DBX secrets 同步加密上云；
// IMPL_PLAN_STORAGE_SYNC 批 1）：同名 localStorage 旧数据由适配器惰性搬家
// 接住，sidecar quick_commands.json 经 RPC 仅作一次性迁移种子。纯函数 +
// 显式存取，上限 200 条（issue #201：20 条不够用）。
// 分组（issue #201）：组信息反规范化在每条命令上（groupId + groupName），
// 组清单由命令派生（groupQuickCommands）——空组自然消失，schema 保持扁平；
// 未分组是 groupId 为空串的虚拟组，旧数据经迁移函数自动归入。

import { pluginStore } from "./pluginStore";
import { normalizeTerminalInputText } from "./terminalInput";

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  /** 所属分组 id（可选；空/缺省 = 未分组）。 */
  groupId?: string;
  /** 分组显示名（随命令反规范化存储；改名时批量回写）。 */
  groupName?: string;
}

export const QUICK_COMMANDS_LIMIT = 200;
export const QUICK_COMMAND_NAME_MAX_LENGTH = 60;
export const QUICK_COMMAND_TEXT_MAX_LENGTH = 500;
export const QUICK_COMMAND_GROUP_NAME_MAX_LENGTH = 40;
export const QUICK_COMMAND_GROUP_ID_MAX_LENGTH = 80;
/** 未分组虚拟组 id：groupId 为空串或缺省都算未分组。 */
export const QUICK_COMMANDS_UNGROUPED_ID = "";

/** pluginStore 键：与 localStorage 时代同名（适配器惰性搬家依赖同名接力）。 */
export const QUICK_COMMANDS_STORE_KEY = "ssh-quick-commands";

/**
 * 从 pluginStore 读权威清单；返回 null 表示键尚不存在（未迁移，调用方应走
 * sidecar 种子搬迁）。存在但为空数组是合法用户态（已清空），不触发搬迁。
 */
export function loadQuickCommandsFromStore(): QuickCommand[] | null {
  try {
    const raw = pluginStore.getItem(QUICK_COMMANDS_STORE_KEY);
    if (raw === null) return null;
    return normalizeQuickCommands(JSON.parse(raw));
  } catch {
    // 坏 JSON 视为空清单：不回退种子（键已存在 = 已迁移，避免复活旧数据）。
    return [];
  }
}

/** 全量写穿 pluginStore（空数组同样落键，标记"已迁移"）。 */
export function persistQuickCommands(list: readonly QuickCommand[]): QuickCommand[] {
  const normalized = normalizeQuickCommands(list);
  try {
    pluginStore.setItem(QUICK_COMMANDS_STORE_KEY, JSON.stringify(normalized));
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
  return normalized;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidId(value: string): boolean {
  return value.length > 0 && value.length <= 80;
}

/** 解析 localStorage 读回的快速命令：非法项丢弃、字段截断、按 id 去重、超限截断；
 *  组字段（groupId/groupName）同步消毒——组 id 截断，组名缺省回落组 id，
 *  两者都缺 = 未分组（不落组字段，保持旧 JSON 形态）。 */
export function normalizeQuickCommands(raw: unknown, limit = QUICK_COMMANDS_LIMIT): QuickCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: QuickCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = nonEmptyString(record.id);
    const command = nonEmptyString(record.command).slice(0, QUICK_COMMAND_TEXT_MAX_LENGTH);
    if (!isValidId(id) || !command || seen.has(id)) continue;
    seen.add(id);
    const name = (nonEmptyString(record.name) || command).slice(0, QUICK_COMMAND_NAME_MAX_LENGTH);
    const groupId = nonEmptyString(record.groupId).slice(0, QUICK_COMMAND_GROUP_ID_MAX_LENGTH);
    const groupName = nonEmptyString(record.groupName).slice(0, QUICK_COMMAND_GROUP_NAME_MAX_LENGTH);
    out.push(groupId ? { id, name, command, groupId, groupName: groupName || groupId } : { id, name, command });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 旧数据迁移（issue #201）：#201 之前的清单条目没有组字段，读回后天然属于
 * 「未分组」。迁移即消毒重排——统一走 normalizeQuickCommands，把残留的
 * 非法/残缺组字段收敛为合法形态（有组 id 缺组名 → 组名回落组 id；组字段
 * 类型不对 → 归未分组），调用方把返回值写回存储即完成一次性升级。
 */
export function migrateQuickCommandGroups(raw: unknown): QuickCommand[] {
  return normalizeQuickCommands(raw);
}

export interface QuickCommandGroupView {
  id: string;
  name: string;
  commands: QuickCommand[];
}

/**
 * 派生分组视图：按 groupId 聚组、保持清单首现顺序；未分组（空 id）恒排
 * 最前，组名取组内首条的 groupName。id 为空时 name 由调用方以本地化文案
 * 替换（lib 不引 i18n）。
 */
export function groupQuickCommands(list: readonly QuickCommand[]): QuickCommandGroupView[] {
  const groups = new Map<string, QuickCommandGroupView>();
  for (const item of list) {
    const id = item.groupId ?? QUICK_COMMANDS_UNGROUPED_ID;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: item.groupName ?? "", commands: [] };
      groups.set(id, group);
    }
    group.commands.push(item);
  }
  const views = [...groups.values()];
  views.sort((a, b) => (a.id === QUICK_COMMANDS_UNGROUPED_ID ? -1 : b.id === QUICK_COMMANDS_UNGROUPED_ID ? 1 : 0));
  return views;
}

/** 分组改名：批量回写该组全部条目的 groupName（id 相同即同组）。 */
export function renameQuickCommandGroup(list: readonly QuickCommand[], groupId: string, name: string): QuickCommand[] {
  const trimmed = name.trim().slice(0, QUICK_COMMAND_GROUP_NAME_MAX_LENGTH);
  if (!groupId || !trimmed) return [...list];
  return list.map((item) => (item.groupId === groupId ? { ...item, groupName: trimmed } : item));
}

/** 删除分组：该组命令移回未分组（清掉组字段），命令本身保留。 */
export function dissolveQuickCommandGroup(list: readonly QuickCommand[], groupId: string): QuickCommand[] {
  if (!groupId) return [...list];
  return list.map((item) => {
    if (item.groupId !== groupId) return item;
    const { groupId: _dropId, groupName: _dropName, ...rest } = item;
    return rest as QuickCommand;
  });
}

/** 新增或按 id 更新；已存在则原位更新，新条目追加到末尾，超限时丢弃最旧的（队首）。
 *  组字段随条目保存：groupId 空/缺省 = 未分组，组名缺省回落组 id。 */
export function upsertQuickCommand(list: QuickCommand[], item: QuickCommand, limit = QUICK_COMMANDS_LIMIT): QuickCommand[] {
  const command = item.command.trim();
  if (!command) return [...list];
  const groupId = item.groupId?.trim().slice(0, QUICK_COMMAND_GROUP_ID_MAX_LENGTH) ?? "";
  const groupName = item.groupName?.trim().slice(0, QUICK_COMMAND_GROUP_NAME_MAX_LENGTH) ?? "";
  const entry: QuickCommand = {
    id: item.id,
    name: (item.name.trim() || command).slice(0, QUICK_COMMAND_NAME_MAX_LENGTH),
    command: command.slice(0, QUICK_COMMAND_TEXT_MAX_LENGTH),
    ...(groupId ? { groupId, groupName: groupName || groupId } : {}),
  };
  const index = list.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return next;
  }
  return [...list, entry].slice(-limit);
}

/** 按 id 移除；id 不存在时返回等价副本。 */
export function removeQuickCommand(list: QuickCommand[], id: string): QuickCommand[] {
  return list.filter((item) => item.id !== id);
}

/** 名称/命令的大小写不敏感子串过滤；空查询返回全量。 */
export function filterQuickCommands(
  list: readonly QuickCommand[],
  query: string,
): QuickCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...list];
  return list.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) ||
      item.command.toLowerCase().includes(needle) ||
      (item.groupName ?? "").toLowerCase().includes(needle),
  );
}

/** 计数视图（issue #201）：组数（未分组不计）+ 命令条数。 */
export function quickCommandGroupCount(list: readonly QuickCommand[]): number {
  return new Set(list.map((item) => item.groupId ?? QUICK_COMMANDS_UNGROUPED_ID).filter((id) => id !== QUICK_COMMANDS_UNGROUPED_ID)).size;
}

/**
 * 写入终端的命令文本：保留多行结构，并把换行统一成 PTY 的 Enter
 * （Run/Paste 共用）。保留换行对反斜杠续行尤其重要；折叠为空格会把
 * `command \\` 变成带转义空格的错误命令。
 */
export function quickCommandText(command: string): string {
  return normalizeTerminalInputText(command).trim();
}
