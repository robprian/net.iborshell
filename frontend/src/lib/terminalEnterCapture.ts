// 终端回车行采集（history 面板数据源的兜底路径）：commandHistory 的既有
// 采集点（命令弹窗/建议自动执行/OSC 633 E 帧/批量发送）都覆盖不到「用户在
// 终端提示符下手动敲命令回车」——SSH 会话远端没有 shell integration 时 E 帧
// 不存在，直接键入的命令从不入史（此前按"真实降级"有意不做）。这里补上
// 回车点的纯判定：门过滤 + 回显对照。安全底线是凭据类输入（sudo/ssh/su
// 密码提示等关回显场景）绝不入史——对照失败的行宁可漏采（Tab 补全/方向键
// 编辑会让模型行失真），不能错采。

// 回车执行点（Ctrl+C 是清行不是执行）：远端未装 shell integration 的
// SSH 会话没有 OSC 633 E 帧，手动键入的命令只有这里能入 commandHistory
// （↑ history 面板的数据源）。门过滤 + 回显对照见 lib/terminalEnterCapture.ts。

import { isAuthChallengeLine, isSelectionPromptLine } from "./interactivePromptGuard";
import { isPasswordPromptLine } from "./terminalPromptHints";

/** 回车采集的门条件（调用方逐项传入，保持纯函数可测）。 */
export interface EnterCaptureGates {
  /** xterm alternate buffer（vim/tmux/htop 等整屏程序，回车是交互不是命令）。 */
  alternateActive: boolean;
  /** zmodem/trzsz/串口上传等传输占用输入流。 */
  transferBusy: boolean;
  /** OSC 633 E..D 之间（有 shell integration 时命令运行中；无则恒 false）。 */
  shellCommandActive: boolean;
}

/** 回车行是否值得尝试采集：空行、整屏程序、传输占用、命令运行中一律不采。 */
export function canCaptureEnterLine(line: string, gates: EnterCaptureGates): boolean {
  return Boolean(line.trim()) && !gates.alternateActive && !gates.transferBusy && !gates.shellCommandActive;
}

/**
 * 回显对照：模型行（pendingTerminalInput 累积的键入）必须原样出现在光标前
 * 的屏幕文本中。回显是「这不是密码提示」的证据——shell 关闭回显时（密码、
 * read -s）屏幕上不会有这些字符，此时拒采。null = 屏幕不可测（测试环境/
 * 渲染器未就绪），放行走保守降级（与没有该防线时的旧行为一致）。
 */
export function echoConfirmsLine(echoText: string | null, line: string): boolean {
  if (echoText === null) return true;
  return Boolean(line.trim()) && echoText.includes(line);
}

/**
 * 从屏幕回显文本提取真实执行的命令（issue #169）：模型行只是键入前缀，
 * Tab 补全/历史展开由 shell 在回显里改写（键入 `cd blen` + Tab，屏幕是
 * `user@h:~$ cd blender/`，模型停在 `cd blen`）。提取法：以 trim 后的模型行
 * 在屏幕文本中的首次出现位置为锚（提示符在前、命令在后，首次出现即命令区
 * 起点；对照门已保证它是子串），取锚点到光标（屏幕文本末尾）——即 shell
 * 实际要执行的行。定位失败（理论上门已挡，防御）返回 null，调用方回落
 * 模型行，不劣于旧行为。
 */
export function extractEchoedCommand(echoText: string | null, line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (echoText === null) return null;
  const anchor = echoText.indexOf(trimmed);
  if (anchor < 0) return null;
  const extracted = echoText.slice(anchor).trim();
  return extracted || null;
}

// —— 模型失真回退采集（issue #192）——键入模型在两类高频操作后与真实行失
// 真，echoConfirmsLine 一律拒采，表现为 cp/mv（Tab 补全路径后继续键入）与
// sh 脚本（↑ 召回再改参数）永不入史：
// - Tab（0x09）不进模型，补全插入段丢失——此后键入的字符全部追加在过期前缀
//   上，模型行永远不是屏幕行的子串（#169 的提取法只覆盖「Tab 后立即回车」）；
// - ESC 序列块（↑ 召回 / Home / End / 方向键移动）被整块跳过，模型停在空或
//   陈旧行上。
// 回退策略以屏幕为唯一事实源，证据分两级：
// - rewritePrefix：首个行改写事件时的模型行——改写前的键入都已回显，它与真
//   实行共享前缀，可作命令区起点的高质量锚；
// - rewriteProof：末次行改写事件后键入的可见字符——它必须原样出现在光标逻
//   辑行里，这是「shell 在回显」的活性证明（sudo/ssh 密码提示关回显，键入
//   永不上屏，必然失配而拒采）。
export interface LineRewriteState {
  /** 首个行改写事件时的模型行（trim 后；空 = 改写发生在行首，如 ↑ 召回）。 */
  prefix: string;
  /** 末次行改写事件后键入的可见字符（回显活性证据；退格同步削尾）。 */
  proof: string;
}

/**
 * 行改写追踪器（App.vue trackPendingInput 逐键喂入）：纯状态无副作用，单测
 * 可直接模拟「键入 → Tab/↑ 改写 → 继续键入 → 回车」的完整轨迹。snapshot()
 * 给 extractDesyncedCommand 提供证据；回车/Ctrl+C 后 reset() 开新行。
 */
