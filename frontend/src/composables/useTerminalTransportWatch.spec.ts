// @vitest-environment happy-dom
import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_HOST_REACHABILITY_TIMEOUT_MS,
  TERMINAL_TRANSPORT_PROBE_INTERVAL_MS,
  TERMINAL_TRANSPORT_PROBE_TIMEOUT_MS,
  useTerminalTransportWatch,
} from "./useTerminalTransportWatch";

describe("useTerminalTransportWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("leaves connected state when the host invoke promise never settles", async () => {
    vi.useFakeTimers();
    const terminalState = ref("connected");
    const terminalError = ref("");
    const session = ref({ sessionId: "session-1" });
    const probeTransport = vi.fn(() => new Promise<never>(() => {}));
    const canReachHost = vi.fn().mockResolvedValue(false);
    const resetInputQueue = vi.fn();
    const attachSession = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(defineComponent({
      setup() {
        useTerminalTransportWatch({
          terminalState,
          terminalError,
          session,
          t: (key) => key,
          resetInputQueue,
          probeTransport,
          canReachHost,
          attachSession,
        });
        return () => null;
      },
    }));

    await vi.advanceTimersByTimeAsync(TERMINAL_TRANSPORT_PROBE_INTERVAL_MS);
    expect(probeTransport).toHaveBeenCalledWith("session-1");

    await vi.advanceTimersByTimeAsync(TERMINAL_TRANSPORT_PROBE_TIMEOUT_MS);

    expect(terminalState.value).toBe("disconnected");
    expect(terminalError.value).toBe("transportDisconnected");
    expect(resetInputQueue).toHaveBeenCalledOnce();
    expect(canReachHost).toHaveBeenCalledOnce();
    expect(attachSession).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("reattaches only after an online event confirms the host is reachable", async () => {
    vi.useFakeTimers();
    const terminalState = ref("connected");
    const terminalError = ref("");
    const session = ref({ sessionId: "session-1" });
    const probeTransport = vi.fn().mockRejectedValue(new Error("host bridge unavailable"));
    const canReachHost = vi.fn().mockResolvedValue(false);
    const attachSession = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(defineComponent({
      setup() {
        useTerminalTransportWatch({
          terminalState,
          terminalError,
          session,
          t: (key) => key,
          resetInputQueue: vi.fn(),
          probeTransport,
          canReachHost,
          attachSession,
        });
        return () => null;
      },
    }));

    await vi.advanceTimersByTimeAsync(TERMINAL_TRANSPORT_PROBE_INTERVAL_MS);
    await Promise.resolve();
    expect(terminalState.value).toBe("disconnected");
    expect(attachSession).not.toHaveBeenCalled();

    canReachHost.mockResolvedValue(true);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(TERMINAL_TRANSPORT_PROBE_INTERVAL_MS);

    expect(attachSession).toHaveBeenCalledWith("session-1", "session-1");
    wrapper.unmount();
  });

  it("aborts the same-origin recovery probe when the Docker host does not respond", async () => {
    vi.useFakeTimers();
    const terminalState = ref("connected");
    const terminalError = ref("");
    const session = ref({ sessionId: "session-1" });
    const attachSession = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);

    let reportUnavailable!: (sessionId: string) => void;
    const wrapper = mount(defineComponent({
      setup() {
        ({ reportUnavailable } = useTerminalTransportWatch({
          terminalState,
          terminalError,
          session,
          t: (key) => key,
          resetInputQueue: vi.fn(),
          probeTransport: vi.fn().mockResolvedValue(undefined),
          attachSession,
        }));
        return () => null;
      },
    }));

    reportUnavailable("session-1");
    await vi.advanceTimersByTimeAsync(TERMINAL_HOST_REACHABILITY_TIMEOUT_MS);

    expect(fetchMock).toHaveBeenCalledWith(window.location.href, expect.objectContaining({
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
    }));
    expect(terminalState.value).toBe("disconnected");
    expect(attachSession).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
