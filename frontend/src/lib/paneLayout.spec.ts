import { describe, expect, it } from "vitest";
import { paneDirectionClass, paneSplitCssVar, resolvePaneDirection, sanitizePaneDirection, terminalFlexBasis, PANE_DIRECTION_NARROW_BREAKPOINT } from "./paneLayout";

describe("terminalFlexBasis", () => {
  it("gives the terminal the full row when nothing else is open", () => {
    expect(terminalFlexBasis({ sftpOpen: false, splitRatio: 58 })).toBe("100%");
  });

  it("keeps the user split ratio when only SFTP is open", () => {
    expect(terminalFlexBasis({ sftpOpen: true, splitRatio: 62 })).toBe("62%");
  });
});

describe("paneSplitCssVar", () => {
  it("emits the terminal height share when SFTP is open", () => {
    expect(paneSplitCssVar({ sftpOpen: true, splitRatio: 62 })).toEqual({ "--pane-split": "62%" });
  });

  it("clamps the ratio into the 35-80 drag range", () => {
    expect(paneSplitCssVar({ sftpOpen: true, splitRatio: 10 })).toEqual({ "--pane-split": "35%" });
    expect(paneSplitCssVar({ sftpOpen: true, splitRatio: 95 })).toEqual({ "--pane-split": "80%" });
  });

  it("emits nothing when SFTP is collapsed (solo keeps its own full-height rules)", () => {
    expect(paneSplitCssVar({ sftpOpen: false, splitRatio: 62 })).toBeUndefined();
  });
});

describe("sanitizePaneDirection", () => {
  it("keeps the two forced modes", () => {
    expect(sanitizePaneDirection("vertical")).toBe("vertical");
    expect(sanitizePaneDirection("horizontal")).toBe("horizontal");
  });

  it("falls back to auto for anything else", () => {
    expect(sanitizePaneDirection("auto")).toBe("auto");
    expect(sanitizePaneDirection(undefined)).toBe("auto");
    expect(sanitizePaneDirection("diagonal")).toBe("auto");
    expect(sanitizePaneDirection(null)).toBe("auto");
  });
});

describe("resolvePaneDirection", () => {
  it("auto keeps the wide-screen row layout above the breakpoint", () => {
    expect(resolvePaneDirection({ pref: "auto", viewportWidth: 1280 })).toBe("row");
    expect(resolvePaneDirection({ pref: "auto", viewportWidth: PANE_DIRECTION_NARROW_BREAKPOINT + 1 })).toBe("row");
  });

  it("auto falls back to column at or below the narrow breakpoint", () => {
    expect(resolvePaneDirection({ pref: "auto", viewportWidth: PANE_DIRECTION_NARROW_BREAKPOINT })).toBe("column");
    expect(resolvePaneDirection({ pref: "auto", viewportWidth: 640 })).toBe("column");
  });

  it("auto without a usable width keeps the CSS default (row)", () => {
    expect(resolvePaneDirection({ pref: "auto" })).toBe("row");
    expect(resolvePaneDirection({ pref: "auto", viewportWidth: 0 })).toBe("row");
    expect(resolvePaneDirection({ pref: "auto", viewportWidth: -1 })).toBe("row");
  });

  it("vertical always stacks terminal over SFTP regardless of width", () => {
    expect(resolvePaneDirection({ pref: "vertical", viewportWidth: 1920 })).toBe("column");
    expect(resolvePaneDirection({ pref: "vertical", viewportWidth: 320 })).toBe("column");
  });

  it("horizontal always splits side by side regardless of width", () => {
    expect(resolvePaneDirection({ pref: "horizontal", viewportWidth: 375 })).toBe("row");
    expect(resolvePaneDirection({ pref: "horizontal", viewportWidth: 2560 })).toBe("row");
  });
});

describe("paneDirectionClass", () => {
  it("maps forced modes to override classes and auto to none", () => {
    expect(paneDirectionClass("vertical")).toBe("panes--vertical");
    expect(paneDirectionClass("horizontal")).toBe("panes--horizontal");
    expect(paneDirectionClass("auto")).toBeNull();
  });
});
