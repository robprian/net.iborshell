// 普通多文件上传批次卡（issue #165）的生命周期簿记：begin 建卡（单文件不
// 建），end 收尾——批次编排结束后保留一小段窗口再清卡。收尾缺失的两个后果：
// ① 卡片在整批结束后永久悬挂；② 任务账本的 30s 终态清收（useTransferQueue
// 的 dropTransferRecord）删掉任务行后，聚合函数找不到批次任务，卡片回跳成
// 「0/N · 0%」，与 issue 要消灭的"完成→空窗→回跳"观感正好相反。
// 批次 id 生成与卡片数据盒子分离：盒子传 Vue ref 即得响应式，纯对象可单测；
// 清空定时器可注入，清空时序可离线断言。

export interface FileBatchCardState {
  batchId: string;
  filesTotal: number;
  totalBytes: number;
}

/** 批次编排结束到卡片收尾清空之间的保留窗口：让用户看清最终计数（含失败
 * 后缀），又不在面板里悬挂一张死卡。 */
export const FILE_BATCH_CLEAR_DELAY_MS = 2_500;

/** 清空计时器注入点：调度回调并返回取消函数（默认 window.setTimeout）。 */
export type FileBatchClearScheduler = (fn: () => void, delayMs: number) => () => void;

const defaultScheduler: FileBatchClearScheduler = (fn, delayMs) => {
  const timer = window.setTimeout(fn, delayMs);
  return () => window.clearTimeout(timer);
};

/** 卡片数据盒子：Vue 的 Ref<FileBatchCardState | undefined> 结构上兼容。 */
export interface FileBatchCardBox {
  value: FileBatchCardState | undefined;
}

export interface FileBatchCardController {
  /** 新批次开始：取消上一批未决的收尾清空；多文件（>1）建卡，单文件只发
   * id（供任务行打 batchId，不建卡）。 */
  begin(files: ReadonlyArray<{ size: number }>): string;
  /** 批次编排结束（runTransfers 结算，含中途失败抛出的 finally）：安排收尾
   * 清空；非当前批次（两批重叠时先结束的旧批）不动卡片。 */
  end(batchId: string): void;
  /** 卸载时取消未决计时器。 */
  dispose(): void;
}

export function createFileBatchCard(box: FileBatchCardBox, schedule: FileBatchClearScheduler = defaultScheduler): FileBatchCardController {
  let cancelPending: (() => void) | undefined;
  let pendingBatchId: string | undefined;
  const cancelScheduled = () => {
    cancelPending?.();
    cancelPending = undefined;
    pendingBatchId = undefined;
  };
  return {
    begin(files) {
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      cancelScheduled();
      if (files.length > 1) {
        box.value = { batchId, filesTotal: files.length, totalBytes: files.reduce((sum, file) => sum + (Number.isFinite(file.size) && file.size > 0 ? file.size : 0), 0) };
      }
      return batchId;
    },
    end(batchId) {
      if (box.value?.batchId !== batchId) return;
      // 幂等：同一批次已挂起收尾清空时不重复排（二次 end 不重置保留窗口）。
      if (pendingBatchId === batchId) return;
      cancelScheduled();
      pendingBatchId = batchId;
      cancelPending = schedule(() => {
        cancelPending = undefined;
        pendingBatchId = undefined;
        if (box.value?.batchId === batchId) box.value = undefined;
      }, FILE_BATCH_CLEAR_DELAY_MS);
    },
    dispose: cancelScheduled,
  };
}
