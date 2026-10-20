import { describe, expect, it } from "vitest";
import { workbenchCloseTargets } from "./workbenchCloseSessions";

/** 关闭一个 workbench 只回收它自己的会话（issue #193a 回归锁）：
 * workbench/close 的回收目标按「本工作台各会话域」逐一收集，空槽位（该域当前
 * 无会话）丢弃；输出恰好是「每域至多一条 close 通知」，跨工作台的兄弟会话
 * （同连接其他 tab、底部 dock 终端）由调用点只传自身 ref 从结构上排除。 */
describe("workbenchCloseTargets", () => {
  it("keeps only the closing workbench's own non-empty session ids, one close per domain", () => {
    const targets = workbenchCloseTargets([
      ["local/session/close", "local-1"],
      ["ssh/session/close", "ssh-1"],
      ["telnet/close", undefined],
      ["serial/close", ""],
      ["vnc/close", "vnc-1"],
      ["rdp/close", null],
    ]);
    expect(targets).toEqual([
      ["local/session/close", "local-1"],
      ["ssh/session/close", "ssh-1"],
      ["vnc/close", "vnc-1"],
    ]);
    // 每个会话域至多一条关闭通知：单条 close 不会拆掉多个会话。
    expect(new Set(targets.map(([method]) => method)).size).toBe(targets.length);
  });

  it("emits nothing when every domain is idle", () => {
    expect(workbenchCloseTargets([
      ["local/session/close", undefined],
      ["ssh/session/close", undefined],
      ["telnet/close", ""],
    ])).toEqual([]);
  });
});
