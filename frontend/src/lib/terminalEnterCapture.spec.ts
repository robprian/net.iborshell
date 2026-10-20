// 回车行兜底采集的纯判定测试：门过滤（空行/整屏程序/传输占用/命令运行中）
// 与回显对照（关回显的凭据输入绝不放行；屏幕含模型行才放行；屏幕不可测放行）
// 及回显提取（issue #169：Tab 补全后的真实命令以屏幕为准）。
// issue #192 增补：键入轨迹模拟（EnterLineTracker）驱动失真回退提取
// （extractDesyncedCommand）——Tab 补全后继续键入 / ↑ 召回后编辑的行，模型
// 与屏幕失配，改以改写前缀锚 + 键入尾巴回显证据从屏幕提取；以及续行合并
// （acceptCommandWithContinuation）。全部为纯终端帧文本模拟，不连 SSH。
// 对应 App.vue trackPendingInput 回车分支 → captureEnterLine 的接线。
import { describe, expect, it } from "vitest";
import {
  EnterLineTracker,
  acceptCommandWithContinuation,
  canCaptureEnterLine,
  echoConfirmsLine,
  endsWithLineContinuation,
  extractDesyncedCommand,
  extractEchoedCommand,
  type EnterCaptureGates,
} from "./terminalEnterCapture";

const openGates: EnterCaptureGates = { alternateActive: false, transferBusy: false, shellCommandActive: false };

describe("canCaptureEnterLine", () => {
  it("accepts a normal typed command at the prompt", () => {
    expect(canCaptureEnterLine("kubectl get pods", openGates)).toBe(true);
  });

  it("rejects blank lines (enter on an empty prompt)", () => {
    expect(canCaptureEnterLine("", openGates)).toBe(false);
    expect(canCaptureEnterLine("   ", openGates)).toBe(false);
  });

  it("rejects alternate-buffer programs (vim/tmux/htop own the enter key)", () => {
    expect(canCaptureEnterLine(":wq", { ...openGates, alternateActive: true })).toBe(false);
  });

  it("rejects while a transfer owns the input stream", () => {
    expect(canCaptureEnterLine("ls", { ...openGates, transferBusy: true })).toBe(false);
  });

  it("rejects while shell integration reports a running command (E..D frames)", () => {
    expect(canCaptureEnterLine("y", { ...openGates, shellCommandActive: true })).toBe(false);
  });
});

describe("echoConfirmsLine", () => {
  it("passes through when the screen is unreadable (conservative fallback)", () => {
    expect(echoConfirmsLine(null, "ls -la")).toBe(true);
  });

  it("accepts when the screen echoes the model line inside the prompt line", () => {
    expect(echoConfirmsLine("user@host:~$ kubectl get pods", "kubectl get pods")).toBe(true);
  });

  it("accepts tab-completion lines: the screen extends the typed prefix", () => {
    expect(echoConfirmsLine("user@host:~$ ls file.txt", "ls ")).toBe(true);
  });

  it("accepts wrapped commands: the logical line collects continuation rows", () => {
    expect(echoConfirmsLine("echo 'long command ' + 'continues here'", "echo 'long command ' + 'continues here'")).toBe(true);
  });

  it("rejects hidden-input prompts (sudo/ssh password never echoes)", () => {
    expect(echoConfirmsLine("[sudo] password for jin:", "MyS3cret!")).toBe(false);
    expect(echoConfirmsLine("jin@host's password:", "hunter2")).toBe(false);
  });

  it("rejects blank model lines even when the screen has text", () => {
    expect(echoConfirmsLine("user@host:~$ ", "")).toBe(false);
  });
});

