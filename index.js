import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUDIT_ENTRY_TYPE = "pi-codex-compact.hidden-commentary";
const HIDDEN_SUMMARY_WIDGET_KEY = "pi-codex-compact.hidden-summary";
const RENDER_PATCH_VERSION = 5;
const TOOL_RENDER_PATCH_VERSION = 1;
const INTERACTIVE_PATCH_VERSION = 12;
const RENDER_PATCH_SYMBOL = Symbol.for("pi-codex-compact.assistant-renderer-patched");
const RENDER_PATCH_DATA_SYMBOL = Symbol.for("pi-codex-compact.assistant-renderer-patch-data");
const TOOL_RENDER_PATCH_SYMBOL = Symbol.for("pi-codex-compact.tool-renderer-patched");
const TOOL_RENDER_PATCH_DATA_SYMBOL = Symbol.for("pi-codex-compact.tool-renderer-patch-data");
const INTERACTIVE_PATCH_SYMBOL = Symbol.for("pi-codex-compact.interactive-render-patched");
const INTERACTIVE_PATCH_DATA_SYMBOL = Symbol.for("pi-codex-compact.interactive-render-patch-data");
const INTERACTIVE_INSTANCE_SYMBOL = Symbol.for("pi-codex-compact.interactive-instance");
const ACTIVITY_NOTICE_RENDER_PATCH_DATA_SYMBOL = Symbol.for("pi-codex-compact.activity-notice-render-patch-data");
const REGISTRATION_KEY = Symbol.for("pi-codex-compact.registration");
const INSTANCE_ID = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

const DEFAULT_CONFIG = {
  enabled: true,
  stripCommentaryText: false,
  foldCompletedToolBatches: true,
  toolBatchFoldShortcut: "alt+p",
  toolBatchFoldMarker: "⌕ {summary}{errors}  {chevron}",
  auditHiddenCommentary: true,
  auditMaxTextChars: 200000,
  patchInternalRenderers: true,
  showHiddenCommentaryMarker: true,
  hiddenCommentaryMarker: "[commentary hidden: {count} block(s); press {shortcut} for summary below]",
  hiddenSummaryShortcut: "",
  assistantMessageModulePath: "",
  interactiveModeModulePath: "",
  collapseToolOutput: false,
  hideWorkingRow: false,
  hiddenThinkingLabel: "Thinking hidden",
  workingMessage: "working…",
};

function normalizeConfig(rawConfig) {
  const config = { ...DEFAULT_CONFIG };
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return config;
  }

  for (const key of [
    "enabled",
    "stripCommentaryText",
    "foldCompletedToolBatches",
    "auditHiddenCommentary",
    "patchInternalRenderers",
    "showHiddenCommentaryMarker",
    "collapseToolOutput",
    "hideWorkingRow",
  ]) {
    if (typeof rawConfig[key] === "boolean") {
      config[key] = rawConfig[key];
    }
  }

  for (const key of [
    "assistantMessageModulePath",
    "interactiveModeModulePath",
    "hiddenCommentaryMarker",
    "hiddenSummaryShortcut",
    "toolBatchFoldShortcut",
    "toolBatchFoldMarker",
    "hiddenThinkingLabel",
    "workingMessage",
  ]) {
    if (typeof rawConfig[key] === "string") {
      config[key] = rawConfig[key];
    }
  }

  if (typeof rawConfig.toolBatchFoldShortcut !== "string" && typeof rawConfig.turnProcessFoldShortcut === "string") {
    config.toolBatchFoldShortcut = rawConfig.turnProcessFoldShortcut;
  }
  if (typeof rawConfig.toolBatchFoldMarker !== "string" && typeof rawConfig.processFoldMarker === "string") {
    config.toolBatchFoldMarker = rawConfig.processFoldMarker;
  }
  if (typeof rawConfig.patchInternalRenderers !== "boolean" && typeof rawConfig.patchAssistantRenderer === "boolean") {
    config.patchInternalRenderers = rawConfig.patchAssistantRenderer;
  }

  if (Number.isFinite(rawConfig.auditMaxTextChars) && rawConfig.auditMaxTextChars > 0) {
    config.auditMaxTextChars = Math.floor(rawConfig.auditMaxTextChars);
  }

  return config;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return normalizeConfig(undefined);
  }

  try {
    return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch (error) {
    return {
      ...DEFAULT_CONFIG,
      loadError: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseTextSignature(signature) {
  if (!signature || typeof signature !== "string") {
    return undefined;
  }

  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature);
      if (parsed?.v === 1 && typeof parsed.id === "string") {
        return {
          id: parsed.id,
          phase: parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined,
        };
      }
    } catch {
      // 兼容旧版纯字符串签名。
    }
  }

  return { id: signature };
}

function isCommentaryTextBlock(block) {
  if (!block || block.type !== "text") {
    return false;
  }

  return parseTextSignature(block.textSignature)?.phase === "commentary";
}

function collectCommentaryTextBlocks(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  return message.content.filter(isCommentaryTextBlock);
}

function truncateText(text, maxChars) {
  if (typeof text !== "string") {
    return { text, truncated: false, originalLength: 0 };
  }

  const prefix = [];
  let originalLength = 0;
  for (const character of text) {
    if (originalLength < maxChars) {
      prefix.push(character);
    }
    originalLength += 1;
  }

  if (originalLength <= maxChars) {
    return { text, truncated: false, originalLength };
  }

  return {
    text: prefix.join(""),
    truncated: true,
    originalLength,
  };
}

function buildHiddenCommentaryAuditEntry(message, hiddenBlocks, config) {
  return {
    version: 1,
    reason: "assistant textSignature phase=commentary hidden by pi-codex-compact",
    source: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel,
      responseId: message.responseId,
      stopReason: message.stopReason,
      timestamp: message.timestamp,
    },
    hiddenBlocks: hiddenBlocks.map((block, index) => ({
      index,
      textSignature: block.textSignature,
      ...truncateText(block.text, config.auditMaxTextChars),
    })),
  };
}

function hasDisplayableAssistantContent(content) {
  return content.some((block) => {
    if (block.type === "toolCall") {
      return true;
    }
    if (block.type === "thinking") {
      return true;
    }
    return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
  });
}

function stripCommentaryFromMessage(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }

  const filteredContent = message.content.filter((block) => !isCommentaryTextBlock(block));
  if (filteredContent.length === message.content.length) {
    return message;
  }

  // 防误删：如果过滤后没有任何可展示内容，就保留原消息。
  // 这会牺牲一点紧凑度，但避免某些供应商只返回 commentary phase 时整条回复消失。
  if (!hasDisplayableAssistantContent(filteredContent)) {
    return message;
  }

  return {
    ...message,
    content: filteredContent,
  };
}

function formatHiddenCommentaryMarker(count, config) {
  const template = config.hiddenCommentaryMarker || DEFAULT_CONFIG.hiddenCommentaryMarker;
  const shortcut = config.hiddenSummaryShortcut || "/codex-compact latest";
  return template
    .replaceAll("{count}", String(count))
    .replaceAll("{shortcut}", shortcut);
}

function addHiddenCommentaryMarker(content, count, config) {
  if (!config.showHiddenCommentaryMarker || count <= 0) {
    return content;
  }

  return [
    {
      type: "text",
      text: formatHiddenCommentaryMarker(count, config),
    },
    ...content,
  ];
}

function prepareMessageForRendering(message, config) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }

  const filteredContent = message.content.filter((block) => !isCommentaryTextBlock(block));
  const hiddenCount = message.content.length - filteredContent.length;

  if (hiddenCount <= 0) {
    return message;
  }

  if (!hasDisplayableAssistantContent(filteredContent)) {
    return message;
  }

  return {
    ...message,
    content: addHiddenCommentaryMarker(filteredContent, hiddenCount, config),
  };
}

let expandedToolActivitySegmentKey = null;
let activeToolBatchKey = null;
let lastInteractiveModeInstance;
let lastRenderedToolActivitySegments = [];
let openToolActivitySegment;
let foldedAssistantProjections = new Map();
let foldedToolCallIds = new Set();
let foldedActivityNoticeComponents = new WeakSet();
const activityNoticeRecordsBySegmentKey = new Map();
const activityNoticeRecordByTextComponent = new WeakMap();
const pendingActivityNoticeRecords = new Set();
const trackedActivityNoticeRecords = new Set();
const assistantComponentSources = new WeakMap();
const assistantComponentKeys = new WeakMap();
const projectedAssistantSources = new WeakMap();
const assistantComponentsByKey = new Map();
let rawToolBatchInputUnsubscribe;
let patchedAssistantPrototype;
let patchedToolExecutionPrototype;
let patchedInteractivePrototype;
let toolsExpandedBeforeEnable;
let toolsExpandedCaptured = false;

function resetToolBatchFoldState() {
  clearActivityNoticeState();
  expandedToolActivitySegmentKey = null;
  activeToolBatchKey = null;
  lastRenderedToolActivitySegments = [];
  openToolActivitySegment = undefined;
  foldedAssistantProjections = new Map();
  foldedToolCallIds = new Set();
}

function isToolBatchFoldingEnabled(config) {
  return Boolean(
    config?.enabled
    && config.patchInternalRenderers
    && config.foldCompletedToolBatches,
  );
}

function getToolCalls(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((block) => block?.type === "toolCall");
}

function assistantMessageKey(message) {
  if (message?.role !== "assistant") {
    return undefined;
  }
  if (typeof message.responseId === "string" && message.responseId.length > 0) {
    return `assistant_response_${stableHash(message.responseId)}`;
  }
  if (message.timestamp === undefined || message.timestamp === null) {
    return undefined;
  }
  return `assistant_${stableHash(String(message.timestamp))}`;
}

