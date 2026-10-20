import { ref, type Ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import {
  dissolveQuickCommandGroup,
  loadQuickCommandsFromStore,
  migrateQuickCommandGroups,
  normalizeQuickCommands,
  persistQuickCommands,
  quickCommandText,
  renameQuickCommandGroup,
  upsertQuickCommand,
  type QuickCommand,
} from "../lib/quickCommands";
import { randomUUID } from "../lib/uuid";

/** 快速命令数据面（M32-A3 → 存储迁移批 1）：权威在 pluginStore（宿主
 * ui-storage.json，随 DBX secrets 同步加密上云）；sidecar
 * ssh/quickCommands/* 仅作首次运行的一次性搬迁种子（键缺失才搬，避免复活
 * 已清空清单）。编辑器/导入视图在 QuickCommandsSection（设置·终端），经
 * SettingsDialog 上抛意图；工具栏下拉状态仍在 App.vue。 */
export function useQuickCommands(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  commandRunning: Ref<boolean>;
  terminalTransferBusy: () => boolean;
  terminal: () => Terminal | undefined;
  trackPendingInput: (data: string) => void;
  sendTerminalBytes: (data: Uint8Array) => void;
  /** 程序化写入前消除 ghost 行内建议（issue #196）：写入不经 onData 路由，
   * 残留灰字会在回显 settle 后被重锚到底部光标行且不自动消失。 */
  hideGhostSuggestion: () => void;
}) {
  const { t, showNotice, session, commandRunning, terminalTransferBusy, terminal: terminalGet, trackPendingInput, sendTerminalBytes, hideGhostSuggestion } = options;

// 快速命令：用户自定义片段（≤200 条，issue #201），可选分组（组信息反规范
// 化在每条命令上，组视图由 lib 派生）。
const quickCommands = ref<QuickCommand[]>([]);
// 管理视图在途态（saving/importing 作为在途态传给设置节）。
const quickSaving = ref(false);
const quickImportBusy = ref(false);

// 水合顺序：pluginStore 权威值（host 档存量，含适配器从同名 localStorage 旧键
// 惰性搬家的值）→ 键缺失时从 sidecar 一次性搬迁（含空清单也要落键，标记
// "已迁移"）→ sidecar 不可用（旧版/降级）保留内存态兜底。
async function hydrateQuickCommands() {
  const stored = loadQuickCommandsFromStore();
  if (stored !== null) {
    quickCommands.value = stored;
    return;
  }
  try {
    const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/list");
    // 首次搬迁即做分组迁移（issue #201）：旧 sidecar 数据没有组字段，消毒
    // 后天然归入未分组，写回的 pluginStore 即新 schema。
    quickCommands.value = persistQuickCommands(migrateQuickCommandGroups(normalizeQuickCommands(response.commands)));
  } catch {
    // 后端不可用（如旧版 sidecar）：键未落，下次启动重试搬迁；内存态兜底。
  }
}

async function deleteQuickCommand(id: string) {
  quickCommands.value = persistQuickCommands(quickCommands.value.filter((item) => item.id !== id));
}

// 发送语义：快速命令是"在当前交互 shell 中执行"的片段（对齐 tiny-rdm），
// 必须走 PTY 写入——输出直接回显在终端里、cd/env 等状态留在当前 shell；
// ssh/exec 是独立非交互通道，不回显也不共享 shell 状态，不符合语义。
// 命令原文按键盘输入写入（用户可见可中断），不经过任何 shell 拼接转义。
// Run = 写入并回车执行；Paste = 只粘贴到命令行（不执行，可继续编辑）。
// 两种模式都不关弹窗（对齐 Termius：连续挑多条命令是高频操作，关窗会
// 打断流程）；手动 Esc/外点/再点工具栏按钮关闭。
function writeQuickCommand(item: QuickCommand, execute: boolean) {
  if (!session.value || terminalTransferBusy() || commandRunning.value) return;
  const text = quickCommandText(item.command);
  if (!text) return;
  // 写入不经过 onData（用户键入路由），ghost 门状态机不会推进——已 show 的
  // ghost 若不在此消除，回显 settle 后 syncGhostAnchorOnSettle 会把它重锚到
  // 新光标行（终端底部），灰字盖住光标行且不自消（issue #196）。与粘贴路径
  // interceptTerminalPaste 的 hideGhostSuggestion 同语义。
  hideGhostSuggestion();
  const payload = execute ? `${text}\r` : text;
  if (execute) trackPendingInput(payload);
  sendTerminalBytes(new TextEncoder().encode(payload));
  terminalGet()?.focus();
}
function sendQuickCommand(item: QuickCommand) {
  writeQuickCommand(item, true);
}
function pasteQuickCommand(item: QuickCommand) {
  writeQuickCommand(item, false);
}

// 一键 sudo -v：向当前交互终端按键盘语义写入 `sudo -v` + 回车（等价手敲执行），
// 立即刷新远端 sudo 凭据缓存；输出回显在终端，密码提示由用户/Quick Sudo 应答。
function sendSudoRefresh() {
  if (!session.value || terminalTransferBusy()) return;
  // 同 writeQuickCommand：程序化写入前消除 ghost（issue #196）。
  hideGhostSuggestion();
  trackPendingInput("sudo -v\r");
  sendTerminalBytes(new TextEncoder().encode("sudo -v\r"));
  terminalGet()?.focus();
}

/** 单条保存（新建/编辑共用）：id 缺省表示新建（前端生成 id）；名称兜底、
 * 截断与 200 条超限丢弃最旧由 upsertQuickCommand 维持（与原后端语义一致）。
 * groupId/groupName 可选：空组 id = 未分组（issue #201）。 */
async function saveQuickCommand(command: { id?: string; name: string; command: string; groupId?: string; groupName?: string }) {
  if (quickSaving.value) return;
  quickSaving.value = true;
  try {
    const entry: QuickCommand = {
      id: command.id ?? randomUUID(),
      name: command.name,
      command: command.command,
      ...(command.groupId?.trim() ? { groupId: command.groupId.trim(), groupName: command.groupName?.trim() || command.groupId.trim() } : {}),
    };
    quickCommands.value = persistQuickCommands(upsertQuickCommand(quickCommands.value, entry));
  } finally {
    quickSaving.value = false;
  }
}

/** 分组改名（issue #201）：批量回写组名后整表落盘。 */
async function renameQuickCommandGroupById(groupId: string, name: string) {
  if (!groupId.trim() || !name.trim()) return;
  quickCommands.value = persistQuickCommands(renameQuickCommandGroup(quickCommands.value, groupId.trim(), name.trim()));
}

/** 删除分组（issue #201）：组内命令移回未分组，命令本身保留。 */
async function dissolveQuickCommandGroupById(groupId: string) {
  if (!groupId.trim()) return;
  quickCommands.value = persistQuickCommands(dissolveQuickCommandGroup(quickCommands.value, groupId.trim()));
}

/** 批量导入：本地逐条 upsert（超限丢最旧，与单条保存同语义）后一次性落盘。 */
async function importQuickCommands(items: Array<{ name: string; command: string }>) {
  if (!items.length || quickImportBusy.value) return;
  quickImportBusy.value = true;
  try {
    let next = [...quickCommands.value];
    for (const item of items) {
      next = upsertQuickCommand(next, { id: randomUUID(), name: item.name, command: item.command });
    }
    quickCommands.value = persistQuickCommands(next);
    showNotice(t("quickCommandsImportDone", { count: items.length }));
  } finally {
    quickImportBusy.value = false;
  }
}


  return {
    quickCommands,
    quickSaving,
    quickImportBusy,
    hydrateQuickCommands,
    deleteQuickCommand,
    sendQuickCommand,
    pasteQuickCommand,
  sendSudoRefresh,
  saveQuickCommand,
  renameQuickCommandGroupById,
  dissolveQuickCommandGroupById,
  importQuickCommands,
  };
}