describe("extractEchoedCommand (issue #169: capture what the shell actually runs)", () => {
  it("returns the completed command, not the typed prefix", () => {
    // 键入 `cd blen` + Tab：模型停在 `cd blen`，屏幕上已是补全结果。
    expect(extractEchoedCommand("user@host:~$ cd blender/", "cd blen")).toBe("cd blender/");
  });

  it("returns the model line as-is when nothing extended it", () => {
    expect(extractEchoedCommand("user@host:~$ kubectl get pods", "kubectl get pods")).toBe("kubectl get pods");
  });

  it("anchors at the first occurrence so prompt text before the command is dropped", () => {
    expect(extractEchoedCommand("user@host:~$ ls file.txt", "ls ")).toBe("ls file.txt");
  });

  it("trims trailing whitespace the completion left before the cursor", () => {
    expect(extractEchoedCommand("user@host:~$ git status  ", "git status")).toBe("git status");
  });

  it("falls back to null when the screen is unreadable (caller keeps the model line)", () => {
    expect(extractEchoedCommand(null, "ls -la")).toBeNull();
  });

  it("falls back to null on blank model lines", () => {
    expect(extractEchoedCommand("user@host:~$ ", "")).toBeNull();
    expect(extractEchoedCommand("user@host:~$ ", "   ")).toBeNull();
  });

  it("defensively returns null when the line is not on the screen (gate should have rejected)", () => {
    expect(extractEchoedCommand("user@host:~$ something else", "kubectl get pods")).toBeNull();
  });
});

// —— issue #192：失真回退采集（键入轨迹模拟）——tracker 按真实键入顺序喂
// 字符 / Tab（\t）/ ↑ 召回（ESC 块），屏幕行文本模拟回显帧；断言从屏幕提取
// 的命令就是 shell 实际执行的那条。
describe("extractDesyncedCommand (issue #192: capture after the model desyncs)", () => {
  /** 轨迹辅助：模拟逐字符键入（\t = Tab 改写事件，up 场景直接调 noteRewrite）。
   *  模型与 App.vue trackPendingInput 同语义：Tab 不进模型（补全插入段丢失），
   *  可见字符照常追加并喂给回显证据。 */
  function typeSequence(tracker: EnterLineTracker, sequence: string) {
    let model = "";
    for (const character of sequence) {
      if (character === "\t") tracker.noteRewrite(model);
      else {
        model += character;
        tracker.notePrintable(character);
      }
    }
  }

  it("captures `sh deploy.sh` typed as `sh dep` + Tab + args (sh script entry command)", () => {
    const tracker = new EnterLineTracker();
    // 键入 sh dep → Tab 补全为 sh deploy.sh → 继续键入参数 → 回车。模型把
    // Tab 插入段丢了（"sh dep --check"），屏幕是真实命令行。
    typeSequence(tracker, "sh dep\t --check");
    const echo = "user@host:~$ sh deploy.sh --check";
    expect(echoConfirmsLine(echo, "sh dep --check")).toBe(false);
    expect(extractDesyncedCommand(echo, tracker.snapshot())).toBe("sh deploy.sh --check");
  });

  it("captures a cp with two Tab-completed paths (the reported miss)", () => {
    const tracker = new EnterLineTracker();
    // 键入 cp ~/Des → Tab（→~/Desktop/）→ re → Tab（→report.txt）→ 空格
    // ~/Doc → Tab（→~/Documents/）→ b → Enter。模型把每段补全插入都丢了。
    typeSequence(tracker, "cp ~/Des\tre\t ~/Doc\tb");
    const echo = "user@host:~$ cp ~/Desktop/report.txt ~/Documents/b";
    expect(echoConfirmsLine(echo, "cp ~/Desre ~/Docb")).toBe(false);
    expect(extractDesyncedCommand(echo, tracker.snapshot())).toBe("cp ~/Desktop/report.txt ~/Documents/b");
  });

  it("captures a mv whose middle argument was Tab-completed", () => {
    const tracker = new EnterLineTracker();
    typeSequence(tracker, "mv logs\t app\tx");
    const echo = "user@host:~$ mv logs/archive.tar.gz app/x";
    expect(extractDesyncedCommand(echo, tracker.snapshot())).toBe("mv logs/archive.tar.gz app/x");
  });

  it("captures an edited recall: ↑ then append arguments (no prefix anchor, proof only)", () => {
    const tracker = new EnterLineTracker();
    tracker.noteRewrite(""); // ↑ 召回：模型空，readline 改写整行
    typeSequence(tracker, " --dry-run");
    const echo = "user@host:~$ sh deploy.sh --dry-run";
    expect(extractDesyncedCommand(echo, tracker.snapshot())).toBe("sh deploy.sh --dry-run");
  });

  it("rejects a bare ↑ recall pressed straight into Enter (no typed proof, prefer missing)", () => {
    const tracker = new EnterLineTracker();
    tracker.noteRewrite("");
    expect(extractDesyncedCommand("user@host:~$ sh deploy.sh", tracker.snapshot())).toBeNull();
  });

  it("never captures hidden-input credentials: the typed proof never echoes", () => {
    const tracker = new EnterLineTracker();
    typeSequence(tracker, "hunter2!");
    expect(extractDesyncedCommand("[sudo] password for jin:", tracker.snapshot())).toBeNull();
    expect(extractDesyncedCommand("jin@host's password:", tracker.snapshot())).toBeNull();
  });

  it("rejects readline reverse-search UI lines even when the proof is on screen", () => {
    const tracker = new EnterLineTracker();
    // Ctrl+R（未认领控制字节 → 改写事件）后键入的搜索词回显在搜索 UI 行里，
    // 形态不是命令——拒绝，绝不把 "(reverse-i-search)`cp': cp a b" 入史。
    tracker.noteRewrite("");
    typeSequence(tracker, "cp");
    expect(extractDesyncedCommand("(reverse-i-search)`cp': cp a b", tracker.snapshot())).toBeNull();
  });

  it("rejects selection/auth prompt shapes even when the proof happens to be on screen", () => {
    const tracker = new EnterLineTracker();
    typeSequence(tracker, "y");
    // 宝塔式菜单行回显了键入，但形态是选择提示——不是命令，不入史。
    expect(extractDesyncedCommand("请选择操作 (y/n): y", tracker.snapshot())).toBeNull();
    typeSequence(tracker, "123456");
    expect(extractDesyncedCommand("请输入验证码: 123456", tracker.snapshot())).toBeNull();
  });

  it("rejects when the screen is unreadable (no evidence at all on the fallback path)", () => {
    const tracker = new EnterLineTracker();
    typeSequence(tracker, "cp a\tb");
    expect(extractDesyncedCommand(null, tracker.snapshot())).toBeNull();
  });

  it("keeps venv-style prompts intact: the last prompt delimiter wins over '(venv) '", () => {
    const tracker = new EnterLineTracker();
    typeSequence(tracker, "pytest -k s\t_and_fast");
    const echo = "(venv) user@host:~$ pytest -k slow_and_fast";
    expect(extractDesyncedCommand(echo, tracker.snapshot())).toBe("pytest -k slow_and_fast");
  });

  it("anchors at the typed prefix so redirects typed before Tab stay inside the command", () => {
    const tracker = new EnterLineTracker();
    typeSequence(tracker, "ls > ou\ttput.txt");
    const echo = "user@host:~$ ls > output.txt";
    expect(extractDesyncedCommand(echo, tracker.snapshot())).toBe("ls > output.txt");
  });
});