function toolBatchKey(message, calls) {
  if (typeof message?.responseId === "string" && message.responseId.length > 0) {
    return `tool_batch_response_${stableHash(message.responseId)}`;
  }
  if (message?.timestamp === undefined || message?.timestamp === null) {
    return undefined;
  }
  return `tool_batch_${stableHash(`${String(message.timestamp)}:${calls.map((call) => call.id).join(",")}`)}`;
}

function toolCategory(toolName) {
  const normalized = String(toolName ?? "").toLowerCase().split(/[.:/]/).at(-1);
  if (normalized === "read") {
    return "read";
  }
  if (["grep", "rg", "ffgrep", "find", "fffind", "fast_context_search", "search"].includes(normalized)) {
    return "search";
  }
  if (normalized === "bash") {
    return "command";
  }
  if (normalized === "edit" || normalized === "write") {
    return "modify";
  }
  return "other";
}

function inspectToolBatch(message, results) {
  const calls = getToolCalls(message);
  if (calls.length === 0) {
    return undefined;
  }
  if (calls.some((call) => {
    const name = String(call?.name ?? "").toLowerCase().split(/[.:/]/).at(-1);
    return name === "subagent" || name.endsWith("_subagent");
  })) {
    return { valid: false, complete: false, calls, results: [] };
  }

  const callIds = new Set();
  for (const call of calls) {
    if (typeof call?.id !== "string" || call.id.length === 0 || callIds.has(call.id)) {
      return { valid: false, complete: false, calls, results: [] };
    }
    callIds.add(call.id);
  }

  const key = toolBatchKey(message, calls);
  if (!key || message.stopReason !== "toolUse") {
    return { valid: false, complete: false, calls, results: [] };
  }

  const resultMap = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const resultId = result?.toolCallId;
    if (result?.role !== "toolResult" || !callIds.has(resultId) || resultMap.has(resultId)) {
      return { valid: false, complete: false, key, calls, results: [] };
    }
    resultMap.set(resultId, result);
  }

  const counts = { total: calls.length, read: 0, search: 0, command: 0, modify: 0, other: 0, errors: 0 };
  for (const call of calls) {
    counts[toolCategory(call.name)] += 1;
  }
  for (const result of resultMap.values()) {
    if (result.isError === true) {
      counts.errors += 1;
    }
  }

  return {
    valid: true,
    complete: resultMap.size === calls.length,
    key,
    message,
    calls,
    results: [...resultMap.values()],
    counts,
  };
}

function scanToolBatches(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const callIdCounts = new Map();
  for (const item of items) {
    for (const call of getToolCalls(item)) {
      if (typeof call?.id === "string" && call.id.length > 0) {
        callIdCounts.set(call.id, (callIdCounts.get(call.id) ?? 0) + 1);
      }
    }
  }

  const batches = [];
  for (let index = 0; index < items.length; index += 1) {
    const message = items[index];
    if (getToolCalls(message).length === 0) {
      continue;
    }

    const results = [];
    for (let resultIndex = index + 1; resultIndex < items.length; resultIndex += 1) {
      const candidate = items[resultIndex];
      if (candidate?.role === "assistant" || candidate?.role === "user") {
        break;
      }
      if (candidate?.role === "toolResult") {
        results.push(candidate);
      }
    }

    const batch = inspectToolBatch(message, results);
    if (batch?.valid && batch.complete) {
      batches.push({ ...batch, assistantIndex: index });
    }
  }

  // 稳定键冲突时无法安全切换单个批次，保守保持展开。
  const keyCounts = new Map();
  for (const batch of batches) {
    keyCounts.set(batch.key, (keyCounts.get(batch.key) ?? 0) + 1);
  }

  return batches.filter(
    (batch) => keyCounts.get(batch.key) === 1
      && batch.calls.every((call) => callIdCounts.get(call.id) === 1),
  );
}

function hasVisibleAssistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some(
    (block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  );
}

function buildToolActivitySegment(batches, assistantMessages, assistantIndexes = [], openAtEnd = false) {
  if (!Array.isArray(batches) || batches.length === 0 || !Array.isArray(assistantMessages)) {
    return undefined;
  }

  const assistantKeys = assistantMessages.map(assistantMessageKey);
  if (assistantKeys.some((key) => !key) || new Set(assistantKeys).size !== assistantKeys.length) {
    return undefined;
  }

  const toolCallIds = batches.flatMap((batch) => batch.calls.map((call) => call.id));
  if (new Set(toolCallIds).size !== toolCallIds.length) {
    return undefined;
  }

  const counts = { total: 0, read: 0, search: 0, command: 0, modify: 0, other: 0, errors: 0 };
  for (const batch of batches) {
    for (const key of Object.keys(counts)) {
      counts[key] += batch.counts[key] ?? 0;
    }
  }

  return {
    key: `tool_activity_segment_${stableHash(batches[0].key)}`,
    batches: [...batches],
    counts,
    assistantMessages: [...assistantMessages],
    assistantKeys,
    assistantIndexes: [...assistantIndexes],
    markerAssistantKey: assistantMessageKey(batches[0].message),
    markerAssistantIndex: batches[0].assistantIndex,
    toolCallIds,
    openAtEnd,
  };
}

function scanToolActivitySegments(items, excludedBatchKey) {
  if (!Array.isArray(items)) {
    return [];
  }

  const batchesByIndex = new Map(
    scanToolBatches(items)
      .filter((batch) => batch.key !== excludedBatchKey)
      .map((batch) => [batch.assistantIndex, batch]),
  );
  const segments = [];
  let pendingSegment;

  const finishPendingSegment = (openAtEnd = false) => {
    if (!pendingSegment || pendingSegment.batches.length === 0) {
      pendingSegment = undefined;
      return;
    }

    const segment = buildToolActivitySegment(
      pendingSegment.batches,
      pendingSegment.assistantMessages,
      pendingSegment.assistantIndexes,
      openAtEnd,
    );
    if (segment) {
      segments.push(segment);
    }
    pendingSegment = undefined;
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const batch = batchesByIndex.get(index);
    const hasToolCalls = getToolCalls(item).length > 0;

    // Active batches stay expanded while preserving the preceding merge window; malformed batches close it.
    if (hasToolCalls && !batch) {
      const calls = getToolCalls(item);
      const isExcludedActiveBatch = toolBatchKey(item, calls) === excludedBatchKey;
      finishPendingSegment(isExcludedActiveBatch);
      continue;
    }

    if (batch) {
      // Narrative-bearing batches start a new segment; their text remains visible.
      if (hasVisibleAssistantText(item)) {
        finishPendingSegment();
      }
      if (!pendingSegment) {
        pendingSegment = { batches: [], assistantIndexes: new Set(), assistantMessages: [] };
      }
      pendingSegment.batches.push(batch);
      pendingSegment.assistantIndexes.add(index);
      pendingSegment.assistantMessages.push(item);
      continue;
    }

    if (item?.role === "toolResult") {
      continue;
    }

    // Extension metadata stays in the render stream but does not split one tool activity.
    if (item?.type === "custom") {
      continue;
    }

    if (item?.role === "assistant" && Array.isArray(item.content) && !hasVisibleAssistantText(item)) {
      if (pendingSegment) {
        pendingSegment.assistantIndexes.add(index);
        pendingSegment.assistantMessages.push(item);
      }
      continue;
    }

    // Visible assistant text, user input, compaction summaries, and other structural items separate segments.
    finishPendingSegment();
  }

  finishPendingSegment(true);

  // Message identity collisions make component-level projection ambiguous, so those segments fail open.
  const assistantKeyCounts = new Map();
  for (const segment of segments) {
    for (const key of segment.assistantKeys) {
      assistantKeyCounts.set(key, (assistantKeyCounts.get(key) ?? 0) + 1);
    }
  }
  return segments.filter(
    (segment) => segment.assistantKeys.every((key) => assistantKeyCounts.get(key) === 1),
  );
}

function isFoldableActivityNotice(message, type) {
  if (type === "warning" || type === "error" || typeof message !== "string") {
    return false;
  }
  return message.startsWith("Observational memory:") || message.startsWith("RTK rewrite:");
}

function patchActivityNoticeComponent(component) {
  if (!component || typeof component.render !== "function") {
    return false;
  }
  const currentPatch = component[ACTIVITY_NOTICE_RENDER_PATCH_DATA_SYMBOL];
  if (currentPatch) {
    return currentPatch.owner === INSTANCE_ID;
  }

  const originalRender = component.render;
  component[ACTIVITY_NOTICE_RENDER_PATCH_DATA_SYMBOL] = { owner: INSTANCE_ID, originalRender };
  component.render = function patchedActivityNoticeRender(width) {
    if (foldedActivityNoticeComponents.has(this)) {
      return [];
    }
    return originalRender.call(this, width);
  };
  return true;
}

function restoreActivityNoticeComponent(component) {
  const patchData = component?.[ACTIVITY_NOTICE_RENDER_PATCH_DATA_SYMBOL];
  if (patchData?.owner !== INSTANCE_ID || typeof patchData.originalRender !== "function") {
    return;
  }
  component.render = patchData.originalRender;
  component[ACTIVITY_NOTICE_RENDER_PATCH_DATA_SYMBOL] = undefined;
}

function unassignActivityNoticeRecord(record) {
  pendingActivityNoticeRecords.delete(record);
  for (const [segmentKey, records] of activityNoticeRecordsBySegmentKey) {
    records.delete(record);
    if (records.size === 0) {
      activityNoticeRecordsBySegmentKey.delete(segmentKey);
    }
  }
  foldedActivityNoticeComponents.delete(record.spacer);
  foldedActivityNoticeComponents.delete(record.textComponent);
}

function releaseActivityNoticeRecord(record) {
  unassignActivityNoticeRecord(record);
  restoreActivityNoticeComponent(record.spacer);
  restoreActivityNoticeComponent(record.textComponent);
  activityNoticeRecordByTextComponent.delete(record.textComponent);
  trackedActivityNoticeRecords.delete(record);
}