export class EnterLineTracker {
  private seen = false;
  private prefix = "";
  private proof = "";

  snapshot(): LineRewriteState {
    return { prefix: this.prefix, proof: this.proof };
  }

  /** shell 行改写事件：Tab 补全 / ESC 序列块（↑ 召回、光标移动）/ 未认领控
   *  制字节。首个事件时的模型行与真实行共享前缀，存为提取锚。 */
  noteRewrite(modelLine: string): void {
    if (!this.seen) {
      this.seen = true;
      this.prefix = modelLine.trim();
    }
    this.proof = "";
  }

  /** 可见字符键入：改写事件后的键入累积为回显活性证据。 */
  notePrintable(character: string): void {
    if (this.seen) this.proof += character;
  }

  /** 退格：模型与屏幕同步失去该字符，证据尾巴同步削。 */
  noteBackspace(): void {
    this.proof = this.proof.slice(0, -1);
  }

  /** 回车采集完成 / Ctrl+C 放弃：行结束，全部复位。 */
  reset(): void {
    this.seen = false;
    this.prefix = "";
    this.proof = "";
  }
}

/** 提示符定界符（prompt 尾字符）+ 空白：命令区起点判定。字符类刻意收窄到
 *  $ # % > 四类（bash/zsh/fish/oh-my-zsh 常见形态），不收 ( ) 与 ] ——venv
 *  前缀 "(venv) " 与函数定义 "f() " 的定界语义由「最后一个匹配」规则天然
 *  规避（提示符末尾的 $/# 永远晚于它们出现在同一行）。 */
const PROMPT_DELIMITER = /[$#%>][ \t]/g;

/** 凭据/选择/搜索 UI 提示启发闸：回退路径的第二道防线。proof 证据失灵
 *  （如 prompt 文本本身包含 proof 片段）时，形态判定兜住密码/口令/选择行，
 *  绝不把提示行当命令入史。凭据/选择复用 #150 的提示判定（同源词表，见
 *  promptCorpus.spec）；readline 反向搜索 UI 行（Ctrl+R 搜索/接受瞬间）无
 *  命令语义，一并拒采（issue #192 回退路径不得引入新垃圾形态）。 */
function looksLikeNonCommandLine(text: string): boolean {
  if (/\((?:reverse|fwd)-i-search\)/i.test(text)) return true;
  return isPasswordPromptLine(text) || isAuthChallengeLine(text) || isSelectionPromptLine(text);
}

/**
 * 失真回退提取：模型行与屏幕失配时（Tab 补全后继续键入、↑ 召回后编辑），
 * 从光标逻辑行直接提取完整命令。锚点优先 rewritePrefix（首次出现——前缀在
 * 命令区开头），缺失或失配时回落 rewriteProof（最后出现——proof 是最后键入
 * 的，行内更早的同形文本都在它前面）；锚点左侧最后一个提示符定界符之后即
 * 命令。返回 null = 拒采（宁可漏采）：屏幕不可测、proof 为空（纯 ↑ 召回直
 * 接回车，无任何键入证据）、proof 未上屏（关回显的凭据输入）、提示行形态
 * 命中凭据/选择启发。
 */
export function extractDesyncedCommand(echoText: string | null, rewrite: LineRewriteState): string | null {
  if (echoText === null) return null;
  const proof = rewrite.proof.trim();
  if (!proof || !echoText.includes(proof)) return null;
  const prefix = rewrite.prefix.trim();
  let anchor = -1;
  if (prefix && echoText.includes(prefix)) anchor = echoText.indexOf(prefix);
  else anchor = echoText.lastIndexOf(proof);
  if (anchor < 0) return null;
  const head = echoText.slice(0, anchor);
  PROMPT_DELIMITER.lastIndex = 0;
  let start = 0;
  for (let match = PROMPT_DELIMITER.exec(head); match; match = PROMPT_DELIMITER.exec(head)) {
    start = match.index + match[0].length;
  }
  const extracted = echoText.slice(start).trim();
  if (!extracted || looksLikeNonCommandLine(echoText)) return null;
  return extracted;
}

// —— 续行合并（issue #192 多行/续行场景）——反斜杠续行命令（cp 长路径、
// 多行管道）按物理行逐次回车采集会碎成多条；与远端历史文件导入的
// parseShellHistoryText 同语义：尾奇数反斜杠 = 续行，暂存待下一行拼接。

/** 尾部是否为奇数个反斜杠（偶数个是字面量转义，不是续行）。 */
export function endsWithLineContinuation(command: string): boolean {
  return (/\\+$/.exec(command)?.[0].length ?? 0) % 2 === 1;
}

/**
 * 续行状态机的一步：pending 为空时，command 尾奇反斜杠则暂存（entry 为
 * null，不入史），否则原样入史；pending 非空时先拼接（暂存已去续行反斜杠、
 * 保留尾空格），拼完仍续行则继续暂存。 */
export function acceptCommandWithContinuation(pending: string, command: string): { entry: string | null; pending: string } {
  const joined = pending + command;
  if (endsWithLineContinuation(joined)) return { entry: null, pending: joined.slice(0, -1) };
  return { entry: joined.trim() || null, pending: "" };
}