// —— issue #192：反斜杠续行合并 ——与远端历史文件导入 parseShellHistoryText
// 同语义：尾奇数反斜杠 = 续行暂存，下一行回车拼接成一条入史。
describe("acceptCommandWithContinuation (issue #192: multi-line commands)", () => {
  it("stashes a trailing-continuation line instead of recording a fragment", () => {
    expect(acceptCommandWithContinuation("", "cp a \\")).toEqual({ entry: null, pending: "cp a " });
  });

  it("joins the continuation into one entry", () => {
    expect(acceptCommandWithContinuation("cp a ", "b")).toEqual({ entry: "cp a b", pending: "" });
  });

  it("chains three physical lines into one command", () => {
    const first = acceptCommandWithContinuation("", "echo one \\");
    expect(first.entry).toBeNull();
    const second = acceptCommandWithContinuation(first.pending, "two \\");
    expect(second.entry).toBeNull();
    const third = acceptCommandWithContinuation(second.pending, "three");
    expect(third).toEqual({ entry: "echo one two three", pending: "" });
  });

  it("records even trailing backslashes verbatim (literal escape, not continuation)", () => {
    expect(endsWithLineContinuation("echo path\\\\")).toBe(false);
    expect(acceptCommandWithContinuation("", "echo path\\\\")).toEqual({ entry: "echo path\\\\", pending: "" });
  });
});
