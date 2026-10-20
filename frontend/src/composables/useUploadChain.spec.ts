// @vitest-environment happy-dom
// issue #197 回归守卫：文件拖入终端/SFTP 面板点亮「上传」悬浮层后，未放下
// （dragleave/dragend 取消路径）必须恢复拖入前状态。旧实现用 `@dragleave.self`
// 拦截子元素间冒泡的 leave，结果经子元素把文件拖出面板/拖出窗口的那次 leave
// 被吞掉，面板永久停留在上传页。这里用模拟 DragEvent 走真实 DOM 子树验证
// onSftpDragEnter/onSftpDragLeave/onTerminalDragEnter/onTerminalDragLeave 的
// 完整生命周期，不需要真实文件。
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useUploadChain } from "./useUploadChain";

/** 最小 DragEvent 替身：处理器只读 dataTransfer.types / relatedTarget / currentTarget。 */
function fakeDragEvent(init: { types?: string[]; relatedTarget?: EventTarget | null; currentTarget: EventTarget | null }): DragEvent {
  return {
    dataTransfer: init.types ? { types: init.types } : undefined,
    relatedTarget: init.relatedTarget ?? null,
    currentTarget: init.currentTarget,
  } as unknown as DragEvent;
}

/** 面板 > 子元素 > 孙元素 的真实 DOM 子树，模拟 SFTP/终端面板内部结构。 */
function buildPaneTree() {
  const pane = document.createElement("section");
  const child = document.createElement("div");
  const grandchild = document.createElement("span");
  child.appendChild(grandchild);
  pane.appendChild(child);
  document.body.appendChild(pane);
  return { pane, child, grandchild };
}

/** 挂载上传链，drag 高亮 ref 随返回值透出便于断言；overrides 覆盖门禁输入。 */
function mountUploadChain(overrides?: { sftpPaneOpen?: boolean }) {
  const dragActive = ref(false);
  const terminalDragActive = ref(false);
  const chain = useUploadChain({
    t: (key) => key,
    showNotice: vi.fn(),
    showError: vi.fn(),
    session: ref(undefined),
    connected: ref(true),
    canWrite: ref(true),
    currentPath: ref("/root"),
    sftpHomePath: ref("/home/demo"),
    terminalCwd: ref(""),
    sftpNameEncodingState: ref("auto"),
    dragActive,
    terminalDragActive,
    sftpPaneOpen: ref(overrides?.sftpPaneOpen ?? false),
    terminalTransferBusy: ref(false),
    uploadSource: vi.fn(async () => true),
    loadTransferConcurrency: () => 3,
    loadTransferMaxActive: () => 3,
    loadTransferDuplicatePolicy: () => "rename",
    transferDuplicateState: ref("rename"),
    transferTasks: {},
    terminal: () => undefined,
    loadDirectory: vi.fn(async () => undefined),
    openTransferPanel: vi.fn(),
    joinRemote: (parent: string, name: string) => `${parent}/${name}`,
    sudoUpload: () => false,
  });
  return { chain, dragActive, terminalDragActive };
}

describe("useUploadChain drag highlight lifecycle (issue #197)", () => {
  it("SFTP pane: highlight survives child-to-child moves and resets once the drag leaves through a child without dropping", () => {
    const { chain, dragActive } = mountUploadChain();
    const { pane, child, grandchild } = buildPaneTree();

    // 拖入面板：点亮「上传」悬浮层。
    chain.onSftpDragEnter(fakeDragEvent({ types: ["Files"], currentTarget: pane }));
    expect(dragActive.value).toBe(true);

    // 在面板子树内移动（面板→子元素、子元素→孙元素）：冒泡 leave 不熄灭、不闪烁。
    chain.onSftpDragLeave(fakeDragEvent({ relatedTarget: child, currentTarget: pane }));
    expect(dragActive.value).toBe(true);
    chain.onSftpDragLeave(fakeDragEvent({ relatedTarget: grandchild, currentTarget: pane }));
    expect(dragActive.value).toBe(true);

    // 未放下拖走（经子元素离开面板）：relatedTarget 指向面板外 → 恢复。
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    chain.onSftpDragLeave(fakeDragEvent({ relatedTarget: outside, currentTarget: pane }));
    expect(dragActive.value).toBe(false);
  });

  it("SFTP pane: leaving the window or cancelling the drag (null relatedTarget) also resets the highlight", () => {
    const { chain, dragActive } = mountUploadChain();
    const { pane } = buildPaneTree();

    chain.onSftpDragEnter(fakeDragEvent({ types: ["Files"], currentTarget: pane }));
    expect(dragActive.value).toBe(true);
    // 拖出浏览器窗口 / Esc 取消：最后一次 dragleave relatedTarget 为空。
    chain.onSftpDragLeave(fakeDragEvent({ currentTarget: pane }));
    expect(dragActive.value).toBe(false);
  });

  it("SFTP pane: non-file drags (text/elements) never light the highlight in the first place", () => {
    const { chain, dragActive } = mountUploadChain();
    const { pane } = buildPaneTree();

    chain.onSftpDragEnter(fakeDragEvent({ types: ["text/plain"], currentTarget: pane }));
    expect(dragActive.value).toBe(false);
  });

  it("terminal pane: highlight follows the same enter/leave lifecycle and respects the drop gate", () => {
    const { chain, terminalDragActive } = mountUploadChain();
    const { pane, child } = buildPaneTree();

    // 门禁通过（connected+canWrite+空闲+面板关闭）：拖入点亮。
    chain.onTerminalDragEnter(fakeDragEvent({ types: ["Files"], currentTarget: pane }));
    expect(terminalDragActive.value).toBe(true);
    // 子元素间路过不熄灭。
    chain.onTerminalDragLeave(fakeDragEvent({ relatedTarget: child, currentTarget: pane }));
    expect(terminalDragActive.value).toBe(true);
    // 未放下拖走：恢复。
    chain.onTerminalDragLeave(fakeDragEvent({ currentTarget: pane }));
    expect(terminalDragActive.value).toBe(false);

    // SFTP 面板打开时终端拒收（可见落点是面板）：拖入不再点亮。
    const paneOpen = mountUploadChain({ sftpPaneOpen: true });
    paneOpen.chain.onTerminalDragEnter(fakeDragEvent({ types: ["Files"], currentTarget: pane }));
    expect(paneOpen.terminalDragActive.value).toBe(false);
  });
});