function clearActivityNoticeState() {
  for (const record of [...trackedActivityNoticeRecords]) {
    releaseActivityNoticeRecord(record);
  }
  activityNoticeRecordsBySegmentKey.clear();
  pendingActivityNoticeRecords.clear();
  foldedActivityNoticeComponents = new WeakSet();
}

function attachActivityNoticeRecord(record, segmentKey) {
  unassignActivityNoticeRecord(record);
  const records = activityNoticeRecordsBySegmentKey.get(segmentKey) ?? new Set();
  records.add(record);
  activityNoticeRecordsBySegmentKey.set(segmentKey, records);
}

function attachPendingActivityNotices(segmentKey) {
  for (const record of [...pendingActivityNoticeRecords]) {
    attachActivityNoticeRecord(record, segmentKey);
  }
}

function discardPendingActivityNotices() {
  for (const record of [...pendingActivityNoticeRecords]) {
    releaseActivityNoticeRecord(record);
  }
}

function captureActivityNotice(instance, message, type) {
  if (type === "info" || type === undefined) {
    const existing = activityNoticeRecordByTextComponent.get(instance?.lastStatusText);
    if (!isFoldableActivityNotice(message, type)) {
      if (existing) {
        releaseActivityNoticeRecord(existing);
        applyToolActivitySegments(lastRenderedToolActivitySegments, true);
      }
      return;
    }

    const textComponent = instance?.lastStatusText;
    const spacer = instance?.lastStatusSpacer;
    if (!textComponent || !spacer) {
      return;
    }

    let record = existing;
    if (!record) {
      if (!patchActivityNoticeComponent(spacer) || !patchActivityNoticeComponent(textComponent)) {
        restoreActivityNoticeComponent(spacer);
        restoreActivityNoticeComponent(textComponent);
        return;
      }
      record = { spacer, textComponent };
      activityNoticeRecordByTextComponent.set(textComponent, record);
      trackedActivityNoticeRecords.add(record);
    }

    // Keep Pi's next status update from overwriting a notice that Alt+P must restore.
    if (instance.lastStatusText === textComponent) {
      instance.lastStatusText = undefined;
      instance.lastStatusSpacer = undefined;
    }

    unassignActivityNoticeRecord(record);
    if (activeToolBatchKey || !openToolActivitySegment) {
      pendingActivityNoticeRecords.add(record);
      return;
    }

    attachActivityNoticeRecord(record, openToolActivitySegment.key);
    applyToolActivitySegments(lastRenderedToolActivitySegments, true);
    instance.ui?.requestRender?.();
  }
}

function formatToolBatchSummary(batch) {
  const counts = batch?.counts ?? {};
  const parts = [];
  if (counts.read > 0) parts.push(`已读取 ${counts.read} 个文件`);
  if (counts.search > 0) parts.push(`搜索 ${counts.search} 次`);
  if (counts.command > 0) parts.push(`运行 ${counts.command} 个命令`);
  if (counts.modify > 0) parts.push(`修改 ${counts.modify} 次`);
  if (counts.other > 0) parts.push(`调用 ${counts.other} 个其他工具`);
  const noticeCount = activityNoticeRecordsBySegmentKey.get(batch?.key)?.size ?? 0;
  if (noticeCount > 0) parts.push(`后台通知 ${noticeCount} 条`);
  return parts.join("、");
}

function formatToolBatchFoldMarker(batch, config, ctx) {
  const template = config.toolBatchFoldMarker || DEFAULT_CONFIG.toolBatchFoldMarker;
  const summary = formatToolBatchSummary(batch);
  const errors = `；${batch.counts.errors} 个错误`;
  const marker = template
    .replaceAll("{summary}", summary)
    .replaceAll("{errors}", errors)
    .replaceAll("{chevron}", "▾")
    .replaceAll("{state}", "hidden")
    .replaceAll("{total}", String(batch.counts.total))
    .replaceAll("{details}", `${summary}${errors}`)
    .replaceAll("{shortcut}", config.toolBatchFoldShortcut || "alt+p")
    .replaceAll("{action}", "show");
  return themeFg(ctx, "dim", marker);
}

function projectAssistantForToolActivity(message, projection, config, ctx) {
  if (message?.role !== "assistant" || !Array.isArray(message.content) || !projection) {
    return message;
  }

  let markerAdded = false;
  const content = message.content.flatMap((block) => {
    if (block?.type === "thinking") {
      return [];
    }
    if (block?.type !== "toolCall") {
      return [block];
    }
    if (!projection.marker || markerAdded) {
      return [];
    }
    markerAdded = true;
    return [{ type: "text", text: formatToolBatchFoldMarker(projection.segment, config, ctx) }];
  });
  return { ...message, content };
}

function registerAssistantComponent(component, sourceMessage) {
  const key = assistantMessageKey(sourceMessage);
  const previousKey = assistantComponentKeys.get(component);
  if (previousKey && previousKey !== key) {
    const previousComponents = assistantComponentsByKey.get(previousKey);
    previousComponents?.delete(component);
    if (previousComponents?.size === 0) {
      assistantComponentsByKey.delete(previousKey);
    }
  }

  assistantComponentSources.set(component, sourceMessage);
  if (!key) {
    assistantComponentKeys.delete(component);
    return;
  }
  assistantComponentKeys.set(component, key);
  const components = assistantComponentsByKey.get(key) ?? new Set();
  components.add(component);
  assistantComponentsByKey.set(key, components);
}

function clearAssistantComponentRegistry() {
  assistantComponentsByKey.clear();
}

function refreshFoldedAssistantComponents() {
  for (const components of assistantComponentsByKey.values()) {
    for (const component of components) {
      const source = assistantComponentSources.get(component);
      if (!source || typeof component.updateContent !== "function") {
        continue;
      }
      try {
        component.updateContent(source);
      } catch (error) {
        warnCompactUiFailure("assistant component refresh", error);
      }
    }
  }
}

function applyToolActivitySegments(segments, refresh = false) {
  const nextAssistantProjections = new Map();
  const nextToolCallIds = new Set();
  const nextFoldedActivityNoticeComponents = new WeakSet();
  for (const segment of segments) {
    if (segment.key === expandedToolActivitySegmentKey) {
      continue;
    }
    for (const key of segment.assistantKeys) {
      nextAssistantProjections.set(key, {
        segment,
        marker: key === segment.markerAssistantKey,
      });
    }
    for (const toolCallId of segment.toolCallIds) {
      nextToolCallIds.add(toolCallId);
    }
    for (const record of activityNoticeRecordsBySegmentKey.get(segment.key) ?? []) {
      nextFoldedActivityNoticeComponents.add(record.spacer);
      nextFoldedActivityNoticeComponents.add(record.textComponent);
    }
  }

  lastRenderedToolActivitySegments = segments;
  openToolActivitySegment = segments.at(-1)?.openAtEnd ? segments.at(-1) : undefined;
  foldedAssistantProjections = nextAssistantProjections;
  foldedToolCallIds = nextToolCallIds;
  foldedActivityNoticeComponents = nextFoldedActivityNoticeComponents;
  if (refresh) {
    refreshFoldedAssistantComponents();
  }
}

function prepareItemsForToolBatchFolding(items, config) {
  if (!config.enabled || !config.foldCompletedToolBatches || !Array.isArray(items)) {
    applyToolActivitySegments([]);
    return items;
  }

  applyToolActivitySegments(scanToolActivitySegments(items, activeToolBatchKey));
  return items;
}

function closeOpenToolActivitySegment() {
  if (!openToolActivitySegment) {
    return;
  }
  const closed = { ...openToolActivitySegment, openAtEnd: false };
  const segments = lastRenderedToolActivitySegments.map(
    (segment) => segment.key === closed.key ? closed : segment,
  );
  openToolActivitySegment = undefined;
  applyToolActivitySegments(segments);
}

function hasFoldIdentityCollision(segment, ignoredSegmentKey) {
  const existingAssistantKeys = new Set();
  const existingToolCallIds = new Set();
  for (const existing of lastRenderedToolActivitySegments) {
    if (existing.key === ignoredSegmentKey) {
      continue;
    }
    for (const key of existing.assistantKeys) existingAssistantKeys.add(key);
    for (const toolCallId of existing.toolCallIds) existingToolCallIds.add(toolCallId);
  }
  return segment.assistantKeys.some((key) => existingAssistantKeys.has(key))
    || segment.toolCallIds.some((toolCallId) => existingToolCallIds.has(toolCallId));
}

function appendCompletedBatchToLiveFold(batch) {
  const previousOpen = hasVisibleAssistantText(batch.message) ? undefined : openToolActivitySegment;
  const batches = previousOpen ? [...previousOpen.batches, batch] : [batch];
  const messages = previousOpen
    ? [...previousOpen.assistantMessages, batch.message]
    : [batch.message];
  const segment = buildToolActivitySegment(batches, messages, [], true);
  if (!segment || hasFoldIdentityCollision(segment, previousOpen?.key)) {
    discardPendingActivityNotices();
    closeOpenToolActivitySegment();
    return false;
  }

  let segments = lastRenderedToolActivitySegments;
  if (previousOpen) {
    segments = segments.map((existing) => existing.key === previousOpen.key ? segment : existing);
  } else {
    closeOpenToolActivitySegment();
    segments = [...lastRenderedToolActivitySegments, segment];
  }

  expandedToolActivitySegmentKey = null;
  attachPendingActivityNotices(segment.key);
  applyToolActivitySegments(segments, true);
  return true;
}

