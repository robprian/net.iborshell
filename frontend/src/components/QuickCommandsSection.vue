<script setup lang="ts">
// 快速命令管理节（M32-A3）：编辑器 + 批量导入两个子视图从工具条弹层迁入
// 设置·终端。纯管理视图：草稿/导入预览在组件内，数据面
// （ssh/quickCommands/* RPC）留在 App——save/import 落库后 App 会整体替换
// commands 数组，组件据此收口子视图。
import { computed, reactive, ref, watch } from "vue";
import { ArrowLeft, ChevronDown, ChevronRight, FileUp, FolderMinus, Pencil, Trash2 } from "@lucide/vue";
import { groupQuickCommands, quickCommandGroupCount, QUICK_COMMAND_GROUP_NAME_MAX_LENGTH, QUICK_COMMAND_NAME_MAX_LENGTH, QUICK_COMMAND_TEXT_MAX_LENGTH, type QuickCommand, type QuickCommandGroupView } from "../lib/quickCommands";
import { mergeQuickCommandImport, parseQuickCommandImport } from "../lib/quickCommandImport";
import { confirmDialog } from "../lib/confirmDialog";
import { randomUUID } from "../lib/uuid";

const props = defineProps<{
  commands: QuickCommand[];
  /** 单条 save 的 RPC 在途态（App 侧）。 */
  saving: boolean;
  /** 批量导入循环 save 的在途态（App 侧）。 */
  importing: boolean;
  limit: number;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  (e: "save", command: { id?: string; name: string; command: string; groupId?: string; groupName?: string }): void;
  (e: "delete", id: string): void;
  (e: "import", items: Array<{ name: string; command: string }>): void;
  (e: "rename-group", payload: { groupId: string; name: string }): void;
  (e: "dissolve-group", groupId: string): void;
  (e: "error", cause: unknown): void;
}>();

const t = props.t;

// —— 分组视图（issue #201）：派生组 + 折叠态 + 组名行内改名 ——
const groups = computed<QuickCommandGroupView[]>(() => groupQuickCommands(props.commands));
const hasRealGroups = computed(() => quickCommandGroupCount(props.commands) > 0);
const realGroups = computed<QuickCommandGroupView[]>(() => groups.value.filter((group) => group.id));
const collapsedGroups = ref<string[]>([]);
const renamingGroupId = ref<string | null>(null);
const renameDraft = ref("");
function toggleGroupCollapse(groupId: string) {
  const index = collapsedGroups.value.indexOf(groupId);
  if (index >= 0) collapsedGroups.value.splice(index, 1);
  else collapsedGroups.value.push(groupId);
}
function groupName(group: QuickCommandGroupView): string {
  return group.id ? group.name : t("quickCommandsUngrouped");
}
function startGroupRename(group: QuickCommandGroupView) {
  if (!group.id) return;
  renamingGroupId.value = group.id;
  renameDraft.value = group.name;
}
function cancelGroupRename() {
  renamingGroupId.value = null;
  renameDraft.value = "";
}
function confirmGroupRename() {
  const groupId = renamingGroupId.value;
  if (!groupId || !renameDraft.value.trim()) return;
  emit("rename-group", { groupId, name: renameDraft.value.trim() });
  cancelGroupRename();
}
/** 删除分组 = 组内命令移回未分组（命令保留）：先确认（同单条删除的确认语义）。 */
async function deleteGroup(group: QuickCommandGroupView) {
  if (!group.id) return;
  if (!(await confirmDialog(t("quickCommandsGroupDeleteConfirm", { name: group.name || group.id })))) return;
  emit("dissolve-group", group.id);
}

/** 编辑器组选择：未分组 / 既有组 / 新建分组（哨兵值 + 名称输入）。 */
const GROUP_CHOICE_UNGROUPED = "";
const GROUP_CHOICE_NEW = "__new__";
const groupChoice = ref(GROUP_CHOICE_UNGROUPED);
const newGroupName = ref("");

// —— 编辑器子视图 ——
const editorOpen = ref(false);
const draft = reactive<{ id?: string; name: string; command: string }>({ name: "", command: "" });

// —— 导入子视图 ——
const importOpen = ref(false);
const importText = ref("");
const importFileName = ref("");
const importPlan = computed(() => parseQuickCommandImport(importText.value));
const importMerge = computed(() => mergeQuickCommandImport(props.commands, importPlan.value));

