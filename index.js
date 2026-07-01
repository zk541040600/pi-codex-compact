import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";

// Diagnostic logger: writes to /tmp/codex-compact-debug.log with timestamp.
// Keep disabled by default; flip temporarily when diagnosing fold issues.
const DEBUG_FOLD = false;
const DEBUG_LOG_PATH = "/tmp/codex-compact-debug.log";
function dbg(msg) {
  if (!DEBUG_FOLD) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

const AUDIT_ENTRY_TYPE = "pi-codex-compact.hidden-commentary";
const PROCESS_GROUP_ENTRY_TYPE = "pi-codex-compact.process-group";
const HIDDEN_SUMMARY_WIDGET_KEY = "pi-codex-compact.hidden-summary";
const RENDER_PATCH_VERSION = 3;
const INTERACTIVE_PATCH_VERSION = 5;
const RENDER_PATCH_SYMBOL = Symbol.for("pi-codex-compact.assistant-renderer-patched");
const RENDER_PATCH_DATA_SYMBOL = Symbol.for("pi-codex-compact.assistant-renderer-patch-data");
const INTERACTIVE_PATCH_SYMBOL = Symbol.for("pi-codex-compact.interactive-render-patched");
const INTERACTIVE_PATCH_DATA_SYMBOL = Symbol.for("pi-codex-compact.interactive-render-patch-data");
const INTERACTIVE_INSTANCE_SYMBOL = Symbol.for("pi-codex-compact.interactive-instance");
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

const DEFAULT_CONFIG = {
  enabled: true,
  stripCommentaryText: false,
  foldCompletedTurnProcess: true,
  foldUnsignedFinalSections: true,
  deriveFoldGroupsOnRender: false,
  auditHiddenCommentary: true,
  auditMaxTextChars: 200000,
  patchAssistantRenderer: true,
  showHiddenCommentaryMarker: true,
  hiddenCommentaryMarker: "[commentary hidden: {count} block(s); press {shortcut} for summary below]",
  hiddenSummaryShortcut: "",
  turnProcessFoldShortcut: "alt+p",
  processFoldMarker: "[process {state}: {total} entries: {details}; press {shortcut} to {action} latest]",
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
    "foldCompletedTurnProcess",
    "foldUnsignedFinalSections",
    "deriveFoldGroupsOnRender",
    "auditHiddenCommentary",
    "patchAssistantRenderer",
    "showHiddenCommentaryMarker",
    "collapseToolOutput",
    "hideWorkingRow",
  ]) {
    if (typeof rawConfig[key] === "boolean") {
      config[key] = rawConfig[key];
    }
  }

  for (const key of ["assistantMessageModulePath", "interactiveModeModulePath", "hiddenCommentaryMarker", "hiddenSummaryShortcut", "turnProcessFoldShortcut", "processFoldMarker", "hiddenThinkingLabel", "workingMessage"]) {
    if (typeof rawConfig[key] === "string") {
      config[key] = rawConfig[key];
    }
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
  if (typeof text !== "string" || text.length <= maxChars) {
    return { text, truncated: false, originalLength: typeof text === "string" ? text.length : 0 };
  }

  return {
    text: text.slice(0, maxChars),
    truncated: true,
    originalLength: text.length,
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

  return {
    ...message,
    content: addHiddenCommentaryMarker(filteredContent, hiddenCount, config),
  };
}

function isFinalAnswerTextBlock(block) {
  if (!block || block.type !== "text") {
    return false;
  }

  return parseTextSignature(block.textSignature)?.phase === "final_answer";
}

function getFinalAnswerTextBlocks(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  return message.content.filter(isFinalAnswerTextBlock);
}

function splitUnsignedFinalSectionText(text) {
  if (typeof text !== "string") {
    return undefined;
  }

  const patterns = [
    /\n\s*-{3,}\s*\n+(?=(?:#{1,6}\s*)?(?:✅\s*)?(?:结论|总结|最终结论|最终答案|答案|Final Answer|Conclusion|Answer))/i,
    /\n\s*#{1,6}\s*(?:✅\s*)?(?:结论|总结|最终结论|最终答案|答案|Final Answer|Conclusion|Answer)/i,
    /\n\s*(?:✅\s*)?(?:结论|总结|最终结论|最终答案|答案|Final Answer|Conclusion|Answer)[：:]/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }

    const finalStart = match.index + match[0].length;
    const processText = text.slice(0, match.index).trim();
    const finalText = text.slice(finalStart).trimStart();
    if (processText.length > 0 && finalText.length > 0) {
      return { finalStart, processText, finalText, marker: match[0] };
    }
  }

  return undefined;
}

function findUnsignedFinalSection(message, config) {
  if (!config?.foldUnsignedFinalSections || message?.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }

  for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = message.content[blockIndex];
    if (block?.type !== "text") {
      continue;
    }
    const split = splitUnsignedFinalSectionText(block.text);
    if (!split) {
      continue;
    }

    return {
      blockIndex,
      split,
      finalBlocks: [{ ...block, text: split.finalText }],
    };
  }

  return undefined;
}

function isFailureStopReason(stopReason) {
  return stopReason === "error" || stopReason === "aborted" || stopReason === "timeout";
}

function isNormalCompletionStopReason(stopReason) {
  return stopReason === "stop" || stopReason === "length" || stopReason === "end_turn";
}

function processGroupId() {
  return `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function signatureIdsForBlocks(blocks) {
  return blocks
    .map((block) => parseTextSignature(block.textSignature)?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

function countProcessMessageContent(message, finalBlocks = [], unsignedFinalSection) {
  const counts = { assistant: 0, thinking: 0, toolCalls: 0, toolResults: 0, custom: 0 };
  if (!message) {
    return counts;
  }

  if (message.role === "toolResult") {
    counts.toolResults += 1;
    return counts;
  }

  if (message.role === "custom") {
    counts.custom += 1;
    return counts;
  }

  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return counts;
  }

  const finalBlockSet = new Set(finalBlocks);
  for (const [blockIndex, block] of message.content.entries()) {
    if (finalBlockSet.has(block)) {
      continue;
    }
    if (unsignedFinalSection?.blockIndex === blockIndex && block.type === "text") {
      if (unsignedFinalSection.split?.processText?.trim()) {
        counts.assistant += 1;
      }
      continue;
    }
    if (block.type === "toolCall") {
      counts.toolCalls += 1;
    } else if (block.type === "thinking") {
      counts.thinking += 1;
    } else if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      counts.assistant += 1;
    }
  }

  return counts;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
  return target;
}

function totalProcessCount(counts) {
  return Object.values(counts).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function formatProcessCountDetails(counts) {
  const labels = [
    ["assistant", "assistant"],
    ["thinking", "thinking"],
    ["toolCalls", "tool calls"],
    ["toolResults", "tool results"],
    ["custom", "custom"],
  ];
  const parts = [];
  for (const [key, label] of labels) {
    const count = counts?.[key] ?? 0;
    if (count > 0) {
      parts.push(`${count} ${label}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "no process items";
}

function formatProcessFoldMarker(group, config, expanded) {
  const template = config.processFoldMarker || DEFAULT_CONFIG.processFoldMarker;
  const total = group?.counts?.total ?? totalProcessCount(group?.counts ?? {});
  const shortcut = config.turnProcessFoldShortcut || "F8";
  return template
    .replaceAll("{state}", expanded ? "shown" : "hidden")
    .replaceAll("{total}", String(total))
    .replaceAll("{details}", formatProcessCountDetails(group?.counts ?? {}))
    .replaceAll("{shortcut}", shortcut)
    .replaceAll("{action}", expanded ? "hide" : "show");
}

function createProcessMarkerMessage(group, config, expanded) {
  return {
    role: "assistant",
    content: [{ type: "text", text: formatProcessFoldMarker(group, config, expanded) }],
    timestamp: group?.createdAt ?? new Date().toISOString(),
    stopReason: "end_turn",
  };
}

function getFinalAnswerContentForRendering(message, config) {
  const finalSection = findUnsignedFinalSection(message, config);
  if (finalSection?.finalBlocks?.length > 0) {
    return finalSection.finalBlocks;
  }

  return getFinalAnswerTextBlocks(message);
}

function createFinalAnswerOnlyMessage(message, group, config) {
  const finalContent = getFinalAnswerContentForRendering(message, config);
  return {
    ...message,
    content: finalContent.length > 0 ? finalContent : message.content,
  };
}

function getFinalAssistantCandidate(message, index, config) {
  if (message?.role !== "assistant" || isFailureStopReason(message.stopReason) || !isNormalCompletionStopReason(message.stopReason)) {
    return undefined;
  }

  const finalBlocks = getFinalAnswerTextBlocks(message);
  const unsignedFinalSection = findUnsignedFinalSection(message, config);
  if (unsignedFinalSection?.finalBlocks?.length > 0) {
    return {
      message,
      index,
      finalBlocks: unsignedFinalSection.finalBlocks,
      unsignedFinalSection,
      finalMode: finalBlocks.length > 0 ? "signed-final-section" : "unsigned-final-section",
    };
  }

  if (finalBlocks.length > 0) {
    return { message, index, finalBlocks, finalMode: "signed-final-answer" };
  }

  return undefined;
}

function findFinalAssistantMessage(messages, config) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = getFinalAssistantCandidate(messages[index], index, config);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function messageMatchesProcessGroupFinal(message, group) {
  if (message?.role !== "assistant" || !group?.final) {
    return false;
  }

  if (group.final.responseId && message.responseId === group.final.responseId) {
    return true;
  }

  if (group.final.timestamp && message.timestamp && group.final.timestamp !== message.timestamp) {
    return false;
  }

  const expectedIds = Array.isArray(group.final.textSignatureIds) ? group.final.textSignatureIds : [];
  if (expectedIds.length > 0) {
    const actualIds = new Set(signatureIdsForBlocks(getFinalAnswerTextBlocks(message)));
    return expectedIds.some((id) => actualIds.has(id));
  }

  if (!group.final.unsignedFinalSection || !group.final.timestamp || message.timestamp !== group.final.timestamp) {
    return false;
  }

  const blockIndex = group.final.unsignedFinalSection.blockIndex;
  const block = Array.isArray(message.content) ? message.content[blockIndex] : undefined;
  const split = block?.type === "text" ? splitUnsignedFinalSectionText(block.text) : undefined;
  const marker = group.final.unsignedFinalSection.marker;
  return Boolean(split && (!marker || split.marker === marker));
}

function previousUserMessageIndex(messages, finalIndex) {
  for (let index = finalIndex - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function getProcessGroupEntriesFromEntries(entries) {
  return entries
    .filter((entry) => entry.type === "custom" && entry.customType === PROCESS_GROUP_ENTRY_TYPE && entry.data)
    .map((entry) => ({ ...entry.data, entryId: entry.id, entryTimestamp: entry.timestamp }));
}

function latestProcessGroup(groups) {
  return groups.at(-1);
}

let expandedProcessGroupId = null;
let lastInteractiveModeInstance;
let lastRenderedProcessGroups = [];
let rawProcessFoldInputUnsubscribe;

function stableHash(value) {
  const text = String(value ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function shouldPreferFoldRange(candidate, current) {
  const candidateHasSplit = Boolean(candidate.group?.final?.unsignedFinalSection);
  const currentHasSplit = Boolean(current.group?.final?.unsignedFinalSection);
  if (candidateHasSplit !== currentHasSplit) {
    return candidateHasSplit;
  }

  const candidateTotal = candidate.group?.counts?.total ?? 0;
  const currentTotal = current.group?.counts?.total ?? 0;
  if (candidateTotal !== currentTotal) {
    return candidateTotal > currentTotal;
  }

  if (Boolean(candidate.group?.derived) !== Boolean(current.group?.derived)) {
    return !candidate.group?.derived;
  }

  return false;
}

function buildFoldRanges(messages, groups) {
  const rangesByKey = new Map();
  dbg(`buildFoldRanges: messages=${messages?.length} groups=${groups?.length} expandedProcessGroupId=${expandedProcessGroupId}`);
  for (const group of groups) {
    const finalIndex = messages.findIndex((message) => messageMatchesProcessGroupFinal(message, group));
    dbg(`buildFoldRanges group: groupId=${group?.groupId} finalIndex=${finalIndex} expanded=${expandedProcessGroupId === group?.groupId}`);
    if (finalIndex < 0) {
      dbg(`buildFoldRanges: SKIP group ${group?.groupId} (finalIndex<0)`);
      continue;
    }
    const userIndex = previousUserMessageIndex(messages, finalIndex);
    const startIndex = userIndex + 1;
    if (startIndex > finalIndex) {
      dbg(`buildFoldRanges: SKIP group ${group?.groupId} (startIndex>finalIndex ${startIndex}>${finalIndex})`);
      continue;
    }
    const range = { group, startIndex, finalIndex, expanded: expandedProcessGroupId === group.groupId };
    const key = `${startIndex}:${finalIndex}`;
    const current = rangesByKey.get(key);
    if (!current || shouldPreferFoldRange(range, current)) {
      rangesByKey.set(key, range);
    }
  }

  return [...rangesByKey.values()].sort((a, b) => a.startIndex - b.startIndex || a.finalIndex - b.finalIndex);
}

function buildProcessGroupFromFinal(messages, final, config, ctx, sourceKind = "agent_end") {
  const userIndex = previousUserMessageIndex(messages, final.index);
  const startIndex = userIndex + 1;
  if (startIndex > final.index) {
    return undefined;
  }

  const counts = { assistant: 0, thinking: 0, toolCalls: 0, toolResults: 0, custom: 0 };
  for (let index = startIndex; index <= final.index; index += 1) {
    mergeCounts(
      counts,
      countProcessMessageContent(
        messages[index],
        index === final.index ? final.finalBlocks : [],
        index === final.index ? final.unsignedFinalSection : undefined,
      ),
    );
  }
  counts.total = totalProcessCount(counts);
  if (counts.total <= 0) {
    return undefined;
  }

  const finalSignatureIds = signatureIdsForBlocks(final.finalBlocks);
  const stableRef = final.message.responseId || `${final.message.timestamp}:${finalSignatureIds.join(",")}:${final.index}`;
  return {
    version: 1,
    groupId: sourceKind === "derived-render" ? `pg_derived_${stableHash(stableRef)}` : processGroupId(),
    createdAt: new Date().toISOString(),
    derived: sourceKind === "derived-render",
    final: {
      mode: final.finalMode,
      responseId: final.message.responseId,
      timestamp: final.message.timestamp,
      provider: final.message.provider,
      model: final.message.model,
      stopReason: final.message.stopReason,
      textSignatureIds: finalSignatureIds,
      unsignedFinalSection: final.unsignedFinalSection
        ? { blockIndex: final.unsignedFinalSection.blockIndex, marker: final.unsignedFinalSection.split?.marker }
        : undefined,
    },
    counts,
    source: {
      kind: sourceKind,
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      leafId: ctx?.sessionManager?.getLeafId?.(),
    },
  };
}

function shouldDerivedGroupOverrideExisting(derivedGroup, existingGroup) {
  const derivedHasSplit = Boolean(derivedGroup?.final?.unsignedFinalSection);
  const existingHasSplit = Boolean(existingGroup?.final?.unsignedFinalSection);
  if (derivedHasSplit && !existingHasSplit) {
    return true;
  }

  const derivedTotal = derivedGroup?.counts?.total ?? 0;
  const existingTotal = existingGroup?.counts?.total ?? 0;
  return derivedHasSplit && derivedTotal > existingTotal;
}

function buildDerivedProcessGroups(messages, existingGroups, config) {
  if (!config.deriveFoldGroupsOnRender) {
    return [];
  }

  const derived = [];
  for (let index = 0; index < messages.length; index += 1) {
    const candidate = getFinalAssistantCandidate(messages[index], index, config);
    if (!candidate) {
      continue;
    }

    const group = buildProcessGroupFromFinal(messages, candidate, config, undefined, "derived-render");
    if (!group) {
      continue;
    }

    const existing = existingGroups.find((existingGroup) => messageMatchesProcessGroupFinal(candidate.message, existingGroup));
    if (existing && !shouldDerivedGroupOverrideExisting(group, existing)) {
      continue;
    }

    derived.push(group);
  }
  return derived;
}

function prepareSessionContextForProcessFolding(sessionContext, entries, config) {
  if (!config.enabled || !config.foldCompletedTurnProcess || !Array.isArray(sessionContext?.messages)) {
    return sessionContext;
  }

  const persistedGroups = getProcessGroupEntriesFromEntries(entries);
  const groups = [
    ...persistedGroups,
    ...buildDerivedProcessGroups(sessionContext.messages, persistedGroups, config),
  ];
  if (groups.length === 0) {
    lastRenderedProcessGroups = [];
    return sessionContext;
  }

  const ranges = buildFoldRanges(sessionContext.messages, groups);
  lastRenderedProcessGroups = ranges.map((range) => range.group);
  dbg(`prepareFold: groups=${groups.length} ranges=${ranges.length} expandedRanges=${ranges.filter(r => r.expanded).length}`);
  for (const range of ranges) {
    dbg(`prepareFold range: groupId=${range.group?.groupId} start=${range.startIndex} final=${range.finalIndex} expanded=${range.expanded}`);
  }
  if (ranges.length === 0) {
    lastRenderedProcessGroups = [];
    return sessionContext;
  }

  const messages = [];
  let index = 0;
  for (const range of ranges) {
    if (range.startIndex < index) {
      continue;
    }

    while (index < range.startIndex) {
      messages.push(sessionContext.messages[index]);
      index += 1;
    }

    messages.push(createProcessMarkerMessage(range.group, config, range.expanded));
    if (range.expanded) {
      while (index <= range.finalIndex) {
        messages.push(sessionContext.messages[index]);
        index += 1;
      }
    } else {
      messages.push(createFinalAnswerOnlyMessage(sessionContext.messages[range.finalIndex], range.group, config));
      index = range.finalIndex + 1;
    }
  }

  while (index < sessionContext.messages.length) {
    messages.push(sessionContext.messages[index]);
    index += 1;
  }

  return {
    ...sessionContext,
    messages,
  };
}

function buildProcessGroupEntry(event, ctx, config) {
  const messages = event.messages ?? [];
  const final = findFinalAssistantMessage(messages, config);
  if (!final) {
    return undefined;
  }

  return buildProcessGroupFromFinal(messages, final, config, ctx, "agent_end");
}

function hasProcessGroupForFinal(ctx, processGroup) {
  const groups = getProcessGroupEntriesFromEntries(ctx?.sessionManager?.getEntries?.() ?? []);
  return groups.some((group) => {
    if (processGroup.final.responseId && group.final?.responseId === processGroup.final.responseId) {
      return true;
    }
    const expected = new Set(processGroup.final.textSignatureIds ?? []);
    return (group.final?.textSignatureIds ?? []).some((id) => expected.has(id));
  });
}

function getInteractiveModeInstanceFromContext(ctx) {
  const instance = ctx?.ui?.[INTERACTIVE_INSTANCE_SYMBOL];
  return instance?.rebuildChatFromMessages ? instance : undefined;
}

function requestProcessFoldRerender(ctx) {
  const contextInstance = getInteractiveModeInstanceFromContext(ctx);
  const instance = contextInstance?.rebuildChatFromMessages
    ? contextInstance
    : lastInteractiveModeInstance;
  dbg(`requestRerender: contextInstance=${contextInstance ? 'yes' : 'no'} hasRebuild=${!!contextInstance?.rebuildChatFromMessages} lastInstance=${lastInteractiveModeInstance ? 'yes' : 'no'}`);
  if (instance?.rebuildChatFromMessages) {
    lastInteractiveModeInstance = instance;
    instance.rebuildChatFromMessages();
    dbg(`requestRerender: rebuild called on instance`);
    return true;
  }
  dbg(`requestRerender: NO instance, fallback requestRender`);
  ctx?.ui?.requestRender?.();
  return false;
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

function unregisterProcessFoldTerminalInput() {
  const unsubscribe = rawProcessFoldInputUnsubscribe;
  rawProcessFoldInputUnsubscribe = undefined;
  if (typeof unsubscribe !== "function") {
    return;
  }

  try {
    unsubscribe();
  } catch (error) {
    console.warn(`codex-compact: terminal input cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function registerProcessFoldTerminalInput(ctx, config) {
  unregisterProcessFoldTerminalInput();
  if (!config.enabled || !config.foldCompletedTurnProcess || !config.turnProcessFoldShortcut) {
    return;
  }
  if (typeof ctx?.ui?.onTerminalInput !== "function") {
    return;
  }

  rawProcessFoldInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!isRawShortcutInput(data, config.turnProcessFoldShortcut)) {
      return undefined;
    }
    toggleLatestProcessGroup(ctx, config);
    return { consume: true };
  });
}

function getCurrentFoldableProcessGroups(ctx, config) {
  const persistedGroups = getProcessGroupEntriesFromEntries(ctx?.sessionManager?.getEntries?.() ?? []);
  const sessionContext = ctx?.sessionManager?.buildSessionContext?.();
  if (Array.isArray(sessionContext?.messages)) {
    const groups = [
      ...persistedGroups,
      ...buildDerivedProcessGroups(sessionContext.messages, persistedGroups, config),
    ];
    return buildFoldRanges(sessionContext.messages, groups).map((range) => range.group);
  }

  return lastRenderedProcessGroups.length > 0 ? lastRenderedProcessGroups : persistedGroups;
}

function toggleLatestProcessGroup(ctx, config) {
  const persistedGroups = getProcessGroupEntriesFromEntries(ctx?.sessionManager?.getEntries?.() ?? []);
  const groups = getCurrentFoldableProcessGroups(ctx, config);
  const latest = latestProcessGroup(groups);
  if (!latest) {
    const scope = persistedGroups.length > 0 ? "current view" : "this session";
    ctx?.ui?.notify?.(`No folded process group in ${scope} yet.`, "info");
    return;
  }

  const willShow = expandedProcessGroupId !== latest.groupId;
  expandedProcessGroupId = willShow ? latest.groupId : null;
  dbg(`TOGGLE: latest.groupId=${latest.groupId} willShow=${willShow} expandedProcessGroupId=${expandedProcessGroupId} persistedGroups=${persistedGroups.length} groups=${groups.length}`);
  const rebuilt = requestProcessFoldRerender(ctx);
  dbg(`TOGGLE: rebuilt=${rebuilt}`);
  const details = formatProcessCountDetails(latest.counts);
  ctx?.ui?.notify?.(
    `Process group ${willShow ? "shown" : "hidden"}: ${latest.counts?.total ?? 0} entries${details ? ` (${details})` : ""}; rerender ${rebuilt ? "rebuild" : "requested"}.`,
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

async function patchAssistantRenderer(ctx, config) {
  if (!config.patchAssistantRenderer) {
    return false;
  }

  const modulePath = resolveAssistantMessageModulePath(config);
  if (!modulePath) {
    ctx?.ui?.setStatus("codex-compact-render", ctx.ui.theme.fg("warning", "Codex render patch: unavailable"));
    return false;
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const prototype = mod.AssistantMessageComponent?.prototype;
  if (!prototype?.updateContent) {
    ctx?.ui?.setStatus("codex-compact-render", ctx.ui.theme.fg("warning", "Codex render patch: incompatible"));
    return false;
  }

  if (prototype[RENDER_PATCH_SYMBOL]) {
    const patchData = prototype[RENDER_PATCH_DATA_SYMBOL];
    if (patchData?.version === RENDER_PATCH_VERSION) {
      prototype[RENDER_PATCH_DATA_SYMBOL] = {
        ...patchData,
        config,
      };
      return true;
    }

    if (typeof patchData?.originalUpdateContent === "function") {
      prototype.updateContent = patchData.originalUpdateContent;
    }
    prototype[RENDER_PATCH_SYMBOL] = false;
  }

  const originalUpdateContent = prototype.updateContent;
  prototype[RENDER_PATCH_DATA_SYMBOL] = { version: RENDER_PATCH_VERSION, originalUpdateContent, config };
  prototype.updateContent = function patchedUpdateContent(message) {
    const patchData = prototype[RENDER_PATCH_DATA_SYMBOL];
    const renderMessage = patchData?.config?.enabled && patchData?.config?.patchAssistantRenderer && patchData?.config?.stripCommentaryText
      ? prepareMessageForRendering(message, patchData.config)
      : message;
    return patchData.originalUpdateContent.call(this, renderMessage);
  };
  prototype[RENDER_PATCH_SYMBOL] = true;
  return true;
}

async function syncAssistantRendererPatchConfig(config) {
  const modulePath = resolveAssistantMessageModulePath(config);
  if (!modulePath) {
    return;
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const prototype = mod.AssistantMessageComponent?.prototype;
  if (prototype?.[RENDER_PATCH_SYMBOL] && prototype[RENDER_PATCH_DATA_SYMBOL]) {
    prototype[RENDER_PATCH_DATA_SYMBOL] = {
      ...prototype[RENDER_PATCH_DATA_SYMBOL],
      config,
    };
  }
}

async function patchInteractiveModeRenderer(ctx, config) {
  if (!config.patchAssistantRenderer || !config.foldCompletedTurnProcess) {
    return false;
  }

  const modulePath = resolveInteractiveModeModulePath(config);
  if (!modulePath) {
    ctx?.ui?.setStatus?.("codex-compact-fold", ctx.ui.theme.fg("warning", "Codex fold patch: unavailable"));
    return false;
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const prototype = mod.InteractiveMode?.prototype;
  if (!prototype?.renderSessionContext || !prototype?.handleEvent || !prototype?.createExtensionUIContext || !prototype?.addExtensionTerminalInputListener) {
    ctx?.ui?.setStatus?.("codex-compact-fold", ctx.ui.theme.fg("warning", "Codex fold patch: incompatible"));
    return false;
  }

  if (prototype[INTERACTIVE_PATCH_SYMBOL]) {
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    // index.cjs cache-busts index.js on every /reload. Reuse the original
    // methods, but always install fresh closures so fold state and shortcuts
    // come from the same module instance.
    if (typeof patchData?.originalRenderSessionContext === "function") {
      prototype.renderSessionContext = patchData.originalRenderSessionContext;
    }
    if (typeof patchData?.originalHandleEvent === "function") {
      prototype.handleEvent = patchData.originalHandleEvent;
    }
    if (typeof patchData?.originalCreateExtensionUIContext === "function") {
      prototype.createExtensionUIContext = patchData.originalCreateExtensionUIContext;
    }
    if (typeof patchData?.originalAddExtensionTerminalInputListener === "function") {
      prototype.addExtensionTerminalInputListener = patchData.originalAddExtensionTerminalInputListener;
    }
    prototype[INTERACTIVE_PATCH_SYMBOL] = false;
  }

  const originalRenderSessionContext = prototype.renderSessionContext;
  const originalHandleEvent = prototype.handleEvent;
  const originalCreateExtensionUIContext = prototype.createExtensionUIContext;
  const originalAddExtensionTerminalInputListener = prototype.addExtensionTerminalInputListener;
  prototype[INTERACTIVE_PATCH_DATA_SYMBOL] = {
    version: INTERACTIVE_PATCH_VERSION,
    originalRenderSessionContext,
    originalHandleEvent,
    originalCreateExtensionUIContext,
    originalAddExtensionTerminalInputListener,
    config,
  };

  prototype.renderSessionContext = function patchedRenderSessionContext(sessionContext, options) {
    lastInteractiveModeInstance = this;
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    const entries = this.sessionManager?.getEntries?.() ?? [];
    const renderContext = patchData?.config?.enabled && patchData?.config?.foldCompletedTurnProcess
      ? prepareSessionContextForProcessFolding(sessionContext, entries, patchData.config)
      : sessionContext;
    return patchData.originalRenderSessionContext.call(this, renderContext, options);
  };

  prototype.handleEvent = async function patchedHandleEvent(event) {
    lastInteractiveModeInstance = this;
    const patchData = prototype[INTERACTIVE_PATCH_DATA_SYMBOL];
    const result = await patchData.originalHandleEvent.call(this, event);
    if (event?.type === "agent_end" && patchData?.config?.enabled && patchData?.config?.foldCompletedTurnProcess) {
      this.rebuildChatFromMessages?.();
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

  prototype[INTERACTIVE_PATCH_SYMBOL] = true;
  return true;
}

async function syncInteractiveModePatchConfig(config) {
  const modulePath = resolveInteractiveModeModulePath(config);
  if (!modulePath) {
    return;
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const prototype = mod.InteractiveMode?.prototype;
  if (prototype?.[INTERACTIVE_PATCH_SYMBOL] && prototype[INTERACTIVE_PATCH_DATA_SYMBOL]) {
    prototype[INTERACTIVE_PATCH_DATA_SYMBOL] = {
      ...prototype[INTERACTIVE_PATCH_DATA_SYMBOL],
      config,
    };
  }
}

function applyUiConfig(ctx, config) {
  if (!ctx?.ui) {
    return;
  }

  ctx.ui.setHiddenThinkingLabel(config.hiddenThinkingLabel);
  ctx.ui.setToolsExpanded(!config.collapseToolOutput);
  ctx.ui.setWorkingMessage(config.workingMessage);

  if (config.hideWorkingRow) {
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingIndicator({ frames: [] });
  } else {
    ctx.ui.setWorkingVisible(true);
  }
}

async function enableCompactRuntime(ctx, config) {
  applyUiConfig(ctx, config);
  if (config.loadError) {
    ctx.ui.notify(`Codex compact config load failed, using defaults: ${config.loadError}`, "warning");
  }

  try {
    const patched = await patchAssistantRenderer(ctx, config);
    const foldPatched = await patchInteractiveModeRenderer(ctx, config);
    registerProcessFoldTerminalInput(ctx, config);
    ctx.ui.setStatus(
      "codex-compact",
      ctx.ui.theme.fg("dim", `Codex compact: on${patched ? " + render patch" : ""}${foldPatched ? " + fold patch" : ""}`),
    );
  } catch (error) {
    ctx.ui.setStatus("codex-compact", ctx.ui.theme.fg("warning", "Codex compact: on; render patch failed"));
    ctx.ui.notify(`Codex compact render patch failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

async function disableCompactRuntime(ctx, config) {
  closeHiddenCommentarySummary(ctx);
  expandedProcessGroupId = null;
  unregisterProcessFoldTerminalInput();
  await syncAssistantRendererPatchConfig(config);
  await syncInteractiveModePatchConfig(config);
  requestProcessFoldRerender(ctx);
  ctx.ui.setHiddenThinkingLabel();
  ctx.ui.setWorkingMessage();
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingIndicator();
  ctx.ui.setStatus("codex-compact", undefined);
}

function getAuditEntries(ctx) {
  return ctx.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === AUDIT_ENTRY_TYPE);
}

let hiddenSummaryWidgetVisible = false;

function resetEphemeralRuntimeState() {
  expandedProcessGroupId = null;
  lastInteractiveModeInstance = undefined;
  lastRenderedProcessGroups = [];
  hiddenSummaryWidgetVisible = false;
  unregisterProcessFoldTerminalInput();
}

function getHiddenSummaryWidgetLines(summary, config) {
  const lines = summary.split("\n");
  if (config.hiddenSummaryShortcut) {
    lines.splice(1, 0, `Press ${config.hiddenSummaryShortcut} again to close.`);
  }
  return lines;
}

function closeHiddenCommentarySummary(ctx) {
  if (typeof ctx?.ui?.setWidget !== "function") {
    return false;
  }

  ctx.ui.setWidget(HIDDEN_SUMMARY_WIDGET_KEY, undefined);
  hiddenSummaryWidgetVisible = false;
  return true;
}

function showLatestHiddenCommentarySummary(ctx, config) {
  const summary = formatLatestHiddenCommentarySummary(getAuditEntries(ctx));
  if (typeof ctx?.ui?.setWidget === "function") {
    ctx.ui.setWidget(HIDDEN_SUMMARY_WIDGET_KEY, getHiddenSummaryWidgetLines(summary, config), { placement: "aboveEditor" });
    hiddenSummaryWidgetVisible = true;
    return;
  }

  ctx.ui.notify(summary, "info");
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
    `turn folding: ${config.foldCompletedTurnProcess ? "on" : "off"}; ` +
    `unsigned final fallback: ${config.foldUnsignedFinalSections ? "on" : "off"}; ` +
    `render-derived folds: ${config.deriveFoldGroupsOnRender ? "on" : "off"}; ` +
    `audit: ${config.auditHiddenCommentary ? "on" : "off"}; ` +
    `render patch: ${config.patchAssistantRenderer ? "on" : "off"}; ` +
    `marker: ${config.showHiddenCommentaryMarker ? "on" : "off"}; ` +
    `summary shortcut: ${config.hiddenSummaryShortcut || "off"}; ` +
    `process shortcut: ${config.turnProcessFoldShortcut || "off"}; ` +
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
    `Turn process folding: ${config.foldCompletedTurnProcess ? "enabled" : "disabled"}`,
    `Unsigned final-section fallback: ${config.foldUnsignedFinalSections ? "enabled" : "disabled"}`,
    `Render-derived fold groups: ${config.deriveFoldGroupsOnRender ? "enabled" : "disabled"}`,
    `Audit entries: ${config.auditHiddenCommentary ? "enabled" : "disabled"}`,
    `Renderer patch configured: ${config.patchAssistantRenderer ? "enabled" : "disabled"}`,
    `Hidden commentary marker: ${config.showHiddenCommentaryMarker ? "enabled" : "disabled"}`,
    `Hidden summary shortcut: ${config.hiddenSummaryShortcut || "disabled"}`,
    `Turn process shortcut: ${config.turnProcessFoldShortcut || "disabled"}`,
  ];

  const modulePath = resolveAssistantMessageModulePath(config);
  lines.push(`Assistant renderer module: ${modulePath ?? "not found"}`);

  if (!config.patchAssistantRenderer) {
    lines.push("Renderer patch check: skipped; disabled by config");
  } else if (!modulePath) {
    lines.push("Renderer patch check: failed; assistant renderer module was not found");
  } else {
    try {
      const mod = await import(pathToFileURL(modulePath).href);
      const prototype = mod.AssistantMessageComponent?.prototype;
      const compatible = typeof prototype?.updateContent === "function";
      lines.push(`AssistantMessageComponent.updateContent: ${compatible ? "found" : "missing"}`);
      lines.push(`Renderer currently patched: ${prototype?.[RENDER_PATCH_SYMBOL] ? "yes" : "no"}`);
      lines.push(`Renderer patch version: ${prototype?.[RENDER_PATCH_DATA_SYMBOL]?.version ?? "legacy/unknown"}`);
      lines.push(`Renderer patch check: ${compatible ? "compatible" : "incompatible"}`);
    } catch (error) {
      lines.push(`Renderer patch check: import failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const interactivePath = resolveInteractiveModeModulePath(config);
  lines.push(`Interactive mode module: ${interactivePath ?? "not found"}`);
  if (!config.patchAssistantRenderer || !config.foldCompletedTurnProcess) {
    lines.push("Turn fold patch check: skipped; disabled by config");
    return lines.join("\n");
  }
  if (!interactivePath) {
    lines.push("Turn fold patch check: failed; interactive mode module was not found");
    return lines.join("\n");
  }
  try {
    const mod = await import(pathToFileURL(interactivePath).href);
    const prototype = mod.InteractiveMode?.prototype;
    const compatible = typeof prototype?.renderSessionContext === "function"
      && typeof prototype?.handleEvent === "function"
      && typeof prototype?.createExtensionUIContext === "function"
      && typeof prototype?.addExtensionTerminalInputListener === "function";
    lines.push(`InteractiveMode.renderSessionContext: ${typeof prototype?.renderSessionContext === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.handleEvent: ${typeof prototype?.handleEvent === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.createExtensionUIContext: ${typeof prototype?.createExtensionUIContext === "function" ? "found" : "missing"}`);
    lines.push(`InteractiveMode.addExtensionTerminalInputListener: ${typeof prototype?.addExtensionTerminalInputListener === "function" ? "found" : "missing"}`);
    lines.push(`Turn fold currently patched: ${prototype?.[INTERACTIVE_PATCH_SYMBOL] ? "yes" : "no"}`);
    lines.push(`Turn fold patch version: ${prototype?.[INTERACTIVE_PATCH_DATA_SYMBOL]?.version ?? "legacy/unknown"}`);
    lines.push(`Turn fold patch check: ${compatible ? "compatible" : "incompatible"}`);
  } catch (error) {
    lines.push(`Turn fold patch check: import failed (${error instanceof Error ? error.message : String(error)})`);
  }

  return lines.join("\n");
}

export default function piCodexCompact(pi) {
  let config = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    resetEphemeralRuntimeState();
    if (!config.enabled) {
      return;
    }
    await enableCompactRuntime(ctx, config);
  });

  pi.on("agent_end", (event, ctx) => {
    if (!config.enabled || !config.foldCompletedTurnProcess) {
      return;
    }

    const processGroup = buildProcessGroupEntry(event, ctx, config);
    if (!processGroup || hasProcessGroupForFinal(ctx, processGroup)) {
      return;
    }

    expandedProcessGroupId = null;
    pi.appendEntry(PROCESS_GROUP_ENTRY_TYPE, processGroup);
  });

  pi.on("input", (event, ctx) => {
    const text = typeof event.text === "string" ? event.text.trim().toLowerCase() : "";
    if (!["codex-compact toggle", "codex-compact fold", "compact toggle", "compact fold"].includes(text)) {
      return { action: "continue" };
    }

    toggleLatestProcessGroup(ctx, config);
    return { action: "handled" };
  });

  pi.on("message_end", (event, ctx) => {
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
        ctx?.ui?.notify(formatHiddenCommentaryMarker(hiddenBlocks.length, config), "info");
      }
      return { message };
    }
  });

  if (config.turnProcessFoldShortcut) {
    pi.registerShortcut(config.turnProcessFoldShortcut, {
      description: "Show or hide the latest folded turn process in place",
      handler: (ctx) => toggleLatestProcessGroup(ctx, config),
    });
  }

  if (config.hiddenSummaryShortcut && config.hiddenSummaryShortcut !== config.turnProcessFoldShortcut) {
    pi.registerShortcut(config.hiddenSummaryShortcut, {
      description: "Show latest hidden commentary metadata without revealing hidden text",
      handler: (ctx) => toggleLatestHiddenCommentarySummary(ctx, config),
    });
  }

  pi.registerCommand("codex-compact", {
    description: "Show, reload, or toggle Codex-style compact display settings.",
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "audit") {
        ctx.ui.notify(formatAuditSummary(getAuditEntries(ctx)), "info");
        return;
      }

      if (subcommand === "latest" || subcommand === "summary") {
        showLatestHiddenCommentarySummary(ctx, config);
        return;
      }

      if (subcommand === "doctor") {
        ctx.ui.notify(await formatDoctorReport(config), "info");
        return;
      }

      if (subcommand === "reload") {
        config = loadConfig();
        if (config.enabled) {
          await enableCompactRuntime(ctx, config);
        } else {
          await disableCompactRuntime(ctx, config);
        }
        ctx.ui.notify(`Codex compact config reloaded. ${formatConfigSummary(config)}`, "info");
        return;
      }

      if (subcommand === "toggle" || subcommand === "fold") {
        toggleLatestProcessGroup(ctx, config);
        return;
      }

      if (!subcommand || subcommand === "show") {
        ctx.ui.notify(formatConfigSummary(config), "info");
        return;
      }

      if (subcommand !== "on" && subcommand !== "off") {
        ctx.ui.notify("Usage: /codex-compact [show|audit|latest|summary|doctor|reload|toggle|fold|on|off]", "error");
        return;
      }

      config = { ...config, enabled: subcommand === "on" };
      if (config.enabled) {
        await enableCompactRuntime(ctx, config);
      } else {
        await disableCompactRuntime(ctx, config);
      }
      ctx.ui.notify(`Codex compact ${config.enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
