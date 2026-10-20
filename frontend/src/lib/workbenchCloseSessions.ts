/**
 * §8.3/§7.4 workbench/close 会话回收目标枚举（issue #193a 的会话隔离契约）。
 *
 * 宿主拆除一个 workbench（tab/dock 条目）前会先发 workbench/close，插件据此
 * 释放**自己**的 sidecar scope（PTY 会话）。枚举规则：只收本工作台持有且非空
 * 的 sessionId——同连接其他 tab、底部 dock 终端等兄弟工作台的会话永远不出现在
 * 列表里；连接级清场是宿主 `connection/disconnect` 的语义（PROTOCOL「生命周期
 * 与状态隔离」），插件侧任何关闭路径都不得放大作用域。
 *
 * 纯函数：入参是调用点按域收集的 `[closeMethod, sessionId]` 候选对；undefined/
 * 空串（该域当前无会话）整对丢弃，输出即可直接 notify 的目标列表。
 */
export function workbenchCloseTargets(
  owned: ReadonlyArray<readonly [string, string | undefined | null]>,
): Array<[string, string]> {
  return owned.filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1] !== "");
}