// 数据面在 App：RPC 成功后 commands 数组被整体替换（引用变化），据此感知
// "本次保存/导入已落库" 再复位子视图；失败时引用不变，草稿/预览保留可继续改。
let awaitingSaveResult = false;
let awaitingImportResult = false;
watch(() => props.commands, () => {
  if (awaitingSaveResult) {
    awaitingSaveResult = false;
    closeEditor();
  }
  if (awaitingImportResult) {
    awaitingImportResult = false;
    closeImport();
  }
});

function openEditor(item?: QuickCommand) {
  draft.id = item?.id;
  draft.name = item?.name ?? "";
  draft.command = item?.command ?? "";
  groupChoice.value = item?.groupId ?? GROUP_CHOICE_UNGROUPED;
  newGroupName.value = "";
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
  draft.id = undefined;
  draft.name = "";
  draft.command = "";
  groupChoice.value = GROUP_CHOICE_UNGROUPED;
  newGroupName.value = "";
}

function openImport() {
  importText.value = "";
  importFileName.value = "";
  importOpen.value = true;
}

function closeImport() {
  importOpen.value = false;
  importText.value = "";
  importFileName.value = "";
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    importText.value = await file.text();
    importFileName.value = file.name;
  } catch (cause) {
    emit("error", cause);
  }
}

function saveCommand() {
  const command = draft.command.trim();
  if (!command || props.saving) return;
  if (!draft.id && props.commands.length >= props.limit) return;
  // 组归属（issue #201）：未分组不落组字段；新建分组生成组 id，组名取输入值。
  let groupId: string | undefined;
  let groupName: string | undefined;
  if (groupChoice.value === GROUP_CHOICE_NEW) {
    const name = newGroupName.value.trim();
    if (name) {
      groupId = randomUUID();
      groupName = name;
    }
  } else if (groupChoice.value) {
    groupId = groupChoice.value;
    groupName = groups.value.find((group) => group.id === groupChoice.value)?.name || groupChoice.value;
  }
  awaitingSaveResult = true;
  emit("save", { id: draft.id, name: draft.name.trim(), command, groupId, groupName });
}

/** 汇总计数（issue #201）：「{groups} 组 · {count} 条」。 */
const groupSummary = computed(() => t("quickCommandsGroupSummary", { groups: quickCommandGroupCount(props.commands), count: props.commands.length }));

/** 删除是不可逆操作：先确认（应用内弹窗——宿主沙箱 window.confirm 恒 false）。 */
async function deleteCommand(id: string) {
  const target = props.commands.find((item) => item.id === id);
  if (target && !(await confirmDialog(t("quickCommandDeleteConfirm", { name: target.name || target.command })))) return;
  emit("delete", id);
}

/** 确认导入：上抛预览 accepted 条目，逐条 save 循环由 App 执行（沿用后端上限校验）。 */
function confirmImport() {
  const merge = importMerge.value;
  if (!merge.accepted.length || props.importing) return;
  awaitingImportResult = true;
  emit("import", merge.accepted);
}
</script>

