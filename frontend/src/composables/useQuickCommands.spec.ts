// @vitest-environment happy-dom
// Issue #196 回归：快捷指令是程序化 PTY 写入，不经 onData 路由——ghost 行内
// 建议若在场，残留灰字会在回显 settle 后被 syncGhostAnchorOnSettle 重锚到
// 底部光标行且不自动消失（用户报障「最下面有个文字挡住了当前的光标行」）。
// 本文件用真实 useGhostSuggest + useQuickCommands 复现状态残留：ghost 在场时
// 执行/粘贴快捷指令与 sudo -v 刷新都必须先消除 ghost（与粘贴路径
// interceptTerminalPaste 同语义）。
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useQuickCommands } from "./useQuickCommands";
import { useGhostSuggest } from "./useGhostSuggest";

/** 最小 xterm buffer 桩：光标在 (0, 6)，光标行右侧全空、无下折行 → 行尾。 */
function fakeTerminal() {
  const emptyRow = { getCell: () => ({ getChars: () => "" }) };
  return {
    focus: () => undefined,
    cols: 80,
    buffer: {
      active: {
        type: "normal",
        cursorX: 6,
        cursorY: 0,
        viewportY: 0,
        baseY: 0,
        getLine: (y: number) => (y === 0 ? emptyRow : undefined),
      },
    },
  } as unknown as Terminal;
}

function setupHarness() {
  const term = fakeTerminal();
  const sent: string[] = [];
  const line = ref("");
  const commandHistory = ref<string[]>(["git status"]);
  const commandRunning = ref(false);

  const ghost = useGhostSuggest({
    terminal: () => term,
    sendTerminalBytes: (data) => sent.push(new TextDecoder().decode(data)),
    getPendingTerminalInput: () => line.value,
    appendToPendingTerminalInput: (data) => { line.value += data; },
    commandRunning,
    terminalTransferBusy: ref(false),
    commandHistory,
    quickCommands: ref([]),
    suggestionOpen: ref(false),
    isInteractivePromptPending: () => false,
    completionController: { lineChanged: () => undefined },
    suggestionMinCharsState: ref(3),
    suggestionMaxCharsState: ref(200),
    readTerminalCellFrame: () => ({ originLeft: 0, originTop: 0, cursorX: line.value.length, visibleRow: 0, cellWidth: 8, cellHeight: 16 }),
  });
  // iBorShell 1.0.3: ghost suggestions default OFF (opt-in) — this suite
  // exercises ghost behavior, so enable it explicitly.
  ghost.setGhostEnabled(true);

  const session = ref<{ sessionId?: string } | undefined>({ sessionId: "s1" });
  const qc = useQuickCommands({
    t: (key) => key,
    showNotice: () => undefined,
    showError: () => undefined,
    session,
    commandRunning,
    terminalTransferBusy: () => false,
    terminal: () => term,
    trackPendingInput: (data) => {
      // 与 App.trackPendingInput 同模型：\r 清行，其余追加。
      for (const character of data) {
        if (character === "\r" || character === "\n" || character === "\u0003") line.value = "";
        else if (character >= " ") line.value += character;
      }
    },
    sendTerminalBytes: (data) => sent.push(new TextDecoder().decode(data)),
    hideGhostSuggestion: ghost.hideGhostSuggestion,
  });

  /** 模拟用户逐键键入前缀（onData → refreshGhostAfterInput 同步推进模型行）。 */
  function typePrefix(prefix: string) {
    for (const character of prefix) {
      line.value += character;
      ghost.refreshGhostAfterInput(character);
    }
  }

  return { ghost, qc, sent, line, commandHistory, session, typePrefix };
}

describe("useQuickCommands programmatic writes dismiss the ghost (issue #196)", () => {
  it("ghost shows for a typed prefix before the quick command runs", () => {
    const { ghost, typePrefix } = setupHarness();
    typePrefix("git st");
    expect(ghost.ghostMatch.value).toEqual({ command: "git status", remainder: "atus" });
  });

  it("run (写入并回车) hides the in-flight ghost instead of leaving residue", () => {
    const { ghost, qc, sent, typePrefix } = setupHarness();
    typePrefix("git st");
    expect(ghost.ghostMatch.value).not.toBeNull();

    qc.sendQuickCommand({ id: "1", name: "GS", command: "git status" });

    // 残留复现点：修复前 ghostMatch 仍在场，settle 后灰字重锚到底部光标行不消失。
    expect(ghost.ghostMatch.value).toBeNull();
    expect(sent).toEqual(["git status\r"]);
  });

  it("paste (只粘贴不执行) also hides the ghost", () => {
    const { ghost, qc, sent, typePrefix } = setupHarness();
    typePrefix("git st");
    expect(ghost.ghostMatch.value).not.toBeNull();

    qc.pasteQuickCommand({ id: "1", name: "GS", command: "git status" });

    expect(ghost.ghostMatch.value).toBeNull();
    expect(sent).toEqual(["git status"]);
  });

  it("sudo -v refresh hides the ghost too", () => {
    const { ghost, qc, sent, typePrefix } = setupHarness();
    typePrefix("git st");
    expect(ghost.ghostMatch.value).not.toBeNull();

    qc.sendSudoRefresh();

    expect(ghost.ghostMatch.value).toBeNull();
    expect(sent).toEqual(["sudo -v\r"]);
  });

  it("no session → nothing is sent and the ghost is left alone", () => {
    const { ghost, qc, sent, session, typePrefix } = setupHarness();
    typePrefix("git st");
    expect(ghost.ghostMatch.value).not.toBeNull();
    session.value = undefined;

    qc.sendQuickCommand({ id: "1", name: "GS", command: "git status" });

    expect(sent).toEqual([]);
    expect(ghost.ghostMatch.value).not.toBeNull();
  });
});
