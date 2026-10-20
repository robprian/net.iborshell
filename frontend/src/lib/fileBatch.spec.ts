import { describe, expect, it } from "vitest";
import { createFileBatchCard, FILE_BATCH_CLEAR_DELAY_MS, type FileBatchCardState, type FileBatchClearScheduler } from "./fileBatch";

// 批次卡收尾清空时序（issue #165）：清卡必须发生在批次编排结束后的保留
// 窗口，且不得误伤批间重叠时的新批次、不响应旧批次的迟到 end。定时器
// 注入为手动的挂起表，时序全部离线断言。

interface PendingClear {
  /** 模拟定时器到期：已取消的计时器到期不执行回调（同 clearTimeout）。 */
  run: () => void;
  delayMs: number;
  cancelled: boolean;
}

function fakeScheduler() {
  const pending: PendingClear[] = [];
  const schedule: FileBatchClearScheduler = (fn, delayMs) => {
    const entry: PendingClear = { run: () => {}, delayMs, cancelled: false };
    entry.run = () => {
      if (!entry.cancelled) fn();
    };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { pending, schedule };
}

function setup() {
  const box: { value: FileBatchCardState | undefined } = { value: undefined };
  const { pending, schedule } = fakeScheduler();
  const card = createFileBatchCard(box, schedule);
  return { box, pending, card };
}

describe("createFileBatchCard (#165)", () => {
  it("creates a card for multi-file batches and skips it for single files", () => {
    const { box, card } = setup();
    const batchId = card.begin([{ size: 100 }, { size: 200 }]);
    expect(box.value).toEqual({ batchId, filesTotal: 2, totalBytes: 300 });
    // 单文件只发批次 id：不动正在展示的批次卡（批中单发不冲掉批次卡）。
    const singleId = card.begin([{ size: 1 }]);
    expect(typeof singleId).toBe("string");
    expect(box.value).toEqual({ batchId, filesTotal: 2, totalBytes: 300 });
    // 非法/零大小不计入总字节。
    card.begin([{ size: 5 }, { size: Number.NaN }]);
    expect(box.value).toMatchObject({ filesTotal: 2, totalBytes: 5 });
  });

  it("clears the card after the retention window once the batch settles", () => {
    const { box, pending, card } = setup();
    const batchId = card.begin([{ size: 1 }, { size: 2 }]);
    card.end(batchId);
    expect(box.value).not.toBeUndefined();
    // 收尾前不清卡；窗口到期才清。
    expect(pending).toHaveLength(1);
    expect(pending[0].delayMs).toBe(FILE_BATCH_CLEAR_DELAY_MS);
    pending[0].run();
    expect(box.value).toBeUndefined();
  });

  it("ignores end() for a batch that is not on display", () => {
    const { box, pending, card } = setup();
    // 尚未 begin：任意 end 都是 no-op。
    card.end("batch-nowhere");
    expect(pending).toHaveLength(0);
    // 两批重叠：先结束的旧批次不得安排清卡动到新批次的卡。
    card.begin([{ size: 1 }, { size: 2 }]);
    const first = box.value!.batchId;
    card.begin([{ size: 3 }, { size: 4 }]);
    expect(box.value!.batchId).not.toBe(first);
    card.end(first);
    expect(pending).toHaveLength(0);
    expect(box.value).not.toBeUndefined();
  });

  it("a newer batch cancels the previous batch's pending clear", () => {
    const { box, pending, card } = setup();
    const first = card.begin([{ size: 1 }, { size: 2 }]);
    card.end(first);
    expect(pending).toHaveLength(1);
    // 新批次开始：旧批次的未决清卡作废——到期回调不能把新批次打回 0。
    card.begin([{ size: 3 }, { size: 4 }]);
    expect(pending[0].cancelled).toBe(true);
    pending[0].run();
    expect(box.value).not.toBeUndefined();
  });

  it("the scheduled clear only removes its own batch", () => {
    const { box, pending, card } = setup();
    const first = card.begin([{ size: 1 }, { size: 2 }]);
    card.end(first);
    // 窗口内旧批次被新批次顶掉：到期回调看到批次已换，不再清。
    card.begin([{ size: 3 }, { size: 4 }]);
    pending[0].run();
    expect(box.value).not.toBeUndefined();
  });

  it("end is idempotent: only one pending clear per batch", () => {
    const { box, pending, card } = setup();
    const batchId = card.begin([{ size: 1 }, { size: 2 }]);
    card.end(batchId);
    card.end(batchId);
    expect(pending).toHaveLength(1);
    pending[0].run();
    expect(box.value).toBeUndefined();
  });

  it("dispose cancels the pending clear", () => {
    const { box, pending, card } = setup();
    const batchId = card.begin([{ size: 1 }, { size: 2 }]);
    card.end(batchId);
    card.dispose();
    expect(pending[0].cancelled).toBe(true);
    pending[0].run();
    // 取消后的到期回调不执行（同 clearTimeout 语义），卡片不被清。
    expect(box.value).not.toBeUndefined();
  });
});