<template>
  <div class="quick-commands-section">
    <template v-if="importOpen">
      <header class="quick-editor-head">
        <button class="icon-button compact" :title="t('cancel')" :aria-label="t('cancel')" @click="closeImport"><ArrowLeft /></button>
        <h3>{{ t("quickCommandsImport") }}</h3>
      </header>
      <div class="quick-command-editor">
        <label class="quick-import-file">
          <FileUp />
          <span>{{ importFileName || t("quickCommandsImportFile") }}</span>
          <input type="file" accept=".json,application/json,text/plain" @change="onImportFile" />
        </label>
        <textarea v-model="importText" class="mono" rows="6" :placeholder="t('quickCommandsImportPlaceholder')" spellcheck="false" />
        <p v-if="importText.trim()" class="muted quick-import-summary">
          <template v-if="importPlan.invalid < 0">{{ t("quickCommandsImportInvalid") }}</template>
          <template v-else>{{ t("quickCommandsImportSummary", { accepted: importMerge.accepted.length, skipped: importMerge.skippedExisting, dup: importPlan.duplicates, invalid: importPlan.invalid, overflow: importMerge.overflow }) }}</template>
        </p>
        <div class="quick-command-editor-actions">
          <button class="primary-button" :disabled="importing || !importMerge.accepted.length" @click="confirmImport">{{ t("quickCommandsImportConfirm", { count: importMerge.accepted.length }) }}</button>
          <button @click="closeImport">{{ t("cancel") }}</button>
        </div>
        <p class="muted quick-import-note">{{ t("quickCommandsImportPolicy") }}</p>
      </div>
    </template>
    <template v-else-if="editorOpen">
      <header class="quick-editor-head">
        <button class="icon-button compact" :title="t('cancel')" :aria-label="t('cancel')" @click="closeEditor"><ArrowLeft /></button>
        <h3>{{ draft.id ? t("quickCommandsEdit") : t("quickCommandsNew") }}</h3>
      </header>
      <footer class="quick-command-editor">
        <input v-model="draft.name" :placeholder="t('quickCommandsName')" :maxlength="QUICK_COMMAND_NAME_MAX_LENGTH" autofocus />
        <textarea v-model="draft.command" class="mono" rows="4" :placeholder="t('quickCommandsCommand')" :maxlength="QUICK_COMMAND_TEXT_MAX_LENGTH" @keydown.ctrl.enter="saveCommand" />
        <div class="quick-group-editor">
          <label class="quick-group-editor-field">
            <span>{{ t("quickCommandsGroup") }}</span>
            <select v-model="groupChoice" class="quick-group-editor-select">
              <option :value="GROUP_CHOICE_UNGROUPED">{{ t("quickCommandsUngrouped") }}</option>
              <option v-for="group in realGroups" :key="group.id" :value="group.id">{{ groupName(group) }}</option>
              <option :value="GROUP_CHOICE_NEW">{{ t("quickCommandsGroupNew") }}</option>
            </select>
          </label>
          <input v-if="groupChoice === GROUP_CHOICE_NEW" v-model="newGroupName" :placeholder="t('quickCommandsGroupName')" :maxlength="QUICK_COMMAND_GROUP_NAME_MAX_LENGTH" />
        </div>
        <div class="quick-command-editor-actions">
          <button class="primary-button" :disabled="saving || !draft.command.trim() || (!draft.id && commands.length >= limit)" @click="saveCommand">{{ draft.id ? t("save") : t("quickCommandsAdd") }}</button>
          <button @click="closeEditor">{{ t("cancel") }}</button>
          <span class="quick-command-limit">{{ groupSummary }}</span>
        </div>
      </footer>
    </template>
    <template v-else>
      <template v-if="commands.length">
        <template v-if="hasRealGroups">
          <section v-for="group in groups" :key="group.id || '__ungrouped__'" class="quick-manage-group">
            <div class="quick-manage-group-head">
              <button class="quick-group-toggle" :aria-expanded="!collapsedGroups.includes(group.id)" @click="toggleGroupCollapse(group.id)">
                <ChevronDown v-if="!collapsedGroups.includes(group.id)" /><ChevronRight v-else />
                <span class="quick-group-title">{{ groupName(group) }}</span>
                <span class="quick-group-count">{{ group.commands.length }}</span>
              </button>
              <span v-if="group.id" class="settings-list-actions">
                <button class="icon-button" :title="t('quickCommandsGroupRename')" :aria-label="t('quickCommandsGroupRename')" @click="startGroupRename(group)"><Pencil /></button>
                <button class="icon-button" :title="t('quickCommandsGroupDelete')" :aria-label="t('quickCommandsGroupDelete')" @click="deleteGroup(group)"><FolderMinus /></button>
              </span>
            </div>
            <div v-if="renamingGroupId === group.id" class="quick-group-rename">
              <input v-model="renameDraft" :maxlength="QUICK_COMMAND_GROUP_NAME_MAX_LENGTH" :placeholder="t('quickCommandsGroupName')" @keydown.enter="confirmGroupRename" @keydown.esc="cancelGroupRename" />
              <button class="primary-button" :disabled="!renameDraft.trim()" @click="confirmGroupRename">{{ t("save") }}</button>
              <button @click="cancelGroupRename">{{ t("cancel") }}</button>
            </div>
            <ul v-if="!collapsedGroups.includes(group.id)" class="settings-list quick-manage-list">
              <li v-for="item in group.commands" :key="item.id">
                <span class="quick-manage-main">
                  <strong>{{ item.name }}</strong>
                  <span class="mono" :title="item.command">{{ item.command }}</span>
                </span>
                <span class="settings-list-actions">
                  <button class="icon-button" :title="t('quickCommandsEdit')" :aria-label="t('quickCommandsEdit')" @click="openEditor(item)"><Pencil /></button>
                  <button class="icon-button" :title="t('delete')" :aria-label="t('delete')" @click="deleteCommand(item.id)"><Trash2 /></button>
                </span>
              </li>
            </ul>
          </section>
        </template>
        <ul v-else class="settings-list quick-manage-list">
          <li v-for="item in commands" :key="item.id">
            <span class="quick-manage-main">
              <strong>{{ item.name }}</strong>
              <span class="mono" :title="item.command">{{ item.command }}</span>
            </span>
            <span class="settings-list-actions">
              <button class="icon-button" :title="t('quickCommandsEdit')" :aria-label="t('quickCommandsEdit')" @click="openEditor(item)"><Pencil /></button>
              <button class="icon-button" :title="t('delete')" :aria-label="t('delete')" @click="deleteCommand(item.id)"><Trash2 /></button>
            </span>
          </li>
        </ul>
      </template>
      <p v-else class="muted settings-note">{{ t("quickCommandsEmpty") }}</p>
      <p class="muted settings-note">{{ groupSummary }}</p>
      <footer class="quick-manage-actions">
        <button class="link-button" type="button" :disabled="commands.length >= limit" @click="openEditor()">{{ t("quickCommandsNew") }}</button>
        <button class="link-button" type="button" :disabled="commands.length >= limit" @click="openImport()">{{ t("quickCommandsImport") }}</button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
