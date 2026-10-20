import { onBeforeUnmount, type Ref } from "vue";

export const TERMINAL_TRANSPORT_PROBE_INTERVAL_MS = 5_000;
export const TERMINAL_TRANSPORT_PROBE_TIMEOUT_MS = 8_000;
export const TERMINAL_HOST_REACHABILITY_TIMEOUT_MS = 2_000;

type SessionRef = Readonly<Ref<{ sessionId: string } | undefined>>;

/**
 * Detects browser-to-host outages that do not produce an SSH session event.
 * The replay RPC is read-only and also repairs output frames missed before the
 * outage. Browser online/offline events give an immediate signal; the bounded
 * probe covers Docker/WebSocket paths where navigator.onLine stays true.
 */
export function useTerminalTransportWatch(options: {
  terminalState: Ref<string>;
  terminalError: Ref<string>;
  session: SessionRef;
  t: (key: string) => string;
  resetInputQueue: () => void;
  probeTransport: (sessionId: string) => Promise<unknown>;
  canReachHost?: () => Promise<boolean>;
  attachSession: (sessionId: string, retryReference: string) => Promise<void>;
}) {
  const { terminalState, terminalError, session, t, resetInputQueue, probeTransport, attachSession } = options;
  let probeTimer = 0;
  let probeInFlight = false;
  let recoveryInFlight = false;
  let unavailableSessionId = "";
  let stopped = false;

  // DBX Web deployments run the plugin in an HTTP(S) browser context. Native
  // desktop webviews keep their existing host-pushed transport lifecycle.
  const browserDeployment = window.location.protocol === "http:" || window.location.protocol === "https:";

  async function probeHostReachability(): Promise<boolean> {
    if (options.canReachHost) {
      try {
        return await options.canReachHost();
      } catch {
        return false;
      }
    }

    // The invoke timeout is enforced by the host after it receives the HTTP
    // request. It cannot settle a request that is stuck between this browser
    // and the Docker host, so use an abortable same-origin request to decide
    // when it is safe to start attaching again.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TERMINAL_HOST_REACHABILITY_TIMEOUT_MS);
    try {
      await fetch(window.location.href, {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settled = true;
        reject(new Error(`Terminal transport probe timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      Promise.resolve(operation).then(
        (value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(value);
        },
        (cause: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(cause);
        },
      );
    });
  }

  function resumeSession(sessionId: string) {
    if (!sessionId || session.value?.sessionId !== sessionId || terminalState.value !== "disconnected") return;
    unavailableSessionId = "";
    void attachSession(sessionId, sessionId);
  }

  async function recoverSession() {
    const sessionId = unavailableSessionId;
    if (stopped || !browserDeployment || recoveryInFlight || !sessionId) return;
    if (session.value?.sessionId !== sessionId) {
      unavailableSessionId = "";
      return;
    }
    recoveryInFlight = true;
    try {
      if (await probeHostReachability()) resumeSession(sessionId);
    } finally {
      recoveryInFlight = false;
    }
  }

  function reportUnavailable(sessionId: string) {
    if (
      stopped
      || !sessionId
      || session.value?.sessionId !== sessionId
      || (terminalState.value !== "connected" && terminalState.value !== "disconnected")
      || unavailableSessionId === sessionId
    ) return;
    resetInputQueue();
    terminalState.value = "disconnected";
    terminalError.value = t("transportDisconnected");
    unavailableSessionId = sessionId;
    if (browserDeployment) void recoverSession();
    else resumeSession(sessionId);
  }

  async function probe() {
    if (stopped || !browserDeployment || document.visibilityState === "hidden") return;
    if (terminalState.value === "disconnected") {
      await recoverSession();
      return;
    }
    if (probeInFlight || terminalState.value !== "connected") return;
    const sessionId = session.value?.sessionId;
    if (!sessionId) return;
    probeInFlight = true;
    try {
      await withTimeout(Promise.resolve().then(() => probeTransport(sessionId)), TERMINAL_TRANSPORT_PROBE_TIMEOUT_MS);
    } catch {
      // A timeout must be enforced in this page: the host cannot time out an
      // HTTP request it never receives. Leave the connected state and retry
      // only after an abortable same-origin probe confirms the host is back.
      reportUnavailable(sessionId);
    } finally {
      probeInFlight = false;
    }
  }

  function onOffline() {
    const sessionId = session.value?.sessionId;
    if (!sessionId) return;
    reportUnavailable(sessionId);
  }

  function onOnline() {
    void recoverSession();
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") void probe();
  }

  if (browserDeployment) {
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    probeTimer = window.setInterval(() => void probe(), TERMINAL_TRANSPORT_PROBE_INTERVAL_MS);
  }

  onBeforeUnmount(() => {
    stopped = true;
    window.clearInterval(probeTimer);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  return { reportUnavailable };
}