function appendTrailingAssistantToOpenSegment(message) {
  if (!openToolActivitySegment || !assistantMessageKey(message)) {
    return false;
  }
  const segment = buildToolActivitySegment(
    openToolActivitySegment.batches,
    [...openToolActivitySegment.assistantMessages, message],
    openToolActivitySegment.assistantIndexes,
    true,
  );
  if (!segment || hasFoldIdentityCollision(segment, openToolActivitySegment.key)) {
    closeOpenToolActivitySegment();
    return false;
  }
  const segments = lastRenderedToolActivitySegments.map(
    (existing) => existing.key === openToolActivitySegment.key ? segment : existing,
  );
  applyToolActivitySegments(segments, true);
  return true;
}

function handleLiveToolActivityEvent(event) {
  if (event?.type === "message_start" && event.message?.role === "user") {
    discardPendingActivityNotices();
    closeOpenToolActivitySegment();
    return;
  }

  if (event?.type === "message_end" && event.message?.role === "assistant") {
    const calls = getToolCalls(event.message);
    if (calls.length > 0) {
      const batch = inspectToolBatch(event.message, []);
      if (!batch?.valid) {
        activeToolBatchKey = null;
        discardPendingActivityNotices();
        closeOpenToolActivitySegment();
      } else {
        activeToolBatchKey = batch.key;
      }
      return;
    }

    activeToolBatchKey = null;
    if (
      hasVisibleAssistantText(event.message)
      || ![undefined, "stop"].includes(event.message.stopReason)
    ) {
      discardPendingActivityNotices();
      closeOpenToolActivitySegment();
      return;
    }
    appendTrailingAssistantToOpenSegment(event.message);
    return;
  }

  if (event?.type === "turn_end") {
    const batch = isCompleteToolBatchEvent(event);
    activeToolBatchKey = null;
    if (!batch || !appendCompletedBatchToLiveFold(batch)) {
      discardPendingActivityNotices();
      closeOpenToolActivitySegment();
    }
    return;
  }

  if (event?.type === "compaction_start") {
    clearActivityNoticeState();
    closeOpenToolActivitySegment();
  }
}

function isCompleteToolBatchEvent(event) {
  if (event?.type !== "turn_end") {
    return undefined;
  }

  const batch = inspectToolBatch(event.message, event.toolResults);
  return batch?.valid && batch.complete ? batch : undefined;
}

