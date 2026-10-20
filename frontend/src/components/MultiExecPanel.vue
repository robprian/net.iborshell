<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import {
  applyConnectionNames,
  batchTargetLabel,
  normalizeBatchTargets,
  type BatchSendTarget,
} from "../lib/batchSend";
import { randomUUID } from "../lib/uuid";

/** Multi Exec (iBorShell): jalankan satu perintah via kanal ssh/exec
 *  non-interaktif di BANYAK sesi SSH aktif sekaligus (paralel), lalu kumpulkan
 *  output per host di panel ini. Berbeda dari batch send (menulis ke PTY
 *  interaktif): di sini output dikumpulkan dan ditunjukkan per sesi.
 *  Target dari ssh/sessions/list; nama koneksi dari host.listConnections. */
const props = defineProps<{ locale: string; open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

interface MultiExecResult {
  sessionId: string;
  label: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  error: string;
  durationMs: number;
}

const targets = ref<BatchSendTarget[]>([]);
const selected = ref<string[]>([]);
const loading = ref(false);
const loadError = ref("");
const draft = ref("");
const useSudo = ref(false);
const running = ref(false);
const results = ref<MultiExecResult[]>([]);
const runSummary = ref("");

let loadEpoch = 0;

async function loadTargets() {
  const epoch = ++loadEpoch;
  loading.value = true;
  loadError.value = "";
  try {
    const response = await window.dbxPlugin.invoke<{ sessions: unknown }>("ssh/sessions/list");
    let next = normalizeBatchTargets(response.sessions).filter((target) => target.connected !== false);
    try {
      next = applyConnectionNames(next, await window.dbxPlugin.request<unknown>("host.listConnections"));
    } catch {
      // Host lama tanpa listConnections: label fallback user@host.
    }
    if (epoch !== loadEpoch) return;
    targets.value = next;
    const known = new Set(next.map((target) => target.sessionId));
    selected.value = selected.value.filter((id) => known.has(id));
    if (!selected.value.length) selected.value = next.map((target) => target.sessionId);
  } catch (cause) {
    if (epoch !== loadEpoch) return;
    targets.value = [];
    selected.value = [];
    loadError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (epoch === loadEpoch) loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void loadTargets();
  },
  { immediate: true },
);

function toggleTarget(sessionId: string) {
  selected.value = selected.value.includes(sessionId)
    ? selected.value.filter((id) => id !== sessionId)
    : [...selected.value, sessionId];
}

function targetLabel(target: BatchSendTarget): string {
  return batchTargetLabel(target);
}

const canRun = computed(() => !running.value && draft.value.trim().length > 0 && selected.value.length > 0);

async function runOnTarget(target: BatchSendTarget, command: string): Promise<MultiExecResult> {
  const started = performance.now();
  try {
    const result = await window.dbxPlugin.invoke<{ output: string; exitCode: number }>(
      "ssh/exec",
      { sessionId: target.sessionId, execId: randomUUID(), command, sudo: useSudo.value },
      { timeoutMs: 120_000 },
    );
    return {
      sessionId: target.sessionId,
      label: targetLabel(target),
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      output: result.output ?? "",
      error: "",
      durationMs: Math.round(performance.now() - started),
    };
  } catch (cause) {
    return {
      sessionId: target.sessionId,
      label: targetLabel(target),
      ok: false,
      exitCode: null,
      output: "",
      error: cause instanceof Error ? cause.message : String(cause),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

async function runMultiExec() {
  const command = draft.value.trim();
  if (!command || running.value) return;
  const chosen = targets.value.filter((target) => selected.value.includes(target.sessionId));
  if (!chosen.length) return;
  running.value = true;
  results.value = [];
  runSummary.value = "";
  try {
    const settled = await Promise.all(chosen.map((target) => runOnTarget(target, command)));
    results.value = settled;
    const okCount = settled.filter((row) => row.ok).length;
    runSummary.value = t("multiExec.summary", { ok: okCount, total: settled.length });
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="multi-exec">
    <div class="multi-exec-targets-head">
      <span>{{ t("multiExec.targets", { count: selected.length, total: targets.length }) }}</span>
      <button class="link-button" :disabled="loading" @click="loadTargets">
        <RefreshCw :class="{ spinning: loading }" />
        {{ t("multiExec.refresh") }}
      </button>
    </div>
    <p v-if="loading && !targets.length" class="muted">{{ t("multiExec.loading") }}</p>
    <p v-else-if="loadError" class="task-error">{{ loadError }}</p>
    <p v-else-if="!targets.length" class="muted">{{ t("multiExec.noSessions") }}</p>
    <ul v-else class="multi-exec-targets">
      <li v-for="target in targets" :key="target.sessionId">
        <label class="multi-exec-target">
          <input type="checkbox" :checked="selected.includes(target.sessionId)" :disabled="running" @change="toggleTarget(target.sessionId)" />
          <span class="multi-exec-target-label">{{ targetLabel(target) }}</span>
          <span v-if="target.readOnly" class="multi-exec-target-ro">{{ t("readOnly") }}</span>
        </label>
      </li>
    </ul>

    <textarea
      v-model="draft"
      class="mono"
      rows="3"
      spellcheck="false"
      :placeholder="t('multiExec.placeholder')"
      :disabled="running"
      @keydown.ctrl.enter.prevent="runMultiExec"
      @keydown.meta.enter.prevent="runMultiExec"
    />
    <label class="quick-sudo-control" :title="t('quickSudoHint')">
      <input type="checkbox" v-model="useSudo" :disabled="running" />
      <span>{{ t("quickSudo") }}</span>
    </label>

    <div class="multi-exec-actions">
      <button @click="emit('close')">{{ t("close") }}</button>
      <button class="primary-button" :disabled="!canRun" @click="runMultiExec">
        <Loader2 v-if="running" class="spinning" />
        {{ running ? t("multiExec.running") : t("multiExec.runAll", { count: selected.length }) }}
      </button>
    </div>

    <p v-if="runSummary" class="multi-exec-summary">{{ runSummary }}</p>
    <div v-if="results.length" class="multi-exec-results">
      <article v-for="row in results" :key="row.sessionId" class="multi-exec-result" :class="{ failed: !row.ok }">
        <header>
          <CheckCircle2 v-if="row.ok" class="multi-exec-ok-icon" />
          <XCircle v-else class="multi-exec-fail-icon" />
          <strong>{{ row.label }}</strong>
          <span class="multi-exec-meta">
            <template v-if="row.exitCode !== null">exit {{ row.exitCode }} · </template>{{ row.durationMs }} ms
          </span>
        </header>
        <pre v-if="row.output" class="command-output mono">{{ row.output }}</pre>
        <p v-else-if="!row.error" class="muted">{{ t("commandNoOutput") }}</p>
        <p v-if="row.error" class="task-error">{{ row.error }}</p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.multi-exec { display: flex; flex-direction: column; gap: 10px; }
.multi-exec-targets-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.multi-exec-targets { list-style: none; margin: 0; padding: 0; max-height: 140px; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
.multi-exec-target { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.multi-exec-target-ro { font-size: 11px; opacity: 0.7; }
.multi-exec-actions { display: flex; justify-content: flex-end; gap: 8px; }
.multi-exec-summary { font-size: 12px; margin: 0; }
.multi-exec-results { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow: auto; }
.multi-exec-result { border: 1px solid var(--border, #3333); border-radius: 8px; padding: 8px 10px; }
.multi-exec-result header { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.multi-exec-meta { margin-left: auto; font-size: 11px; opacity: 0.75; }
.multi-exec-ok-icon { color: #22c55e; width: 16px; height: 16px; }
.multi-exec-fail-icon { color: #ef4444; width: 16px; height: 16px; }
.multi-exec-result pre { max-height: 160px; overflow: auto; margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; }
</style>
