// historyPanel 纯逻辑单测：执行时间/富元数据映射与分桶历史档的解析、记录与裁剪。
import { describe, expect, it } from "vitest";
import {
  HISTORY_TIMES_LIMIT,
  persistableHistoryMetaBuckets,
  pruneHistoryTimesBuckets,
  recordHistoryMeta,
  sanitizeHistoryMeta,
  sanitizeHistoryMetaBuckets,
  sanitizeHistoryTimesBuckets,
  pruneHistoryTimes,
  recordHistoryTime,
  sanitizeHistoryTimes,
} from "./historyPanel";






describe("history times (Warp 式相对时间的数据面)", () => {
  it("sanitizeHistoryTimes keeps only well-formed entries and caps to the limit", () => {
    expect(sanitizeHistoryTimes(null)).toEqual({});
    expect(sanitizeHistoryTimes("junk")).toEqual({});
    expect(sanitizeHistoryTimes([{ c: "ls", t: 100 }, { c: "", t: 5 }, { c: "rm", t: -1 }, { c: "ok", t: "x" }, "junk", null])).toEqual({ ls: 100 });
    const flood = Array.from({ length: HISTORY_TIMES_LIMIT + 10 }, (_, i) => ({ c: `cmd-${i}`, t: i + 1 }));
    const sanitized = sanitizeHistoryTimes(flood);
    expect(Object.keys(sanitized)).toHaveLength(HISTORY_TIMES_LIMIT);
    expect(sanitized["cmd-0"]).toBeUndefined();
    expect(sanitized[`cmd-${HISTORY_TIMES_LIMIT + 9}`]).toBe(HISTORY_TIMES_LIMIT + 10);
  });

  it("recordHistoryTime upserts and evicts the oldest beyond the limit", () => {
    let times = recordHistoryTime({}, "a", 1);
    times = recordHistoryTime(times, "b", 2);
    times = recordHistoryTime(times, "a", 3);
    expect(times).toEqual({ b: 2, a: 3 });
    for (let i = 0; i < HISTORY_TIMES_LIMIT; i += 1) times = recordHistoryTime(times, `x${i}`, 10 + i);
    // 102 条裁到 100：按时间序淘汰最旧的两条（b@2、a@3）。
    expect(Object.keys(times)).toHaveLength(HISTORY_TIMES_LIMIT);
    expect(times.b).toBeUndefined();
    expect(times.a).toBeUndefined();
    expect(times.x0).toBe(10);
    expect(times.x99).toBe(109);
    expect(recordHistoryTime(times, "   ", 99)).toEqual(times);
  });

  it("pruneHistoryTimes drops entries no longer present in the history ring", () => {
    expect(pruneHistoryTimes({ a: 1, b: 2, gone: 3 }, ["a", "b"])).toEqual([{ c: "a", t: 1 }, { c: "b", t: 2 }]);
  });

});

describe("history meta (批 4d 富元数据: 时长/退出码)", () => {
  it("sanitizeHistoryMeta keeps valid rows, drops invalid, caps at limit", () => {
    const meta = sanitizeHistoryMeta([
      { c: "ls -la", d: 1200, x: 0 },
      { c: "fail", x: 1 },
      { c: "timed", d: 500 },
      { c: "", d: 1 },
      { c: "norow" },
      "junk",
    ]);
    expect(meta).toEqual({
      "ls -la": { durationMs: 1200, exitCode: 0 },
      fail: { durationMs: null, exitCode: 1 },
      timed: { durationMs: 500, exitCode: null },
    });
    expect(sanitizeHistoryMeta("junk")).toEqual({});
  });

  it("recordHistoryMeta merges partial patches and prunes to live commands", () => {
    const live = new Set(["ls", "gone"]);
    let meta = recordHistoryMeta({}, "ls", { exitCode: 0 }, live);
    meta = recordHistoryMeta(meta, "ls", { durationMs: 300 }, live);
    meta = recordHistoryMeta(meta, "gone", { exitCode: 2 }, live);
    meta = recordHistoryMeta(meta, "unknown", { exitCode: 9 }, live);
    expect(meta).toEqual({ ls: { durationMs: 300, exitCode: 0 }, gone: { durationMs: null, exitCode: 2 } });
  });

});



describe("分桶历史档（scope = 连接 id，本地/串口固定桶）", () => {
  it("sanitizeHistoryTimesBuckets migrates the legacy flat array into the legacy scope", () => {
    expect(sanitizeHistoryTimesBuckets([{ c: "ls", t: 100 }], { legacyScope: "local" })).toEqual({ local: { ls: 100 } });
    expect(sanitizeHistoryTimesBuckets(null, { legacyScope: "local" })).toEqual({});
    expect(sanitizeHistoryTimesBuckets([{ c: "", t: 5 }], { legacyScope: "local" })).toEqual({});
  });

  it("sanitizeHistoryTimesBuckets sanitizes each scope independently", () => {
    const raw = {
      "conn-1": [{ c: "ls", t: 100 }, { c: "bad", t: -1 }],
      "conn-2": "junk",
      "": [{ c: "dropped", t: 1 }],
    };
    expect(sanitizeHistoryTimesBuckets(raw, { legacyScope: "local" })).toEqual({ "conn-1": { ls: 100 } });
  });

  it("sanitizeHistoryMetaBuckets migrates the legacy flat array into the legacy scope", () => {
    expect(sanitizeHistoryMetaBuckets([{ c: "ls", d: 12, x: 0 }], { legacyScope: "local" })).toEqual({ local: { ls: { durationMs: 12, exitCode: 0 } } });
    expect(sanitizeHistoryMetaBuckets("junk", { legacyScope: "local" })).toEqual({});
  });

  it("pruneHistoryTimesBuckets prunes each scope against its own ring and drops empty scopes", () => {
    const times = { "conn-1": { a: 1, gone: 3 }, "conn-2": { gone: 4 } };
    const rings = { "conn-1": ["a", "b"] };
    expect(pruneHistoryTimesBuckets(times, rings)).toEqual({ "conn-1": [{ c: "a", t: 1 }] });
  });

  it("persistableHistoryMetaBuckets keeps only ring-live rows per scope and drops empty scopes", () => {
    const meta = { "conn-1": { a: { durationMs: 1, exitCode: 0 }, gone: { durationMs: 2, exitCode: 1 } } };
    const rings = { "conn-1": ["a"], "conn-2": [] };
    expect(persistableHistoryMetaBuckets(meta, rings)).toEqual({ "conn-1": [{ c: "a", d: 1, x: 0 }] });
  });
});
