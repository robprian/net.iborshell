import { describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  dissolveQuickCommandGroup,
  filterQuickCommands,
  groupQuickCommands,
  loadQuickCommandsFromStore,
  migrateQuickCommandGroups,
  persistQuickCommands,
  QUICK_COMMANDS_LIMIT,
  QUICK_COMMANDS_STORE_KEY,
  quickCommandGroupCount,
  quickCommandText,
  renameQuickCommandGroup,
  upsertQuickCommand,
} from "./quickCommands";

const LIST = [
  { id: "1", name: "日志", command: "tail -f /var/log/nginx.log" },
  { id: "2", name: "Docker PS", command: "docker ps --format wide" },
  { id: "3", name: "端口", command: "netstat -tlnp | grep :8888" },
];

describe("filterQuickCommands", () => {
  it("returns everything for an empty/blank query", () => {
    expect(filterQuickCommands(LIST, "")).toHaveLength(3);
    expect(filterQuickCommands(LIST, "   ")).toHaveLength(3);
  });

  it("matches name and command case-insensitively", () => {
    expect(filterQuickCommands(LIST, "docker")).toHaveLength(1);
    expect(filterQuickCommands(LIST, "日志")[0]?.id).toBe("1");
    expect(filterQuickCommands(LIST, "8888")[0]?.id).toBe("3");
  });

  it("also matches the group name (issue #201)", () => {
    const grouped = [{ id: "g1", name: "磁盘", command: "df -h", groupId: "ops", groupName: "运维" }];
    expect(filterQuickCommands(grouped, "运维")).toHaveLength(1);
    expect(filterQuickCommands(grouped, "磁盘")).toHaveLength(1);
    expect(filterQuickCommands(grouped, "不存在的组")).toHaveLength(0);
  });

  it("returns [] when nothing matches", () => {
    expect(filterQuickCommands(LIST, "no-such-thing")).toEqual([]);
  });

  it("tolerates an empty list", () => {
    expect(filterQuickCommands([], "x")).toEqual([]);
  });
});

describe("quickCommandText", () => {
  it("preserves multi-line commands as PTY Enter keystrokes and trims", () => {
    expect(quickCommandText("docker ps\n")).toBe("docker ps");
    expect(quickCommandText("systemctl status nginx\r\n")).toBe("systemctl status nginx");
    expect(quickCommandText("  echo a\necho b  ")).toBe("echo a\recho b");
    expect(quickCommandText("echo a\r\necho b\recho c")).toBe("echo a\recho b\recho c");
    expect(quickCommandText(["echo \\", "--flag value"].join("\n"))).toBe("echo \\\r--flag value");
  });
  it("returns empty string for blank input", () => {
    expect(quickCommandText(" \n ")).toBe("");
  });
});

describe("store-backed authority (存储迁移批 1)", () => {
  // 本文件的 store 断言依赖顺序：未落键 → null 的断言必须在首个 persist 之前
  // （pluginStore 模块缓存在同文件内跨用例存活，load 走缓存不回源）。
  it("loadQuickCommandsFromStore returns null while the key is absent (seed not yet applied)", () => {
    expect(loadQuickCommandsFromStore()).toBeNull();
  });

  it("persist then load round-trips a normalized list", () => {
    const stored = persistQuickCommands([
      { id: "1", name: "日志", command: "tail -f app.log" },
      { id: "2", name: "  ", command: "  " }, // 空命令行被 normalize 丢弃
    ]);
    expect(stored).toHaveLength(1);
    expect(loadQuickCommandsFromStore()).toEqual(stored);
  });

  it("treating an empty list as present prevents legacy resurrection after user clears all", () => {
    persistQuickCommands([]);
    expect(loadQuickCommandsFromStore()).toEqual([]);
  });

  it("corrupt JSON degrades to an empty list without re-triggering the seed", () => {
    // 键已存在（已迁移）时坏 JSON 不回退种子：否则清空后的旧 sidecar 数据会复活。
    pluginStore.setItem(QUICK_COMMANDS_STORE_KEY, "{not-json");
    expect(loadQuickCommandsFromStore()).toEqual([]);
  });
});