/* 设置页管理视图：简单两行卡片（名称 + 命令）+ 行内编辑/删除，样式对齐
   startup-commands-list 的 settings-list 行为。 */
.quick-manage-list { max-height: min(320px, calc(100vh - 380px)); overflow-y: auto; }
.quick-manage-main { display: flex; min-width: 0; flex: 1 1 auto; flex-direction: column; gap: 1px; }
.quick-manage-main strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.quick-manage-main .mono { overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.quick-manage-actions { display: flex; align-items: center; gap: 16px; }
/* 分组（issue #201）：组头折叠 + 行内改名 + 编辑器组选择。 */
.quick-manage-group-head { display: flex; align-items: center; gap: 4px; }
.quick-group-toggle { display: flex; flex: 1; min-width: 0; align-items: center; gap: 5px; border: 0; padding: 3px 2px; background: transparent; color: var(--muted-foreground); text-align: left; cursor: pointer; }
.quick-group-toggle:hover { color: var(--foreground); }
.quick-group-toggle svg { width: 13px; height: 13px; flex: 0 0 13px; }
.quick-group-title { min-width: 0; flex: 1; overflow: hidden; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.quick-group-count { flex: 0 0 auto; border-radius: 8px; padding: 0 6px; background: var(--muted); color: var(--muted-foreground); font-size: 9px; line-height: 15px; }
.quick-group-rename { display: flex; align-items: center; gap: 6px; margin: 2px 0 4px; }
.quick-group-rename input { flex: 1; min-width: 0; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
.quick-group-editor { display: flex; align-items: center; gap: 6px; }
.quick-group-editor-field { display: flex; min-width: 0; flex: 1; align-items: center; gap: 6px; }
.quick-group-editor-field > span { flex: 0 0 auto; color: var(--muted-foreground); font-size: 11px; }
.quick-group-editor-select { flex: 1; min-width: 0; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 6px; background: var(--background); color: var(--foreground); font-size: 12px; }
.quick-group-editor > input { flex: 1; min-width: 0; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
/* 迁入自 App.vue 弹层（编辑器/导入子视图原样式，见 App.vue <style scoped> 历史）。 */
.quick-editor-head { display: flex; align-items: center; gap: 6px; }
.quick-editor-head h3 { flex: 1; margin: 0; }
.quick-command-editor { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
.quick-command-editor input { width: 100%; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
.quick-command-editor textarea { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; background: var(--background); color: var(--foreground); font-size: 12px; line-height: 1.5; }
.quick-command-editor input:focus, .quick-command-editor textarea:focus { border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); outline: none; }
.quick-command-editor-actions { display: flex; align-items: center; gap: 6px; }
.quick-command-editor-actions .quick-command-limit { flex: 1; overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.quick-import-file { display: flex; align-items: center; gap: 6px; height: 26px; border: 1px dashed var(--border); border-radius: var(--radius); padding: 0 8px; font-size: 11px; color: var(--muted-foreground); cursor: pointer; }
.quick-import-file:hover { border-color: color-mix(in srgb, var(--primary) 60%, var(--border)); background: var(--accent); }
.quick-import-file svg { width: 13px; height: 13px; flex: none; }
.quick-import-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quick-import-file input[type="file"] { display: none; }
.quick-import-summary { margin: 0; font-size: 10px; line-height: 1.5; }
.quick-import-note { margin: 0; font-size: 10px; line-height: 1.5; }
</style>
