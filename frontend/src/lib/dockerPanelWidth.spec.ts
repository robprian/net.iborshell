import { afterEach, describe, expect, it } from "vitest";
import {
  clampDockerPanelWidth,
  DOCKER_PANEL_WIDTH_DEFAULT,
  DOCKER_PANEL_WIDTH_MAX,
  DOCKER_PANEL_WIDTH_MIN,
  DOCKER_PANEL_WIDTH_STORE_KEY,
  dockerPanelWidthAfterDrag,
  dockerPanelWidthStyle,
  persistDockerPanelWidth,
  sanitizeDockerPanelWidth,
} from "./dockerPanelWidth";
import { pluginStore } from "./pluginStore";

describe("dockerPanelWidth (issue #170)", () => {
  afterEach(() => {
    pluginStore.removeItem(DOCKER_PANEL_WIDTH_STORE_KEY);
  });

  it("clamps to 300..720 and falls back to the default for non-numeric input", () => {
    expect(DOCKER_PANEL_WIDTH_MIN).toBe(300);
    expect(DOCKER_PANEL_WIDTH_MAX).toBe(720);
    expect(clampDockerPanelWidth(500)).toBe(500);
    expect(clampDockerPanelWidth(50)).toBe(300);
    expect(clampDockerPanelWidth(5000)).toBe(720);
    expect(clampDockerPanelWidth(Number.NaN)).toBe(DOCKER_PANEL_WIDTH_DEFAULT);
    expect(clampDockerPanelWidth("abc")).toBe(DOCKER_PANEL_WIDTH_DEFAULT);
    expect(clampDockerPanelWidth(680.4)).toBe(680);
  });

  it("computes the drag delta leftward from a right-anchored panel (wider when dragged left)", () => {
    // 左缘向左拖 80px → 变宽 80。
    expect(dockerPanelWidthAfterDrag({ startWidth: 600, startX: 400, currentX: 320 })).toBe(680);
    // 向右拖回 → 变窄；越界被钳制（含超上限的变宽分支）。
    expect(dockerPanelWidthAfterDrag({ startWidth: 680, startX: 400, currentX: 480 })).toBe(600);
    expect(dockerPanelWidthAfterDrag({ startWidth: 680, startX: 400, currentX: 320 })).toBe(720);
    expect(dockerPanelWidthAfterDrag({ startWidth: 320, startX: 400, currentX: 700 })).toBe(300);
  });

  it("sanitizes persisted values and returns null for absent/garbage entries", () => {
    expect(sanitizeDockerPanelWidth(null)).toBeNull();
    expect(sanitizeDockerPanelWidth("")).toBeNull();
    expect(sanitizeDockerPanelWidth("wide")).toBeNull();
    expect(sanitizeDockerPanelWidth("520")).toBe(520);
    expect(sanitizeDockerPanelWidth("9999")).toBe(720);
  });

  it("persists through the pluginStore key and reads back clamped", () => {
    persistDockerPanelWidth(560);
    expect(pluginStore.getItem(DOCKER_PANEL_WIDTH_STORE_KEY)).toBe("560");
    persistDockerPanelWidth(9999);
    expect(pluginStore.getItem(DOCKER_PANEL_WIDTH_STORE_KEY)).toBe("720");
  });

  it("keeps the container guard in the inline width style", () => {
    expect(dockerPanelWidthStyle(560)).toBe("min(560px, calc(100% - 16px))");
    expect(dockerPanelWidthStyle(9999)).toBe("min(720px, calc(100% - 16px))");
  });
});