describe("command groups (issue #201)", () => {
  const GROUPED = [
    { id: "1", name: "磁盘", command: "df -h" },
    { id: "2", name: "内存", command: "free -m", groupId: "ops", groupName: "运维" },
    { id: "3", name: "日志", command: "tail -f app.log", groupId: "ops", groupName: "运维" },
    { id: "4", name: "容器", command: "docker ps", groupId: "docker", groupName: "Docker" },
  ];

  it("raises the cap from 20 to 200 and still evicts the oldest beyond it", () => {
    expect(QUICK_COMMANDS_LIMIT).toBe(200);
    const full = Array.from({ length: QUICK_COMMANDS_LIMIT }, (_, i) => ({ id: `k${i}`, name: `n${i}`, command: "echo" }));
    const next = upsertQuickCommand(full, { id: "new", name: "New", command: "echo new" });
    expect(next).toHaveLength(QUICK_COMMANDS_LIMIT);
    expect(next[0].id).toBe("k1");
  });

  it("migrates legacy entries (no group fields) into the virtual ungrouped bucket", () => {
    const migrated = migrateQuickCommandGroups([
      { id: "1", name: "磁盘", command: "df -h" },
      { id: "2", name: "坏组", command: "echo x", groupId: 42 },
      { id: "3", name: "缺组名", command: "echo y", groupId: "ops" },
      { id: "4", name: "全", command: "echo z", groupId: "ops", groupName: "  " },
    ]);
    const groups = groupQuickCommands(migrated);
    // 未分组恒在最前；非法组字段（数字）被丢弃 → 归未分组。
    expect(groups[0]).toMatchObject({ id: "", commands: [
      { id: "1" },
      { id: "2" },
    ] });
    // 有组 id 缺组名：组名回落组 id。
    expect(groups[1]).toMatchObject({ id: "ops", name: "ops", commands: [{ id: "3" }, { id: "4" }] });
  });

  it("derives group views preserving first-seen order with ungrouped pinned first", () => {
    const groups = groupQuickCommands(GROUPED);
    expect(groups.map((group) => group.id)).toEqual(["", "ops", "docker"]);
    expect(groups[0].name).toBe("");
    expect(groups[1].name).toBe("运维");
    expect(groups[1].commands.map((item) => item.id)).toEqual(["2", "3"]);
    // 全未分组 → 单组视图（调用方据此退回扁平渲染）。
    expect(groupQuickCommands(LIST)).toHaveLength(1);
    expect(groupQuickCommands([])).toEqual([]);
  });

  it("renames a group in place across all its commands", () => {
    const renamed = renameQuickCommandGroup(GROUPED, "ops", "  SRE  ");
    expect(renamed.find((item) => item.id === "2")?.groupName).toBe("SRE");
    expect(renamed.find((item) => item.id === "3")?.groupName).toBe("SRE");
    expect(renamed.find((item) => item.id === "4")?.groupName).toBe("Docker");
    // 空组 id / 空名是 no-op。
    expect(renameQuickCommandGroup(GROUPED, "", "x")).toEqual(GROUPED);
    expect(renameQuickCommandGroup(GROUPED, "ops", "  ")).toEqual(GROUPED);
  });

  it("dissolves a group back to ungrouped keeping the commands", () => {
    const dissolved = dissolveQuickCommandGroup(GROUPED, "ops");
    expect(dissolved).toHaveLength(4);
    expect(dissolved.find((item) => item.id === "2")).toEqual({ id: "2", name: "内存", command: "free -m" });
    expect(dissolved.find((item) => item.id === "4")?.groupId).toBe("docker");
    expect(dissolveQuickCommandGroup(GROUPED, "")).toEqual(GROUPED);
  });

  it("counts real groups (ungrouped excluded)", () => {
    expect(quickCommandGroupCount(GROUPED)).toBe(2);
    expect(quickCommandGroupCount(LIST)).toBe(0);
    expect(quickCommandGroupCount([])).toBe(0);
  });

  it("upsert keeps group fields and drops them when the group id is cleared", () => {
    const withGroup = upsertQuickCommand([{ id: "1", name: "n", command: "echo" }], { id: "1", name: "n", command: "echo", groupId: "ops", groupName: "运维" });
    expect(withGroup[0]).toMatchObject({ groupId: "ops", groupName: "运维" });
    const cleared = upsertQuickCommand(withGroup, { id: "1", name: "n", command: "echo" });
    expect(cleared[0]).toEqual({ id: "1", name: "n", command: "echo" });
    // 组名缺省回落组 id。
    const fallback = upsertQuickCommand([], { id: "2", name: "n", command: "echo", groupId: "ops" });
    expect(fallback[0]).toMatchObject({ groupId: "ops", groupName: "ops" });
  });
});