function stableHash(value) {
  const text = String(value ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getInteractiveModeInstanceFromContext(ctx) {
  const instance = ctx?.ui?.[INTERACTIVE_INSTANCE_SYMBOL];
  return typeof instance?.ui?.requestRender === "function" ? instance : undefined;
}

function isStaleExtensionContextError(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("extension context no longer active")
    || message.includes("extension ctx is stale");
}

function warnCompactUiFailure(label, error) {
  if (isStaleExtensionContextError(error)) {
    return;
  }
  console.warn(`codex-compact: ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
}

function safeSessionManagerValue(sessionManager, method, fallback, label) {
  try {
    const fn = sessionManager?.[method];
    return typeof fn === "function" ? fn.call(sessionManager) : fallback;
  } catch (error) {
    warnCompactUiFailure(label, error);
    return fallback;
  }
}

function safeSessionValue(ctx, method, fallback, label) {
  return safeSessionManagerValue(ctx?.sessionManager, method, fallback, label);
}

function safeSessionManagerEntries(sessionManager) {
  const entries = safeSessionManagerValue(sessionManager, "getEntries", [], "session entries read");
  return Array.isArray(entries) ? entries : [];
}

function safeSessionEntries(ctx) {
  return safeSessionManagerEntries(ctx?.sessionManager);
}

function requestToolBatchRerender(ctx) {
  const contextInstance = getInteractiveModeInstanceFromContext(ctx);
  const instance = contextInstance ?? lastInteractiveModeInstance;
  refreshFoldedAssistantComponents();
  if (typeof instance?.ui?.requestRender === "function") {
    lastInteractiveModeInstance = instance;
    try {
      instance.ui.requestRender();
      return true;
    } catch (error) {
      warnCompactUiFailure("render request", error);
    }
  }
  return safeUiCall(ctx, "requestRender");
}

function isRawShortcutInput(data, shortcut) {
  if (typeof data !== "string" || typeof shortcut !== "string") {
    return false;
  }

  const normalized = shortcut.toLowerCase();
  if (normalized === "f8") {
    return /^\x1b\[19(?:;[0-9:]+)?[~u]$/.test(data);
  }

  const altMatch = /^alt\+(.{1})$/.exec(normalized);
  if (altMatch) {
    return data === `\x1b${altMatch[1]}`;
  }

  return false;
}

function unregisterToolBatchTerminalInput() {
  const unsubscribe = rawToolBatchInputUnsubscribe;
  rawToolBatchInputUnsubscribe = undefined;
  if (typeof unsubscribe !== "function") {
    return;
  }

  try {
    unsubscribe();
  } catch (error) {
    warnCompactUiFailure("terminal input cleanup", error);
  }
}

function registerToolBatchTerminalInput(ctx, config) {
  unregisterToolBatchTerminalInput();
  if (!isToolBatchFoldingEnabled(config) || !config.toolBatchFoldShortcut) {
    return;
  }

  rawToolBatchInputUnsubscribe = safeOnTerminalInput(ctx, (data) => {
    if (!isRawShortcutInput(data, config.toolBatchFoldShortcut)) {
      return undefined;
    }
    toggleLatestToolActivitySegment(ctx, config);
    return { consume: true };
  });
}

function getCurrentFoldableToolActivitySegments(ctx) {
  if (lastRenderedToolActivitySegments.length > 0) {
    return lastRenderedToolActivitySegments;
  }

  const sessionContext = safeSessionValue(ctx, "buildSessionContext", undefined, "session context read");
  if (!Array.isArray(sessionContext?.messages)) {
    return [];
  }
  return scanToolActivitySegments(sessionContext.messages, activeToolBatchKey);
}

function toggleLatestToolActivitySegment(ctx, config) {
  if (!isToolBatchFoldingEnabled(config)) {
    safeNotify(ctx, "工具活动折叠当前未启用。", "info");
    return;
  }

  const segments = getCurrentFoldableToolActivitySegments(ctx);
  const latest = segments.at(-1);
  if (!latest) {
    safeNotify(ctx, "当前视图还没有可折叠的已完成工具活动。", "info");
    return;
  }

  const willShow = expandedToolActivitySegmentKey !== latest.key;
  expandedToolActivitySegmentKey = willShow ? latest.key : null;
  applyToolActivitySegments(segments);
  const renderRequested = requestToolBatchRerender(ctx);
  safeNotify(
    ctx,
    `工具活动已${willShow ? "展开" : "折叠"}：${formatToolBatchSummary(latest)}；${latest.counts.errors} 个错误；组件已更新${renderRequested ? "" : "，等待下次渲染"}。`,
    "info",
  );
}

function resolveAssistantMessageModulePath(config) {
  const candidates = [];

  if (process.env.PI_CODEX_COMPACT_ASSISTANT_MESSAGE_MODULE) {
    candidates.push(process.env.PI_CODEX_COMPACT_ASSISTANT_MESSAGE_MODULE);
  }

  if (config.assistantMessageModulePath) {
    candidates.push(config.assistantMessageModulePath);
  }

  if (process.argv[1]) {
    try {
      const cliPath = realpathSync(process.argv[1]);
      const packageRoot = dirname(dirname(cliPath));
      candidates.push(join(packageRoot, "dist/modes/interactive/components/assistant-message.js"));
    } catch {
      // Ignore and try fallback candidates.
    }
  }

  candidates.push(
    "/root/node-v22.22.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js",
  );

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveToolExecutionModulePath(config) {
  const candidates = [];

  if (process.env.PI_CODEX_COMPACT_TOOL_EXECUTION_MODULE) {
    candidates.push(process.env.PI_CODEX_COMPACT_TOOL_EXECUTION_MODULE);
  }

  const assistantPath = resolveAssistantMessageModulePath(config);
  if (assistantPath) {
    candidates.push(join(dirname(assistantPath), "tool-execution.js"));
  }

  if (process.argv[1]) {
    try {
      const cliPath = realpathSync(process.argv[1]);
      const packageRoot = dirname(dirname(cliPath));
      candidates.push(join(packageRoot, "dist/modes/interactive/components/tool-execution.js"));
    } catch {
      // Ignore and try fallback candidates.
    }
  }

  candidates.push(
    "/root/node-v22.22.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js",
  );

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveInteractiveModeModulePath(config) {
  const candidates = [];

  if (process.env.PI_CODEX_COMPACT_INTERACTIVE_MODE_MODULE) {
    candidates.push(process.env.PI_CODEX_COMPACT_INTERACTIVE_MODE_MODULE);
  }

  if (config.interactiveModeModulePath) {
    candidates.push(config.interactiveModeModulePath);
  }

  if (process.argv[1]) {
    try {
      const cliPath = realpathSync(process.argv[1]);
      const packageRoot = dirname(dirname(cliPath));
      candidates.push(join(packageRoot, "dist/modes/interactive/interactive-mode.js"));
    } catch {
      // Ignore and try fallback candidates.
    }
  }

  candidates.push(
    "/root/node-v22.22.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
  );

  return candidates.find((candidate) => existsSync(candidate));
}

function restoreAssistantRendererPatch(prototype, expectedOwner) {
  if (!prototype?.[RENDER_PATCH_SYMBOL]) {
    return true;
  }

  const patchData = prototype[RENDER_PATCH_DATA_SYMBOL];
  if (expectedOwner && patchData?.owner !== expectedOwner) {
    return false;
  }
  if (typeof patchData?.originalUpdateContent !== "function") {
    return false;
  }

  prototype.updateContent = patchData.originalUpdateContent;
  prototype[RENDER_PATCH_DATA_SYMBOL] = undefined;
  prototype[RENDER_PATCH_SYMBOL] = false;
  return true;
}

function unpatchOwnedAssistantRenderer() {
  if (!patchedAssistantPrototype) {
    return true;
  }

  const patchData = patchedAssistantPrototype[RENDER_PATCH_DATA_SYMBOL];
  if (patchData?.owner === INSTANCE_ID && patchData.config) {
    patchData.config = { ...patchData.config, enabled: false };
  }
  const restored = restoreAssistantRendererPatch(patchedAssistantPrototype, INSTANCE_ID);
  if (restored) {
    patchedAssistantPrototype = undefined;
  }
  return restored;
}

async function patchAssistantRenderer(ctx, config) {
  const shouldPatch = config.enabled
    && config.patchInternalRenderers
    && (config.stripCommentaryText || config.foldCompletedToolBatches);

  const modulePath = resolveAssistantMessageModulePath(config);
  if (!modulePath) {
    safeSetStatus(
      ctx,
      "codex-compact-render",
      shouldPatch ? themeFg(ctx, "warning", "Codex render patch: unavailable") : undefined,
    );
    return false;
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const prototype = mod.AssistantMessageComponent?.prototype;
  if (!prototype) {
    safeSetStatus(
      ctx,
      "codex-compact-render",
      shouldPatch ? themeFg(ctx, "warning", "Codex render patch: incompatible") : undefined,
    );
    return false;
  }

  if (patchedAssistantPrototype && patchedAssistantPrototype !== prototype) {
    if (!unpatchOwnedAssistantRenderer()) {
      safeSetStatus(ctx, "codex-compact-render", themeFg(ctx, "warning", "Codex render patch: stale patch cleanup failed"));
      return false;
    }
  }

  if (!shouldPatch) {
    if (prototype[RENDER_PATCH_SYMBOL] && !restoreAssistantRendererPatch(prototype)) {
      safeSetStatus(ctx, "codex-compact-render", themeFg(ctx, "warning", "Codex render patch: stale patch cleanup failed"));
      return false;
    }
    if (patchedAssistantPrototype === prototype) {
      patchedAssistantPrototype = undefined;
    }
    safeSetStatus(ctx, "codex-compact-render", undefined);
    return false;
  }

  const currentPatch = prototype[RENDER_PATCH_DATA_SYMBOL];
  if (
    prototype[RENDER_PATCH_SYMBOL]
    && currentPatch?.version === RENDER_PATCH_VERSION
    && currentPatch?.owner === INSTANCE_ID
  ) {
    currentPatch.config = config;
    currentPatch.ctx = ctx;
    patchedAssistantPrototype = prototype;
    safeSetStatus(ctx, "codex-compact-render", undefined);
    return true;
  }

  if (prototype[RENDER_PATCH_SYMBOL] && !restoreAssistantRendererPatch(prototype)) {
    safeSetStatus(ctx, "codex-compact-render", themeFg(ctx, "warning", "Codex render patch: existing patch is incompatible"));
    return false;
  }
  if (typeof prototype.updateContent !== "function") {
    safeSetStatus(ctx, "codex-compact-render", themeFg(ctx, "warning", "Codex render patch: incompatible"));
    return false;
  }

  const originalUpdateContent = prototype.updateContent;
  prototype[RENDER_PATCH_DATA_SYMBOL] = {
    version: RENDER_PATCH_VERSION,
    owner: INSTANCE_ID,
    originalUpdateContent,
    config,
    ctx,
  };
  prototype.updateContent = function patchedUpdateContent(message) {
    const patchData = prototype[RENDER_PATCH_DATA_SYMBOL];
    const sourceMessage = message && typeof message === "object"
      ? projectedAssistantSources.get(message) ?? message
      : message;
    registerAssistantComponent(this, sourceMessage);

    let renderMessage = sourceMessage;
    if (patchData?.config?.enabled && patchData.config.patchInternalRenderers) {
      if (patchData.config.stripCommentaryText) {
        renderMessage = prepareMessageForRendering(renderMessage, patchData.config);
      }
      if (patchData.config.foldCompletedToolBatches) {
        const projection = foldedAssistantProjections.get(assistantMessageKey(sourceMessage));
        renderMessage = projectAssistantForToolActivity(renderMessage, projection, patchData.config, patchData.ctx);
      }
    }
    if (renderMessage && typeof renderMessage === "object" && renderMessage !== sourceMessage) {
      projectedAssistantSources.set(renderMessage, sourceMessage);
    }
    return patchData.originalUpdateContent.call(this, renderMessage);
  };
  prototype[RENDER_PATCH_SYMBOL] = true;
  patchedAssistantPrototype = prototype;
  safeSetStatus(ctx, "codex-compact-render", undefined);
  return true;
}

function restoreToolExecutionRendererPatch(prototype, expectedOwner) {
  if (!prototype?.[TOOL_RENDER_PATCH_SYMBOL]) {
    return true;
  }

  const patchData = prototype[TOOL_RENDER_PATCH_DATA_SYMBOL];
  if (expectedOwner && patchData?.owner !== expectedOwner) {
    return false;
  }
  if (typeof patchData?.originalRender !== "function") {
    return false;
  }

  prototype.render = patchData.originalRender;
  prototype[TOOL_RENDER_PATCH_DATA_SYMBOL] = undefined;
  prototype[TOOL_RENDER_PATCH_SYMBOL] = false;
  return true;
}

function unpatchOwnedToolExecutionRenderer() {
  if (!patchedToolExecutionPrototype) {
    return true;
  }

  const patchData = patchedToolExecutionPrototype[TOOL_RENDER_PATCH_DATA_SYMBOL];
  if (patchData?.owner === INSTANCE_ID && patchData.config) {
    patchData.config = { ...patchData.config, enabled: false };
  }
  const restored = restoreToolExecutionRendererPatch(patchedToolExecutionPrototype, INSTANCE_ID);
  if (restored) {
    patchedToolExecutionPrototype = undefined;
  }
  return restored;
}

async function patchToolExecutionRenderer(ctx, config) {
  const shouldPatch = isToolBatchFoldingEnabled(config);
  const modulePath = resolveToolExecutionModulePath(config);
  if (!modulePath) {
    safeSetStatus(
      ctx,
      "codex-compact-tool-render",
      shouldPatch ? themeFg(ctx, "warning", "Codex tool render patch: unavailable") : undefined,
    );
    return false;
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const prototype = mod.ToolExecutionComponent?.prototype;
  if (!prototype) {
    safeSetStatus(
      ctx,
      "codex-compact-tool-render",
      shouldPatch ? themeFg(ctx, "warning", "Codex tool render patch: incompatible") : undefined,
    );
    return false;
  }

  if (patchedToolExecutionPrototype && patchedToolExecutionPrototype !== prototype) {
    if (!unpatchOwnedToolExecutionRenderer()) {
      safeSetStatus(ctx, "codex-compact-tool-render", themeFg(ctx, "warning", "Codex tool render patch: stale patch cleanup failed"));
      return false;
    }
  }

  if (!shouldPatch) {
    if (prototype[TOOL_RENDER_PATCH_SYMBOL] && !restoreToolExecutionRendererPatch(prototype)) {
      safeSetStatus(ctx, "codex-compact-tool-render", themeFg(ctx, "warning", "Codex tool render patch: stale patch cleanup failed"));
      return false;
    }
    if (patchedToolExecutionPrototype === prototype) {
      patchedToolExecutionPrototype = undefined;
    }
    safeSetStatus(ctx, "codex-compact-tool-render", undefined);
    return false;
  }

  const currentPatch = prototype[TOOL_RENDER_PATCH_DATA_SYMBOL];
  if (
    prototype[TOOL_RENDER_PATCH_SYMBOL]
    && currentPatch?.version === TOOL_RENDER_PATCH_VERSION
    && currentPatch?.owner === INSTANCE_ID
  ) {
    currentPatch.config = config;
    patchedToolExecutionPrototype = prototype;
    safeSetStatus(ctx, "codex-compact-tool-render", undefined);
    return true;
  }

  if (prototype[TOOL_RENDER_PATCH_SYMBOL] && !restoreToolExecutionRendererPatch(prototype)) {
    safeSetStatus(ctx, "codex-compact-tool-render", themeFg(ctx, "warning", "Codex tool render patch: existing patch is incompatible"));
    return false;
  }
  if (typeof prototype.render !== "function") {
    safeSetStatus(ctx, "codex-compact-tool-render", themeFg(ctx, "warning", "Codex tool render patch: incompatible"));
    return false;
  }

  const originalRender = prototype.render;
  prototype[TOOL_RENDER_PATCH_DATA_SYMBOL] = {
    version: TOOL_RENDER_PATCH_VERSION,
    owner: INSTANCE_ID,
    originalRender,
    config,
  };
  prototype.render = function patchedToolExecutionRender(width) {
    const patchData = prototype[TOOL_RENDER_PATCH_DATA_SYMBOL];
    if (
      patchData?.config?.enabled
      && patchData.config.patchInternalRenderers
      && patchData.config.foldCompletedToolBatches
      && foldedToolCallIds.has(this.toolCallId)
    ) {
      return [];
    }
    return patchData.originalRender.call(this, width);
  };
  prototype[TOOL_RENDER_PATCH_SYMBOL] = true;
  patchedToolExecutionPrototype = prototype;
  safeSetStatus(ctx, "codex-compact-tool-render", undefined);
  return true;
}

function restoreInteractiveModePatch(prototype, expectedOwner) {
  if (!prototype?.[INTERACTIVE_PATCH_SYMBOL]) {
    return true;
  }

  const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
  if (expectedOwner && patchData?.owner !== expectedOwner) {
    return false;
  }

  const hasRenderer = typeof patchData?.originalRenderSessionItems === "function"
    || typeof patchData?.originalRenderSessionContext === "function";
  if (
    !hasRenderer
    || typeof patchData?.originalHandleEvent !== "function"
    || typeof patchData?.originalCreateExtensionUIContext !== "function"
    || typeof patchData?.originalAddExtensionTerminalInputListener !== "function"
  ) {
    return false;
  }

  if (typeof patchData.originalRenderSessionItems === "function") {
    prototype.renderSessionItems = patchData.originalRenderSessionItems;
  }
  if (typeof patchData.originalRenderSessionContext === "function") {
    prototype.renderSessionContext = patchData.originalRenderSessionContext;
  }
  prototype.handleEvent = patchData.originalHandleEvent;
  prototype.createExtensionUIContext = patchData.originalCreateExtensionUIContext;
  prototype.addExtensionTerminalInputListener = patchData.originalAddExtensionTerminalInputListener;
  if (typeof patchData.originalShowExtensionNotify === "function") {
    prototype.showExtensionNotify = patchData.originalShowExtensionNotify;
  }
  prototype[INTERACTIVE_PATCH_DATA_SYMBOL] = undefined;
  prototype[INTERACTIVE_PATCH_SYMBOL] = false;
  return true;
}

function unpatchOwnedInteractiveMode() {
  if (!patchedInteractivePrototype) {
    return true;
  }

  const patchData = patchedInteractivePrototype[INTERACTIVE_PATCH_DATA_SYMBOL];
  if (patchData?.owner === INSTANCE_ID && patchData.config) {
    patchData.config = { ...patchData.config, enabled: false };
  }
  const restored = restoreInteractiveModePatch(patchedInteractivePrototype, INSTANCE_ID);
  if (restored) {
    patchedInteractivePrototype = undefined;
  }
  return restored;
}

async function patchInteractiveModeRenderer(ctx, config, componentPatchesReady = true) {
  const wantsPatch = isToolBatchFoldingEnabled(config);
  const shouldPatch = wantsPatch && componentPatchesReady;

  const modulePath = resolveInteractiveModeModulePath(config);
  if (!modulePath) {
    safeSetStatus(
      ctx,
      "codex-compact-fold",
      wantsPatch ? themeFg(ctx, "warning", "Codex tool-batch patch: unavailable") : undefined,
    );
    return false;
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const prototype = mod.InteractiveMode?.prototype;
  if (!prototype) {
    safeSetStatus(
      ctx,
      "codex-compact-fold",
      wantsPatch ? themeFg(ctx, "warning", "Codex tool-batch patch: incompatible") : undefined,
    );
    return false;
  }

  if (patchedInteractivePrototype && patchedInteractivePrototype !== prototype) {
    if (!unpatchOwnedInteractiveMode()) {
      safeSetStatus(ctx, "codex-compact-fold", themeFg(ctx, "warning", "Codex tool-batch patch: stale patch cleanup failed"));
      return false;
    }
  }

  if (!shouldPatch) {
    if (prototype[INTERACTIVE_PATCH_SYMBOL] && !restoreInteractiveModePatch(prototype)) {
      safeSetStatus(ctx, "codex-compact-fold", themeFg(ctx, "warning", "Codex tool-batch patch: stale patch cleanup failed"));
      return false;
    }
    if (patchedInteractivePrototype === prototype) {
      patchedInteractivePrototype = undefined;
    }
    safeSetStatus(
      ctx,
      "codex-compact-fold",
      wantsPatch ? themeFg(ctx, "warning", "Codex tool-batch patch: component adapter unavailable") : undefined,
    );
    return false;
  }

  const currentPatch = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
  if (
    prototype[INTERACTIVE_PATCH_SYMBOL]
    && currentPatch?.version === INTERACTIVE_PATCH_VERSION
    && currentPatch?.owner === INSTANCE_ID
  ) {
    currentPatch.config = config;
    patchedInteractivePrototype = prototype;
    safeSetStatus(ctx, "codex-compact-fold", undefined);
    return true;
  }

  if (prototype[INTERACTIVE_PATCH_SYMBOL] && !restoreInteractiveModePatch(prototype)) {
    safeSetStatus(ctx, "codex-compact-fold", themeFg(ctx, "warning", "Codex tool-batch patch: existing patch is incompatible"));
    return false;
  }

  if (
    typeof prototype.renderSessionItems !== "function"
    || typeof prototype.handleEvent !== "function"
    || typeof prototype.createExtensionUIContext !== "function"
    || typeof prototype.addExtensionTerminalInputListener !== "function"
    || typeof prototype.showExtensionNotify !== "function"
  ) {
    safeSetStatus(ctx, "codex-compact-fold", themeFg(ctx, "warning", "Codex tool-batch patch: incompatible"));
    return false;
  }

  const originalRenderSessionItems = prototype.renderSessionItems;
  const originalHandleEvent = prototype.handleEvent;
  const originalCreateExtensionUIContext = prototype.createExtensionUIContext;
  const originalAddExtensionTerminalInputListener = prototype.addExtensionTerminalInputListener;
  const originalShowExtensionNotify = prototype.showExtensionNotify;
  prototype[INTERACTIVE_PATCH_DATA_SYMBOL] = {
    version: INTERACTIVE_PATCH_VERSION,
    owner: INSTANCE_ID,
    adapter: "component-state",
    originalRenderSessionItems,
    originalHandleEvent,
    originalCreateExtensionUIContext,
    originalAddExtensionTerminalInputListener,
    originalShowExtensionNotify,
    config,
  };

  prototype.renderSessionItems = function patchedRenderSessionItems(items, options) {
    lastInteractiveModeInstance = this;
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    clearActivityNoticeState();
    clearAssistantComponentRegistry();
    if (patchData?.config?.enabled && patchData.config.foldCompletedToolBatches) {
      prepareItemsForToolBatchFolding(items, patchData.config);
    } else {
      applyToolActivitySegments([]);
    }
    return patchData.originalRenderSessionItems.call(this, items, options);
  };

  prototype.handleEvent = async function patchedHandleEvent(event) {
    lastInteractiveModeInstance = this;
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    const result = await patchData.originalHandleEvent.call(this, event);
    if (patchData?.config?.enabled && patchData.config.foldCompletedToolBatches) {
      try {
        handleLiveToolActivityEvent(event);
        if (["message_start", "message_end", "turn_end", "compaction_start"].includes(event?.type)) {
          this.ui?.requestRender?.();
        }
      } catch (error) {
        warnCompactUiFailure("live component fold", error);
      }
    }
    return result;
  };

  prototype.createExtensionUIContext = function patchedCreateExtensionUIContext(...args) {
    lastInteractiveModeInstance = this;
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    const uiContext = patchData.originalCreateExtensionUIContext.apply(this, args);
    Object.defineProperty(uiContext, INTERACTIVE_INSTANCE_SYMBOL, {
      configurable: true,
      enumerable: false,
      value: this,
    });
    return uiContext;
  };

  prototype.addExtensionTerminalInputListener = function patchedAddExtensionTerminalInputListener(...args) {
    lastInteractiveModeInstance = this;
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    return patchData.originalAddExtensionTerminalInputListener.apply(this, args);
  };

  prototype.showExtensionNotify = function patchedShowExtensionNotify(message, type) {
    lastInteractiveModeInstance = this;
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    const result = patchData.originalShowExtensionNotify.call(this, message, type);
    if (patchData?.config?.enabled && patchData.config.foldCompletedToolBatches) {
      captureActivityNotice(this, message, type);
    }
    return result;
  };

  prototype[INTERACTIVE_PATCH_SYMBOL] = true;
  patchedInteractivePrototype = prototype;
  safeSetStatus(ctx, "codex-compact-fold", undefined);
  return true;
}
function safeUiCall(ctx, method, ...args) {
  try {
    const fn = ctx?.ui?.[method];
    if (typeof fn !== "function") {
      return false;
    }
    fn.apply(ctx.ui, args);
    return true;
  } catch (error) {
    warnCompactUiFailure(`${method} UI call`, error);
    return false;
  }
}

function safeUiValue(ctx, method, fallback) {
  try {
    const fn = ctx?.ui?.[method];
    return typeof fn === "function" ? fn.call(ctx.ui) : fallback;
  } catch (error) {
    warnCompactUiFailure(`${method} UI read`, error);
    return fallback;
  }
}

function safeNotify(ctx, message, level = "info") {
  if (safeUiCall(ctx, "notify", message, level)) {
    return;
  }
  console.log(message);
}

function safeSetStatus(ctx, key, value) {
  safeUiCall(ctx, "setStatus", key, value);
}

function themeFg(ctx, tone, text) {
  try {
    return ctx?.ui?.theme?.fg?.(tone, text) ?? text;
  } catch {
    return text;
  }
}

function safeSetWidget(ctx, key, lines, options) {
  return safeUiCall(ctx, "setWidget", key, lines, options);
}

function safeOnTerminalInput(ctx, handler) {
  try {
    const fn = ctx?.ui?.["onTerminalInput"];
    if (typeof fn !== "function") {
      return undefined;
    }
    return fn.call(ctx.ui, handler);
  } catch (error) {
    warnCompactUiFailure("terminal input registration", error);
    return undefined;
  }
}

function applyUiConfig(ctx, config) {
  if (!ctx?.ui) {
    return;
  }

  if (!toolsExpandedCaptured) {
    toolsExpandedBeforeEnable = safeUiValue(ctx, "getToolsExpanded", undefined);
    toolsExpandedCaptured = typeof toolsExpandedBeforeEnable === "boolean";
  }

  safeUiCall(ctx, "setHiddenThinkingLabel", config.hiddenThinkingLabel);
  safeUiCall(ctx, "setToolsExpanded", !config.collapseToolOutput);
  safeUiCall(ctx, "setWorkingMessage", config.workingMessage);

  if (config.hideWorkingRow) {
    safeUiCall(ctx, "setWorkingVisible", false);
    safeUiCall(ctx, "setWorkingIndicator", { frames: [] });
  } else {
    safeUiCall(ctx, "setWorkingVisible", true);
    safeUiCall(ctx, "setWorkingIndicator");
  }
}

function resetUiConfig(ctx) {
  safeUiCall(ctx, "setHiddenThinkingLabel");
  if (toolsExpandedCaptured) {
    safeUiCall(ctx, "setToolsExpanded", toolsExpandedBeforeEnable);
  }
  toolsExpandedBeforeEnable = undefined;
  toolsExpandedCaptured = false;
  safeUiCall(ctx, "setWorkingMessage");
  safeUiCall(ctx, "setWorkingVisible", true);
  safeUiCall(ctx, "setWorkingIndicator");
  safeSetStatus(ctx, "codex-compact", undefined);
  safeSetStatus(ctx, "codex-compact-render", undefined);
  safeSetStatus(ctx, "codex-compact-tool-render", undefined);
  safeSetStatus(ctx, "codex-compact-fold", undefined);
}

async function enableCompactRuntime(ctx, config) {
  if (ctx?.mode !== "tui") {
    safeSetStatus(
      ctx,
      "codex-compact",
      config.enabled ? themeFg(ctx, "dim", "Codex compact: on; TUI patches skipped outside interactive mode") : undefined,
    );
    return;
  }

  if (!config.enabled) {
    try {
      await patchAssistantRenderer(ctx, config);
      await patchToolExecutionRenderer(ctx, config);
      await patchInteractiveModeRenderer(ctx, config, false);
    } catch (error) {
      warnCompactUiFailure("disabled runtime cleanup", error);
    }
    disableCompactRuntime(ctx);
    return;
  }

  if (!config.foldCompletedToolBatches) {
    resetToolBatchFoldState();
  }
  applyUiConfig(ctx, config);
  if (config.loadError) {
    safeNotify(ctx, `Codex compact config load failed, using defaults: ${config.loadError}`, "warning");
  }

  try {
    const assistantPatched = await patchAssistantRenderer(ctx, config);
    const toolPatched = await patchToolExecutionRenderer(ctx, config);
    const foldPatched = await patchInteractiveModeRenderer(
      ctx,
      config,
      assistantPatched && toolPatched,
    );
    if (foldPatched) {
      registerToolBatchTerminalInput(ctx, config);
    } else {
      unregisterToolBatchTerminalInput();
      resetToolBatchFoldState();
    }
    safeSetStatus(
      ctx,
      "codex-compact",
      themeFg(ctx, "dim", `Codex compact: on${assistantPatched ? " + assistant patch" : ""}${toolPatched ? " + tool patch" : ""}${foldPatched ? " + component-state fold" : ""}`),
    );
  } catch (error) {
    safeSetStatus(ctx, "codex-compact", themeFg(ctx, "warning", "Codex compact: on; render patch failed"));
    safeNotify(ctx, `Codex compact render patch failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

function disableCompactRuntime(ctx) {
  closeHiddenCommentarySummary(ctx);
  resetToolBatchFoldState();
  unregisterToolBatchTerminalInput();
  unpatchOwnedAssistantRenderer();
  unpatchOwnedToolExecutionRenderer();
  unpatchOwnedInteractiveMode();
  requestToolBatchRerender(ctx);
  clearAssistantComponentRegistry();
  resetUiConfig(ctx);
  lastInteractiveModeInstance = undefined;
}

function getAuditEntries(ctx) {
  return safeSessionEntries(ctx)
    .filter((entry) => entry.type === "custom" && entry.customType === AUDIT_ENTRY_TYPE);
}

let hiddenSummaryWidgetVisible = false;

function resetEphemeralRuntimeState() {
  resetToolBatchFoldState();
  clearAssistantComponentRegistry();
  lastInteractiveModeInstance = undefined;
  hiddenSummaryWidgetVisible = false;
  toolsExpandedBeforeEnable = undefined;
  toolsExpandedCaptured = false;
  unregisterToolBatchTerminalInput();
}

function getHiddenSummaryWidgetLines(summary, config) {
  const lines = summary.split("\n");
  if (config.hiddenSummaryShortcut) {
    lines.splice(1, 0, `Press ${config.hiddenSummaryShortcut} again to close.`);
  }
  return lines;
}

function closeHiddenCommentarySummary(ctx) {
  if (safeSetWidget(ctx, HIDDEN_SUMMARY_WIDGET_KEY, undefined)) {
    hiddenSummaryWidgetVisible = false;
    return true;
  }

  return false;
}

function showLatestHiddenCommentarySummary(ctx, config) {
  const summary = formatLatestHiddenCommentarySummary(getAuditEntries(ctx));
  if (safeSetWidget(ctx, HIDDEN_SUMMARY_WIDGET_KEY, getHiddenSummaryWidgetLines(summary, config), { placement: "aboveEditor" })) {
    hiddenSummaryWidgetVisible = true;
    return;
  }

  safeNotify(ctx, summary, "info");
}

function toggleLatestHiddenCommentarySummary(ctx, config) {
  if (hiddenSummaryWidgetVisible && closeHiddenCommentarySummary(ctx)) {
    return;
  }

  showLatestHiddenCommentarySummary(ctx, config);
}

function formatAuditSummary(entries) {
  if (entries.length === 0) {
    return "No hidden commentary audit entries in this session.";
  }

  const latest = entries.at(-1);
  const data = latest?.data ?? {};
  const source = data.source ?? {};
  const hiddenBlockCount = entries.reduce(
    (count, entry) => count + (Array.isArray(entry.data?.hiddenBlocks) ? entry.data.hiddenBlocks.length : 0),
    0,
  );

  return [
    `Hidden commentary audit entries: ${entries.length}`,
    `Hidden text blocks: ${hiddenBlockCount}`,
    `Latest model: ${source.provider ?? "unknown"}/${source.model ?? "unknown"}`,
    `Latest responseId: ${source.responseId ?? "unknown"}`,
    "Hidden text is stored in session custom entries and is not printed by this command.",
  ].join("\n");
}

function formatSourceTime(timestamp) {
  if (!timestamp) {
    return "unknown";
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

function formatHiddenBlockSummary(block, index) {
  const parsedSignature = parseTextSignature(block?.textSignature);
  const length = Number.isFinite(block?.originalLength) ? block.originalLength : 0;
  return [
    `#${index + 1}`,
    `signature=${parsedSignature?.id ?? "unknown"}`,
    `phase=${parsedSignature?.phase ?? "unknown"}`,
    `chars=${length}`,
    `truncated=${block?.truncated ? "yes" : "no"}`,
  ].join("; ");
}

function formatLatestHiddenCommentarySummary(entries) {
  if (entries.length === 0) {
    return "No hidden commentary audit entries in this session.";
  }

  const latest = entries.at(-1);
  const data = latest?.data ?? {};
  const source = data.source ?? {};
  const hiddenBlocks = Array.isArray(data.hiddenBlocks) ? data.hiddenBlocks : [];
  const lines = [
    "Latest hidden commentary summary",
    `Blocks: ${hiddenBlocks.length}`,
    `Model: ${source.provider ?? "unknown"}/${source.model ?? "unknown"}`,
    `ResponseId: ${source.responseId ?? "unknown"}`,
    `Stop reason: ${source.stopReason ?? "unknown"}`,
    `Timestamp: ${formatSourceTime(source.timestamp)}`,
    "Hidden text is intentionally not printed.",
  ];

  if (hiddenBlocks.length > 0) {
    lines.push("Block metadata:");
    for (const [index, block] of hiddenBlocks.entries()) {
      lines.push(`- ${formatHiddenBlockSummary(block, index)}`);
    }
  }

  return lines.join("\n");
}

function formatConfigSummary(config) {
  return (
    `Codex compact: ${config.enabled ? "on" : "off"}; ` +
    `strip commentary: ${config.stripCommentaryText ? "on" : "off"}; ` +
    `tool batch folding: ${config.foldCompletedToolBatches ? "on" : "off"}; ` +
    "fold unit: narrative-bounded activity segment; " +
    `audit: ${config.auditHiddenCommentary ? "on" : "off"}; ` +
    `internal renderer patches: ${config.patchInternalRenderers ? "on" : "off"}; ` +
    `marker: ${config.showHiddenCommentaryMarker ? "on" : "off"}; ` +
    `summary shortcut: ${config.hiddenSummaryShortcut || "off"}; ` +
    `tool batch shortcut: ${config.toolBatchFoldShortcut || "off"}; ` +
    `tools: ${config.collapseToolOutput ? "collapsed" : "expanded"}; ` +
    `config: ${CONFIG_PATH}`
  );
}

async function formatDoctorReport(config) {
  const lines = [
    "pi-codex-compact doctor",
    `Config path: ${CONFIG_PATH}`,
    `Config file: ${existsSync(CONFIG_PATH) ? "found" : "missing; using defaults"}`,
    `Config load: ${config.loadError ? `failed; using defaults (${config.loadError})` : "ok"}`,
    `Extension enabled: ${config.enabled ? "yes" : "no"}`,
    `Finalized message filter: ${config.stripCommentaryText ? "enabled" : "disabled"}`,
    `Completed tool-batch folding: ${config.foldCompletedToolBatches ? "enabled" : "disabled"}`,
    "Fold unit: narrative-bounded activity segment",
    `Audit entries: ${config.auditHiddenCommentary ? "enabled" : "disabled"}`,
    `Internal renderer patches: ${config.patchInternalRenderers ? "enabled" : "disabled"}`,
    `Hidden commentary marker: ${config.showHiddenCommentaryMarker ? "enabled" : "disabled"}`,
    `Hidden summary shortcut: ${config.hiddenSummaryShortcut || "disabled"}`,
    `Tool-batch shortcut: ${config.toolBatchFoldShortcut || "disabled"}`,
  ];

  const modulePath = resolveAssistantMessageModulePath(config);
  lines.push(`Assistant renderer module: ${modulePath ?? "not found"}`);
  let assistantCompatible = false;

  if (!config.patchInternalRenderers) {
    lines.push("Renderer patch check: skipped; disabled by config");
  } else if (!modulePath) {
    lines.push("Renderer patch check: failed; assistant renderer module was not found");
  } else {
    try {
      const mod = await import(pathToFileURL(modulePath).href);
      const prototype = mod.AssistantMessageComponent?.prototype;
      const compatible = typeof prototype?.updateContent === "function";
      assistantCompatible = compatible;
      lines.push(`AssistantMessageComponent.updateContent: ${compatible ? "found" : "missing"}`);
      lines.push(`Renderer currently patched: ${prototype?.[RENDER_PATCH_SYMBOL] ? "yes" : "no"}`);
      lines.push(`Renderer patch version: ${prototype?.[RENDER_PATCH_DATA_SYMBOL]?.version ?? "legacy/unknown"}`);
      lines.push(`Renderer patch check: ${compatible ? "compatible" : "incompatible"}`);
    } catch (error) {
      lines.push(`Renderer patch check: import failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const toolPath = resolveToolExecutionModulePath(config);
  lines.push(`Tool renderer module: ${toolPath ?? "not found"}`);
  let toolCompatible = false;
  if (!config.patchInternalRenderers || !config.foldCompletedToolBatches) {
    lines.push("Tool renderer patch check: skipped; disabled by config");
  } else if (!toolPath) {
    lines.push("Tool renderer patch check: failed; tool renderer module was not found");
  } else {
    try {
      const mod = await import(pathToFileURL(toolPath).href);
      const prototype = mod.ToolExecutionComponent?.prototype;
      toolCompatible = typeof prototype?.render === "function";
      lines.push(`ToolExecutionComponent.render: ${toolCompatible ? "found" : "missing"}`);
      lines.push(`Tool renderer currently patched: ${prototype?.[TOOL_RENDER_PATCH_SYMBOL] ? "yes" : "no"}`);
      lines.push(`Tool renderer patch version: ${prototype?.[TOOL_RENDER_PATCH_DATA_SYMBOL]?.version ?? "legacy/unknown"}`);
      lines.push(`Tool renderer patch check: ${toolCompatible ? "compatible" : "incompatible"}`);
    } catch (error) {
      lines.push(`Tool renderer patch check: import failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const interactivePath = resolveInteractiveModeModulePath(config);
  lines.push(`Interactive mode module: ${interactivePath ?? "not found"}`);
  if (!config.patchInternalRenderers || !config.foldCompletedToolBatches) {
    lines.push("Tool-batch fold patch check: skipped; disabled by config");
    return lines.join("\n");
  }
  if (!interactivePath) {
    lines.push("Tool-batch fold patch check: failed; interactive mode module was not found");
    return lines.join("\n");
  }
  try {
    const mod = await import(pathToFileURL(interactivePath).href);
    const prototype = mod.InteractiveMode?.prototype;
    const interactiveCompatible = typeof prototype?.renderSessionItems === "function"
      && typeof prototype?.handleEvent === "function"
      && typeof prototype?.createExtensionUIContext === "function"
      && typeof prototype?.addExtensionTerminalInputListener === "function"
      && typeof prototype?.showExtensionNotify === "function";
    const compatible = assistantCompatible && toolCompatible && interactiveCompatible;
    lines.push(`Interactive adapter: ${compatible ? "component-state" : "none"}`);
    lines.push(`InteractiveMode.renderSessionItems: ${typeof prototype?.renderSessionItems === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.renderSessionContext: ${typeof prototype?.renderSessionContext === "function" ? "found (unused)" : "missing (expected on supported Pi)"}`);
    lines.push(`InteractiveMode.handleEvent: ${typeof prototype?.handleEvent === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.createExtensionUIContext: ${typeof prototype?.createExtensionUIContext === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.addExtensionTerminalInputListener: ${typeof prototype?.addExtensionTerminalInputListener === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.showExtensionNotify: ${typeof prototype?.showExtensionNotify === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.rebuildChatFromMessages: ${typeof prototype?.rebuildChatFromMessages === "function" ? "found" : "missing"}`);
    lines.push(`Tool-batch fold currently patched: ${prototype?.[INTERACTIVE_PATCH_SYMBOL] ? "yes" : "no"}`);
    lines.push(`Tool-batch fold patch version: ${prototype?.[INTERACTIVE_PATCH_DATA_SYMBOL]?.version ?? "legacy/unknown"}`);
    lines.push(`Tool-batch fold patch adapter: ${prototype?.[INTERACTIVE_PATCH_DATA_SYMBOL]?.adapter ?? "none"}`);
    lines.push(`Tool-batch fold patch check: ${compatible ? "compatible" : "incompatible"}`);
  } catch (error) {
    lines.push(`Tool-batch fold patch check: import failed (${error instanceof Error ? error.message : String(error)})`);
  }

  return lines.join("\n");
}

export default function piCodexCompact(pi) {
  const state = globalThis;
  if (typeof state[REGISTRATION_KEY] === "string") return;
  state[REGISTRATION_KEY] = INSTANCE_ID;

  let config = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    resetEphemeralRuntimeState();
    await enableCompactRuntime(ctx, config);
  });

  pi.on("turn_end", (event) => {
    if (!isToolBatchFoldingEnabled(config)) {
      return;
    }

    const batch = isCompleteToolBatchEvent(event);
    if (!batch) {
      return;
    }
    if (activeToolBatchKey === batch.key) {
      activeToolBatchKey = null;
    }
    expandedToolActivitySegmentKey = null;
  });

  pi.on("input", (event, ctx) => {
    const text = typeof event.text === "string" ? event.text.trim().toLowerCase() : "";
    if (!["codex-compact toggle", "codex-compact fold", "compact toggle", "compact fold"].includes(text)) {
      return { action: "continue" };
    }

    toggleLatestToolActivitySegment(ctx, config);
    return { action: "handled" };
  });

  pi.on("message_end", (event, ctx) => {
    if (isToolBatchFoldingEnabled(config)) {
      const batch = inspectToolBatch(event.message, []);
      if (batch?.valid) {
        activeToolBatchKey = batch.key;
      }
    }

    if (!config.enabled || !config.stripCommentaryText) {
      return;
    }

    const hiddenBlocks = collectCommentaryTextBlocks(event.message);
    const message = stripCommentaryFromMessage(event.message);
    if (message !== event.message) {
      if (config.auditHiddenCommentary && hiddenBlocks.length > 0) {
        pi.appendEntry(AUDIT_ENTRY_TYPE, buildHiddenCommentaryAuditEntry(event.message, hiddenBlocks, config));
      }
      if (config.showHiddenCommentaryMarker && hiddenBlocks.length > 0) {
        safeNotify(ctx, formatHiddenCommentaryMarker(hiddenBlocks.length, config), "info");
      }
      return { message };
    }
  });

  if (config.toolBatchFoldShortcut) {
    pi.registerShortcut(config.toolBatchFoldShortcut, {
      description: "展开或折叠最近一个已完成工具活动段",
      handler: (ctx) => toggleLatestToolActivitySegment(ctx, config),
    });
  }

  if (config.hiddenSummaryShortcut && config.hiddenSummaryShortcut !== config.toolBatchFoldShortcut) {
    pi.registerShortcut(config.hiddenSummaryShortcut, {
      description: "Show latest hidden commentary metadata without revealing hidden text",
      handler: (ctx) => toggleLatestHiddenCommentarySummary(ctx, config),
    });
  }

  pi.on("session_shutdown", (_event, ctx) => {
    disableCompactRuntime(ctx);
    resetEphemeralRuntimeState();
    if (state[REGISTRATION_KEY] === INSTANCE_ID) {
      delete state[REGISTRATION_KEY];
    }
  });

  pi.registerCommand("codex-compact", {
    description: "Show, reload, or toggle Codex-style compact display settings.",
    handler: async (args = "", ctx) => {
      try {
        const subcommand = String(args ?? "").trim().toLowerCase();

        if (subcommand === "audit") {
          safeNotify(ctx, formatAuditSummary(getAuditEntries(ctx)), "info");
          return;
        }

        if (subcommand === "latest" || subcommand === "summary") {
          showLatestHiddenCommentarySummary(ctx, config);
          return;
        }

        if (subcommand === "doctor") {
          safeNotify(ctx, await formatDoctorReport(config), "info");
          return;
        }

        if (subcommand === "reload") {
          const previousToolShortcut = config.toolBatchFoldShortcut;
          const previousSummaryShortcut = config.hiddenSummaryShortcut;
          config = loadConfig();
          const shortcutChanged = previousToolShortcut !== config.toolBatchFoldShortcut
            || previousSummaryShortcut !== config.hiddenSummaryShortcut;
          await enableCompactRuntime(ctx, config);
          const shortcutNotice = shortcutChanged
            ? " Shortcut registration changed; run Pi /reload to remove old bindings and activate all new bindings."
            : "";
          safeNotify(ctx, `Codex compact config reloaded. ${formatConfigSummary(config)}${shortcutNotice}`, "info");
          return;
        }

        if (subcommand === "toggle" || subcommand === "fold") {
          toggleLatestToolActivitySegment(ctx, config);
          return;
        }

        if (!subcommand || subcommand === "show") {
          safeNotify(ctx, formatConfigSummary(config), "info");
          return;
        }

        if (subcommand !== "on" && subcommand !== "off") {
          safeNotify(ctx, "Usage: /codex-compact [show|audit|latest|summary|doctor|reload|toggle|fold|on|off]", "error");
          return;
        }

        config = { ...config, enabled: subcommand === "on" };
        await enableCompactRuntime(ctx, config);
        safeNotify(ctx, `Codex compact ${config.enabled ? "enabled" : "disabled"}`, "info");
      } catch (error) {
        safeNotify(ctx, `Codex compact command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
