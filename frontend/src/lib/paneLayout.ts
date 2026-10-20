// 面板分栏让宽的纯计算（App.vue terminalBasis 共用）。
// Docker 面板为 metrics-float 同款浮层，不参与分栏让宽；只有 SFTP 分栏
// 需要终端让出份额。

/** 终端 flex-basis：SFTP 分栏开时按用户拖拽比例让出份额，
 *  SFTP flex:1 吸收剩余——两栏同显，谁也不挤没谁。 */
export function terminalFlexBasis(input: { sftpOpen: boolean; splitRatio: number }): string {
  if (input.sftpOpen) return `${input.splitRatio}%`;
  return "100%";
}

// 纵向分栏（issue #207）：「始终上下」/ 窄屏断点的两栏高度不再由 CSS 钉死，
// 改为消费容器上的 --pane-split 变量。与 terminalFlexBasis 同源——splitRatio
// 仍是唯一数据源，拖拽/键盘微调写入后纵向布局即时生效。
/** 纵向分栏容器样式：SFTP 开时输出 --pane-split（终端高度占比，夹取 35-80，
 *  与 App.vue 拖拽/持久化的边界一致）；solo（SFTP 收起）返回 undefined，
 *  不设变量，回落既有 solo 全屏规则。 */
export function paneSplitCssVar(input: { sftpOpen: boolean; splitRatio: number }): Record<string, string> | undefined {
  if (!input.sftpOpen) return undefined;
  const ratio = Math.max(35, Math.min(80, input.splitRatio));
  return { "--pane-split": `${ratio}%` };
}

// —— 布局方向偏好（issue #187）——
// 现状只有隐式规则：宽屏左右（row / row-reverse），<900px 断点切纵向
// （style.css @media）。用户无法在宽屏固定上下布局（如 SFTP 底栏工作流）。
// 三选偏好：auto 保持断点行为；vertical 恒为上下（终端在上、SFTP 在下，
// 与 paneOrder 的左右换位无关）；horizontal 恒为左右（换位仍生效）。

export type PaneDirectionPref = "auto" | "vertical" | "horizontal";

/** 分栏实际轴向：column=上下堆叠（终端恒在上），row=左右分栏。 */
export type PaneDirection = "column" | "row";

/** 窄屏断点：与 style.css 的 @media (max-width: 900px) 保持一致。 */
export const PANE_DIRECTION_NARROW_BREAKPOINT = 900;

/** 偏好白名单消毒：非法/缺省回落 auto（与 WORKBENCH_LAYOUT 消毒同向）。 */
export function sanitizePaneDirection(value: unknown): PaneDirectionPref {
  return value === "vertical" || value === "horizontal" ? value : "auto";
}

/** 解析分栏轴向：auto 窄屏回退纵向，强制模式不受视口影响。 */
export function resolvePaneDirection(input: { pref: PaneDirectionPref; viewportWidth?: number }): PaneDirection {
  if (input.pref === "vertical") return "column";
  if (input.pref === "horizontal") return "row";
  const width = typeof input.viewportWidth === "number" && input.viewportWidth > 0 ? input.viewportWidth : Number.POSITIVE_INFINITY;
  return width <= PANE_DIRECTION_NARROW_BREAKPOINT ? "column" : "row";
}

/** 分栏容器覆盖类：auto 不加类（沿用 CSS 默认与断点），强制模式加类压过断点。 */
export function paneDirectionClass(pref: PaneDirectionPref): string | null {
  if (pref === "vertical") return "panes--vertical";
  if (pref === "horizontal") return "panes--horizontal";
  return null;
}
