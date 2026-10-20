/**
 * Ordered, lossless transport for PTY input.
 *
 * The host's binary send promise only confirms that the frame was accepted by
 * the bridge. The sidecar also emits an inputAck event for observability, but
 * that event is deliberately not part of the keyboard path: waiting for it
 * makes a delayed event stall every later keystroke behind one character.
 */

export interface TerminalInputQueueOptions {
  send(sessionId: string, payload: Uint8Array): Promise<void> | void;
  onError?(cause: unknown): void;
  /** Bound a stalled host bridge send so one dropped browser connection cannot
   * keep every later keystroke chained behind a promise that never settles. */
  sendTimeoutMs?: number | ((sessionId: string) => number | undefined);
  /**
   * 串口 B1 通道（`serial/terminal/in/{id}`）专用：设置后负载带 1 字节流
   * 标签前缀（TerminalFrame 形状：标签 + 大端 u64 序号 + 数据），标签取值
   * 由调用方传 `SERIAL_STREAM_STDIN`。缺省保持 ssh/local/telnet 的
   * `8 字节序号 + 数据` 形状不变。
   */
  frameTag?: number;
}

export interface TerminalInputQueue {
  enqueue(sessionId: string, data: Uint8Array): number;
  reset(): void;
}

export class TerminalInputTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Terminal input bridge did not respond within ${timeoutMs} ms`);
    this.name = "TerminalInputTimeoutError";
  }
}

/**
 * 会话 id → 二进制输入通道。本地 PTY 的会话 id 只登记在 sidecar 的 local
 * 会话表：误发 `ssh/terminal/in/{id}` 会被 SSH 会话表以
 * "SSH session was not found or expired" 拒收，每个键入都被吞——本地终端
 * 打不进字的回归即源于此，通道选择必须按会话身份而不是固定通道。
 */
export function terminalInputChannel(sessionId: string, localSessionId: string | undefined): string {
  if (sessionId.startsWith("telnet:")) return `telnet/terminal/in/${sessionId.slice("telnet:".length)}`;
  if (localSessionId && sessionId === localSessionId) return `local/terminal/in/${sessionId}`;
  return `ssh/terminal/in/${sessionId}`;
}

function writeU64(target: Uint8Array, offset: number, value: number) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setBigUint64(offset, BigInt(value), false);
}

export function createTerminalInputQueue(options: TerminalInputQueueOptions): TerminalInputQueue {
  let nextSequence = 0;
  let generation = 0;
  let tail = Promise.resolve();

  function sendWithTimeout(sessionId: string, payload: Uint8Array): Promise<void> {
    const timeoutOption = options.sendTimeoutMs;
    const timeoutMs = typeof timeoutOption === "function" ? timeoutOption(sessionId) : timeoutOption;
    if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(options.send(sessionId, payload));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new TerminalInputTimeoutError(timeoutMs));
      }, timeoutMs);
      Promise.resolve()
        .then(() => options.send(sessionId, payload))
        .then(
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          (cause: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(cause);
          },
        );
    });
  }

  function enqueue(sessionId: string, data: Uint8Array) {
    const sequence = ++nextSequence;
    const itemGeneration = generation;
    const tag = options.frameTag;
    const tagged = tag !== undefined;
    const payload = new Uint8Array((tagged ? 9 : 8) + data.byteLength);
    if (tag !== undefined) payload[0] = tag;
    writeU64(payload, tagged ? 1 : 0, sequence);
    payload.set(data, tagged ? 9 : 8);

    // Serialize sends so wire order is preserved end to end: the sidecar SDK
    // keeps same-channel frames in arrival order (one lane per channel), so
    // arrival order is all that must hold, and full serialization does not
    // depend on the host bridge being FIFO. Do not wait for the broadcast
    // inputAck; sendBinary's completion is the bridge acceptance boundary and
    // the backend applies its own bounded backpressure.
    tail = tail
      .then(async () => {
        // Input queued before a session reset must not leak into the next
        // session. reset() also detaches the next generation from an old send
        // that may never settle after a browser-to-host network loss.
        if (itemGeneration !== generation) return;
        await sendWithTimeout(sessionId, payload);
      })
      .catch((cause) => {
        // A send from the previous session generation may time out after a
        // reconnect reset. Its error must not disconnect the new session.
        if (itemGeneration !== generation) return;
        try {
          options.onError?.(cause);
        } catch {
          // An error banner must not poison the queue for later keystrokes.
        }
      });
    return sequence;
  }

  return {
    enqueue,
    reset() {
      generation += 1;
      nextSequence = 0;
      // A send already in progress cannot be cancelled, but new-session input
      // must not wait for that old bridge promise to settle.
      tail = Promise.resolve();
    },
  };
}
