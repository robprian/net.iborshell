// Docker 浮层宽度（issue #170）：面板固定锚在终端右上角（.docker-float），
// 默认 min(680px, 100%-16px)，表格列多时横向滚动兜底但一行放不下常用列。
// 左缘拖拽手柄调宽：宽度纯计算收敛在此（可单测），持久化 pluginStore 单键。

import { pluginStore } from "./pluginStore";

export const DOCKER_PANEL_WIDTH_MIN = 300;
export const DOCKER_PANEL_WIDTH_MAX = 720;
/** 默认宽度 = 原 CSS 的 min(680px, …) 基准值。 */
export const DOCKER_PANEL_WIDTH_DEFAULT = 680;

export const DOCKER_PANEL_WIDTH_STORE_KEY = "ssh-docker-panel-width";

/** 宽度钳制：非数值/NaN 回落默认，越界截到 300..720。 */
export function clampDockerPanelWidth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DOCKER_PANEL_WIDTH_DEFAULT;
  return Math.min(DOCKER_PANEL_WIDTH_MAX, Math.max(DOCKER_PANEL_WIDTH_MIN, Math.round(parsed)));
}

/** 解析 pluginStore 的持久化值；null/坏值返回 null（调用方用默认宽度）。 */
export function sanitizeDockerPanelWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return clampDockerPanelWidth(parsed);
}

/**
 * 左缘拖拽的纯计算：浮层右缘固定（锚 right:8px），左缘向左拖 = 变宽，
 * 所以新宽度 = 起始宽 + (起点 x - 当前 x)。钳制交给 clampDockerPanelWidth，
 * 调用方无需先行判界。
 */
export function dockerPanelWidthAfterDrag(input: { startWidth: number; startX: number; currentX: number }): number {
  return clampDockerPanelWidth(input.startWidth + (input.startX - input.currentX));
}

/** 持久化（拖拽结束一次性写穿；存储不可用时静默降级为本次会话内存态）。 */
export function persistDockerPanelWidth(width: number): void {
  try {
    pluginStore.setItem(DOCKER_PANEL_WIDTH_STORE_KEY, String(clampDockerPanelWidth(width)));
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
}

/** 浮层内联宽度样式：保留 calc 上限守卫（容器不足时不会被钳到溢出）。 */
export function dockerPanelWidthStyle(width: number): string {
  return `min(${clampDockerPanelWidth(width)}px, calc(100% - 16px))`;
}
