import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(__dirname, "index.cjs");
const configPath = join(__dirname, "config.json");
const settingsPath = "/root/.pi/agent/settings.json";
const piPackageRoot = "/root/node-v22.22.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent";
const assistantMessagePath = join(piPackageRoot, "dist/modes/interactive/components/assistant-message.js");
const toolExecutionPath = join(piPackageRoot, "dist/modes/interactive/components/tool-execution.js");
const interactiveModePath = join(piPackageRoot, "dist/modes/interactive/interactive-mode.js");
const sessionManagerPath = join(piPackageRoot, "dist/core/session-manager.js");
const themePath = join(piPackageRoot, "dist/modes/interactive/theme/theme.js");
let AssistantMessageComponentClass;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function createMockRuntime() {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const customEntries = [];
  const notifications = [];
  const statuses = [];
  const widgets = new Map();
  const calls = [];
  const terminalInputListeners = [];
  let sessionMessages = [];
  let nextEntryId = 1;
  let toolsExpanded = false;

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerShortcut(shortcut, options) {
      shortcuts.set(shortcut, options);
    },
    appendEntry(customType, data) {
      customEntries.push({
        type: "custom",
        id: `custom_${nextEntryId++}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
  };

  const ui = {
    notify(message, type) {
      notifications.push({ message, type });
    },
    requestRender() {
      calls.push(["requestRender"]);
    },
    onTerminalInput(handler) {
      terminalInputListeners.push(handler);
      return () => {
        const index = terminalInputListeners.indexOf(handler);
        if (index >= 0) terminalInputListeners.splice(index, 1);
      };
    },
    setHiddenThinkingLabel(value) {
      calls.push(["setHiddenThinkingLabel", value]);
    },
    setToolsExpanded(value) {
      calls.push(["setToolsExpanded", value]);
      toolsExpanded = value;
    },
    getToolsExpanded() {
      return toolsExpanded;
    },
    setWorkingMessage(value) {
      calls.push(["setWorkingMessage", value]);
    },
    setWorkingVisible(value) {
      calls.push(["setWorkingVisible", value]);
    },
    setWorkingIndicator(value) {
      calls.push(["setWorkingIndicator", value]);
    },
    setStatus(key, text) {
      statuses.push({ key, text });
    },
    setWidget(key, content, options) {
      calls.push(["setWidget", key, content, options]);
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, { content, options });
    },
    theme: {
      fg(style, text) {
        return style === "dim" ? `\x1b[2m${text}\x1b[22m` : text;
      },
    },
  };

  const ctx = {
    mode: "tui",
    ui,
    sessionManager: {
      getEntries: () => customEntries,
      buildSessionContext: () => ({
        messages: sessionMessages.filter((item) => item?.type !== "custom"),
        thinkingLevel: "off",
        model: null,
      }),
      getSessionId: () => "smoke-session",
      getLeafId: () => "leaf-smoke",
      getCwd: () => process.cwd(),
    },
  };

  return {
    pi,
    ctx,
    handlers,
    commands,
    shortcuts,
    customEntries,
    notifications,
    statuses,
    widgets,
    calls,
    terminalInputListeners,
    getToolsExpanded: () => toolsExpanded,
    getSessionMessages: () => sessionMessages,
    setSessionMessages(messages) {
      sessionMessages = messages;
    },
  };
}

function signature(id, phase) {
  return JSON.stringify({ v: 1, id, phase });
}

function textMessage(text, phase, id = phase) {
  return { type: "text", text, textSignature: signature(id, phase) };
}

function makeBatch(responseId, timestamp, toolNames, errorIndexes = []) {
  const calls = toolNames.map((name, index) => ({
    type: "toolCall",
    id: `${responseId}_call_${index}`,
    name,
    arguments: { index },
  }));
  const assistant = {
    role: "assistant",
    responseId,
    timestamp,
    stopReason: "toolUse",
    content: [
      textMessage(`${responseId} commentary`, "commentary", `${responseId}-commentary`),
      { type: "thinking", thinking: `${responseId} thinking`, thinkingSignature: `${responseId}-thinking-signature` },
      calls[0],
      textMessage(`${responseId} final text`, "final_answer", `${responseId}-final`),
      ...calls.slice(1),
    ],
  };
  const results = calls.map((call, index) => ({
    role: "toolResult",
    toolCallId: call.id,
    content: [{ type: "text", text: `${responseId} result ${index}` }],
    isError: errorIndexes.includes(index),
    timestamp: timestamp + index + 1,
  }));
  return { assistant, calls, results };
}

function isMarkerBlock(block) {
  return block.type === "text" && stripVTControlCharacters(block.text).startsWith("⌕ ");
}

function markerTexts(items) {
  return items.flatMap((item) => item?.role === "assistant" && Array.isArray(item.content)
    ? item.content.filter(isMarkerBlock).map((block) => stripVTControlCharacters(block.text))
    : []);
}

function toolCallCount(items) {
  return items.reduce((total, item) => total + (item?.role === "assistant" && Array.isArray(item.content)
    ? item.content.filter((block) => block.type === "toolCall").length
    : 0), 0);
}

function thinkingBlockCount(items) {
  return items.reduce((total, item) => total + (item?.role === "assistant" && Array.isArray(item.content)
    ? item.content.filter((block) => block.type === "thinking").length
    : 0), 0);
}

function createInteractiveRendererHarness(InteractiveMode, sessionManager, ui, getItems) {
  const chatContainer = {
    children: [],
    clearCount: 0,
    addChild(component) {
      this.children.push(component);
    },
    clear() {
      this.clearCount += 1;
      this.children = [];
    },
  };

  const harness = {
    sessionManager,
    session: { modelRegistry: {}, retryAttempt: 0 },
    settingsManager: {
      getShowCacheMissNotices: () => false,
      getShowImages: () => false,
      getImageWidthCells: () => 60,
    },
    footer: { invalidate() {} },
    pendingTools: new Map(),
    chatContainer,
    toolOutputExpanded: false,
    ui,
    renderedSourceItems: undefined,
    assistantComponents: new Map(),
    rebuildCount: 0,
    updateEditorBorderColor() {},
    getRegisteredToolDefinition() {
      return undefined;
    },
    addMessageToChat(message) {
      if (message?.role === "compactionSummary") {
        chatContainer.addChild({
          message,
          expanded: this.toolOutputExpanded,
          setExpanded(expanded) {
            this.expanded = expanded;
          },
        });
        return;
      }
      if (message?.role !== "assistant" || !AssistantMessageComponentClass) {
        chatContainer.addChild({ renderedMessage: message });
        return;
      }
      const component = new AssistantMessageComponentClass(message, true);
      Object.defineProperty(component, "renderedMessage", {
        configurable: true,
        get: () => component.lastMessage,
      });
      const key = message.responseId ?? message.timestamp;
      this.assistantComponents.set(key, component);
      chatContainer.addChild(component);
    },
    addCustomEntryToChat(entry) {
      chatContainer.addChild({ renderedCustomEntry: entry });
    },
    showStatus(message) {
      return InteractiveMode.prototype.showStatus.call(this, message);
    },
    rebuildChatFromMessages() {
      this.rebuildCount += 1;
      chatContainer.clear();
      InteractiveMode.prototype.renderSessionItems.call(this, getItems());
    },
  };
  Object.defineProperty(harness, "renderedItems", {
    configurable: true,
    get() {
      return (this.renderedSourceItems ?? []).map((item) => {
        if (item?.role !== "assistant") return item;
        const key = item.responseId ?? item.timestamp;
        return this.assistantComponents.get(key)?.lastMessage ?? item;
      });
    },
  });
  return harness;
}

async function loadExtension() {
  const extension = await import(`${pathToFileURL(extensionPath).href}?smoke=${Date.now()}-${Math.random()}`);
  return extension.default;
}

async function main() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert(config.stripCommentaryText === false, "default config should preserve commentary");
  assert(config.foldCompletedToolBatches === true, "completed tool-batch folding should be enabled by default");
  assert(config.toolBatchFoldShortcut === "alt+p", "default tool-batch shortcut should be alt+p");
  assert(config.patchInternalRenderers === true, "internal renderer patches should be enabled by default");
  assert(!("foldCompletedTurnProcess" in config), "canonical config should not expose obsolete whole-turn options");
  assert(config.collapseToolOutput === false, "active tools should stay expanded");

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert(settings.extensions?.includes("./extensions/pi-codex-compact/index.cjs"), "settings.json does not register the extension");
  const packageInfo = JSON.parse(readFileSync(join(piPackageRoot, "package.json"), "utf8"));
  assert(
    ["0.80.6", "0.80.7"].includes(packageInfo.version),
    `smoke fixture supports Pi 0.80.6-0.80.7, found ${packageInfo.version}`,
  );

  const { AssistantMessageComponent } = await import(pathToFileURL(assistantMessagePath).href);
  const { ToolExecutionComponent } = await import(pathToFileURL(toolExecutionPath).href);
  const { InteractiveMode } = await import(pathToFileURL(interactiveModePath).href);
  const { SessionManager, sessionEntryToContextMessages } = await import(pathToFileURL(sessionManagerPath).href);
  const { initTheme } = await import(pathToFileURL(themePath).href);
  initTheme("dark");
  AssistantMessageComponentClass = AssistantMessageComponent;
  const renderPatchSymbol = Symbol.for("pi-codex-compact.assistant-renderer-patched");
  const renderPatchDataSymbol = Symbol.for("pi-codex-compact.assistant-renderer-patch-data");
  const toolRenderPatchSymbol = Symbol.for("pi-codex-compact.tool-renderer-patched");
  const toolRenderPatchDataSymbol = Symbol.for("pi-codex-compact.tool-renderer-patch-data");
  const interactivePatchSymbol = Symbol.for("pi-codex-compact.interactive-render-patched");
  const interactivePatchDataSymbol = Symbol.for("pi-codex-compact.interactive-render-patch-data");
  const registrationSymbol = Symbol.for("pi-codex-compact.registration");

  const realUpdateContent = AssistantMessageComponent.prototype[renderPatchDataSymbol]?.originalUpdateContent
    ?? AssistantMessageComponent.prototype.updateContent;
  const realToolRender = ToolExecutionComponent.prototype[toolRenderPatchDataSymbol]?.originalRender
    ?? ToolExecutionComponent.prototype.render;
  const realRenderSessionItems = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalRenderSessionItems
    ?? InteractiveMode.prototype.renderSessionItems;
  const realRenderSessionContext = InteractiveMode.prototype.renderSessionContext;
  const realHandleEvent = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalHandleEvent
    ?? InteractiveMode.prototype.handleEvent;
  const realCreateExtensionUIContext = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalCreateExtensionUIContext
    ?? InteractiveMode.prototype.createExtensionUIContext;
  const realAddExtensionTerminalInputListener = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalAddExtensionTerminalInputListener
    ?? InteractiveMode.prototype.addExtensionTerminalInputListener;
  const realShowExtensionNotify = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalShowExtensionNotify
    ?? InteractiveMode.prototype.showExtensionNotify;
  const realRebuildChatFromMessages = InteractiveMode.prototype.rebuildChatFromMessages;

  assert(typeof realRenderSessionItems === "function", "installed Pi must expose renderSessionItems");
  assert(realRenderSessionContext === undefined, "supported Pi should not expose obsolete renderSessionContext");

  try {
    AssistantMessageComponent.prototype.updateContent = realUpdateContent;
    AssistantMessageComponent.prototype[renderPatchSymbol] = false;
    AssistantMessageComponent.prototype[renderPatchDataSymbol] = undefined;
    ToolExecutionComponent.prototype.render = realToolRender;
    ToolExecutionComponent.prototype[toolRenderPatchSymbol] = false;
    ToolExecutionComponent.prototype[toolRenderPatchDataSymbol] = undefined;
    InteractiveMode.prototype[interactivePatchSymbol] = false;
    InteractiveMode.prototype[interactivePatchDataSymbol] = undefined;
    InteractiveMode.prototype.showExtensionNotify = realShowExtensionNotify;

    const nonTuiRuntime = createMockRuntime();
    nonTuiRuntime.ctx.mode = "json";
    const nonTuiExtension = await loadExtension();
    await nonTuiExtension(nonTuiRuntime.pi);
    await nonTuiRuntime.handlers.get("session_start")({ type: "session_start" }, nonTuiRuntime.ctx);
    assert(!InteractiveMode.prototype[interactivePatchSymbol], "non-TUI startup should not patch InteractiveMode");
    assert(nonTuiRuntime.terminalInputListeners.length === 0, "non-TUI startup should not register terminal input");
    nonTuiRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, nonTuiRuntime.ctx);

    InteractiveMode.prototype.renderSessionItems = undefined;
    const incompatibleRuntime = createMockRuntime();
    const incompatibleExtension = await loadExtension();
    await incompatibleExtension(incompatibleRuntime.pi);
    await incompatibleRuntime.handlers.get("session_start")({ type: "session_start" }, incompatibleRuntime.ctx);
    assert(
      incompatibleRuntime.statuses.some((status) => status.key === "codex-compact-fold" && String(status.text).includes("incompatible")),
      "missing renderSessionItems should report an incompatible adapter",
    );
    incompatibleRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, incompatibleRuntime.ctx);

    InteractiveMode.prototype.renderSessionItems = realRenderSessionItems;
    ToolExecutionComponent.prototype.render = undefined;
    const missingToolRuntime = createMockRuntime();
    const missingToolExtension = await loadExtension();
    await missingToolExtension(missingToolRuntime.pi);
    await missingToolRuntime.handlers.get("session_start")({ type: "session_start" }, missingToolRuntime.ctx);
    assert(!InteractiveMode.prototype[interactivePatchSymbol], "missing tool renderer should fail open without interactive folding");
    assert(
      missingToolRuntime.statuses.some((status) => status.key === "codex-compact-tool-render" && String(status.text).includes("incompatible")),
      "missing ToolExecutionComponent.render should report an incompatible component adapter",
    );
    missingToolRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, missingToolRuntime.ctx);

    ToolExecutionComponent.prototype.render = realToolRender;
    InteractiveMode.prototype.rebuildChatFromMessages = undefined;
    const missingRebuildRuntime = createMockRuntime();
    const missingRebuildExtension = await loadExtension();
    await missingRebuildExtension(missingRebuildRuntime.pi);
    await missingRebuildRuntime.handlers.get("session_start")({ type: "session_start" }, missingRebuildRuntime.ctx);
    assert(
      InteractiveMode.prototype[interactivePatchSymbol],
      "component-state adapter should not depend on rebuildChatFromMessages",
    );
    missingRebuildRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, missingRebuildRuntime.ctx);

    InteractiveMode.prototype.rebuildChatFromMessages = realRebuildChatFromMessages;
    const realAdapterRuntime = createMockRuntime();
    const realAdapterExtension = await loadExtension();
    await realAdapterExtension(realAdapterRuntime.pi);
    await realAdapterRuntime.handlers.get("session_start")({ type: "session_start" }, realAdapterRuntime.ctx);
    const realPatchData = InteractiveMode.prototype[interactivePatchDataSymbol];
    assert(realPatchData?.originalRenderSessionItems === realRenderSessionItems, "patch did not wrap Pi's real renderSessionItems");
    assert(realPatchData?.adapter === "component-state", "real installed adapter should be component-state");
    assert(realPatchData?.version === 13, "unexpected real interactive patch version");
    await realAdapterRuntime.commands.get("codex-compact").handler("doctor", realAdapterRuntime.ctx);
    const realDoctor = realAdapterRuntime.notifications.at(-1)?.message ?? "";
    for (const expected of [
      "Completed tool-batch folding: enabled",
      "Fold unit: narrative-bounded activity segment",
      "Renderer patch version: 5",
      "Interactive adapter: component-state",
      "ToolExecutionComponent.render: found",
      "Tool renderer patch version: 1",
      "InteractiveMode.renderSessionItems: found",
      "InteractiveMode.renderSessionContext: missing (expected on supported Pi)",
      "InteractiveMode.showExtensionNotify: found",
      "InteractiveMode.rebuildChatFromMessages: found",
      "Tool-batch fold patch version: 13",
      "Tool-batch fold patch adapter: component-state",
      "Tool-batch fold patch check: compatible",
    ]) {
      assert(realDoctor.includes(expected), `doctor output missing: ${expected}`);
    }

    delete globalThis[registrationSymbol];
    const legacyDisableDir = mkdtempSync(join(tmpdir(), "pi-codex-compact-legacy-disable-"));
    copyFileSync(join(__dirname, "index.js"), join(legacyDisableDir, "index.js"));
    writeFileSync(join(legacyDisableDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(legacyDisableDir, "config.json"), JSON.stringify({
      enabled: true,
      patchAssistantRenderer: false,
      foldCompletedToolBatches: true,
      toolBatchFoldShortcut: "alt+p",
    }));
    const legacyDisableModule = await import(`${pathToFileURL(join(legacyDisableDir, "index.js")).href}?legacy-disable=${Date.now()}`);
    const legacyDisableRuntime = createMockRuntime();
    await legacyDisableModule.default(legacyDisableRuntime.pi);
    await legacyDisableRuntime.handlers.get("session_start")({ type: "session_start" }, legacyDisableRuntime.ctx);
    assert(!InteractiveMode.prototype[interactivePatchSymbol], "legacy patchAssistantRenderer=false did not clean up a stale patch");
    assert(legacyDisableRuntime.terminalInputListeners.length === 0, "disabled internal patches registered a raw terminal listener");
    realAdapterRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, realAdapterRuntime.ctx);
    legacyDisableRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, legacyDisableRuntime.ctx);

    const aliasDir = mkdtempSync(join(tmpdir(), "pi-codex-compact-alias-"));
    copyFileSync(join(__dirname, "index.js"), join(aliasDir, "index.js"));
    writeFileSync(join(aliasDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(aliasDir, "config.json"), JSON.stringify({
      enabled: true,
      stripCommentaryText: true,
      foldCompletedToolBatches: true,
      foldCompletedTurnProcess: false,
      turnProcessFoldShortcut: "alt+x",
      processFoldMarker: "legacy {details} ({shortcut})",
      auditMaxTextChars: 1,
      showHiddenCommentaryMarker: false,
      hiddenSummaryShortcut: "alt+s",
    }));
    const aliasModule = await import(`${pathToFileURL(join(aliasDir, "index.js")).href}?alias=${Date.now()}`);
    const aliasRuntime = createMockRuntime();
    await aliasModule.default(aliasRuntime.pi);
    assert(aliasRuntime.shortcuts.has("alt+x"), "legacy shortcut alias was not normalized");
    await aliasRuntime.handlers.get("session_start")({ type: "session_start" }, aliasRuntime.ctx);
    assert(aliasRuntime.getToolsExpanded() === true, "enabled runtime should apply its tool expansion preference");

    const commentaryOnly = new AssistantMessageComponent({
      role: "assistant",
      content: [textMessage("commentary-only response", "commentary", "commentary-only")],
      stopReason: "stop",
    }, true);
    assert(
      commentaryOnly.render(100).join("\n").includes("commentary-only response"),
      "commentary-only response must fail open instead of disappearing",
    );

    const largeUnicodeCommentary = "😀x".repeat(64 * 1024);
    const unicodeAuditMessage = {
      role: "assistant",
      responseId: "unicode-audit",
      timestamp: 4,
      stopReason: "stop",
      content: [
        textMessage(largeUnicodeCommentary, "commentary", "unicode-commentary"),
        textMessage("visible final", "final_answer", "unicode-final"),
      ],
    };
    const unicodeAuditResult = aliasRuntime.handlers.get("message_end")(
      { type: "message_end", message: unicodeAuditMessage },
      aliasRuntime.ctx,
    );
    assert(unicodeAuditResult?.message !== unicodeAuditMessage, "signed commentary should still be filtered when final text exists");
    const unicodeAuditBlock = aliasRuntime.customEntries.at(-1)?.data?.hiddenBlocks?.[0];
    assert(unicodeAuditBlock?.text === "😀", "audit truncation split a Unicode code point");
    assert(unicodeAuditBlock?.originalLength === 128 * 1024, "large audit character count should use Unicode code points");

    const auditCountBeforeMalformed = aliasRuntime.customEntries.length;
    const malformedSignatureMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "malformed signature stays visible", textSignature: "{" }],
    };
    const malformedResult = aliasRuntime.handlers.get("message_end")(
      { type: "message_end", message: malformedSignatureMessage },
      aliasRuntime.ctx,
    );
    assert(malformedResult === undefined, "malformed commentary signature should fail open");
    assert(aliasRuntime.customEntries.length === auditCountBeforeMalformed, "malformed signature created a hidden-text audit entry");
    const malformedComponent = new AssistantMessageComponent(malformedSignatureMessage, true);
    assert(
      malformedComponent.render(100).join("\n").includes("malformed signature stays visible"),
      "renderer hid text with a malformed signature",
    );

    const staleSummaryContext = {
      ...aliasRuntime.ctx,
      sessionManager: {
        ...aliasRuntime.ctx.sessionManager,
        getEntries() { throw new Error("Extension context no longer active"); },
      },
    };
    await aliasRuntime.shortcuts.get("alt+s").handler(staleSummaryContext);
    const aliasBatch = makeBatch("alias_batch", 5, ["read"]);
    aliasRuntime.setSessionMessages([aliasBatch.assistant, ...aliasBatch.results]);
    const aliasHarness = createInteractiveRendererHarness(
      InteractiveMode,
      aliasRuntime.ctx.sessionManager,
      aliasRuntime.ctx.ui,
      () => aliasRuntime.getSessionMessages(),
    );
    InteractiveMode.prototype.renderSessionItems.call(aliasHarness, aliasRuntime.getSessionMessages());
    const aliasRenderedAssistant = aliasHarness.chatContainer.children.find(
      (component) => component?.renderedMessage?.role === "assistant",
    )?.renderedMessage;
    const aliasMarker = aliasRenderedAssistant?.content.find(
      (block) => block.type === "text" && stripVTControlCharacters(block.text).startsWith("legacy "),
    )?.text ?? "";
    assert(aliasMarker.includes("已读取 1 个文件；0 个错误 (alt+x)"), "legacy marker alias was not normalized");
    await aliasRuntime.commands.get("codex-compact").handler("summary", aliasRuntime.ctx);
    assert(aliasRuntime.widgets.has("pi-codex-compact.hidden-summary"), "summary command did not open its widget");
    await aliasRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, aliasRuntime.ctx);
    assert(!aliasRuntime.widgets.has("pi-codex-compact.hidden-summary"), "session shutdown left the summary widget visible");
    assert(aliasRuntime.getToolsExpanded() === false, "session shutdown did not restore the prior tool expansion state");
    assert(!AssistantMessageComponent.prototype[renderPatchSymbol], "session shutdown left AssistantMessageComponent patched");
    assert(!ToolExecutionComponent.prototype[toolRenderPatchSymbol], "session shutdown left ToolExecutionComponent patched");
    assert(!InteractiveMode.prototype[interactivePatchSymbol], "session shutdown left InteractiveMode patched");

    InteractiveMode.prototype.renderSessionItems = realRenderSessionItems;
    InteractiveMode.prototype.handleEvent = realHandleEvent;
    InteractiveMode.prototype.createExtensionUIContext = realCreateExtensionUIContext;
    InteractiveMode.prototype.addExtensionTerminalInputListener = realAddExtensionTerminalInputListener;
    InteractiveMode.prototype.showExtensionNotify = realShowExtensionNotify;
    InteractiveMode.prototype[interactivePatchSymbol] = false;
    InteractiveMode.prototype[interactivePatchDataSymbol] = undefined;

    InteractiveMode.prototype.renderSessionItems = function recordingRenderSessionItems(items, options) {
      this.chatContainer.clear();
      this.assistantComponents.clear();
      this.renderedSourceItems = items;
      this.renderOptions = options;
      return realRenderSessionItems.call(this, items, options);
    };
    InteractiveMode.prototype.handleEvent = async function recordingHandleEvent(event) {
      this.handledEvents = [...(this.handledEvents ?? []), event.type];
    };

    const terminalFailureRuntime = createMockRuntime();
    terminalFailureRuntime.ctx.ui.onTerminalInput = () => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    };
    const terminalFailureExtension = await loadExtension();
    await terminalFailureExtension(terminalFailureRuntime.pi);
    await terminalFailureRuntime.handlers.get("session_start")({ type: "session_start" }, terminalFailureRuntime.ctx);
    assert(terminalFailureRuntime.statuses.some((status) => status.key === "codex-compact"), "stale terminal context should not abort startup");
    assert(terminalFailureRuntime.terminalInputListeners.length === 0, "failed terminal listener registration should not leak a listener");
    terminalFailureRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, terminalFailureRuntime.ctx);

    const runtime = createMockRuntime();
    const extension = await loadExtension();
    await extension(runtime.pi);
    const duplicateRuntime = createMockRuntime();
    const duplicateExtension = await loadExtension();
    await duplicateExtension(duplicateRuntime.pi);
    assert(duplicateRuntime.handlers.size === 0, "duplicate load registered event handlers");
    assert(duplicateRuntime.commands.size === 0, "duplicate load registered commands");
    assert(duplicateRuntime.shortcuts.size === 0, "duplicate load registered shortcuts");
    assert(runtime.handlers.has("turn_end"), "turn_end handler missing");
    assert(runtime.handlers.has("message_end"), "message_end handler missing");
    assert(runtime.shortcuts.has("alt+p"), "Alt+P shortcut missing");
    await runtime.handlers.get("session_start")({ type: "session_start" }, runtime.ctx);

    const patchData = InteractiveMode.prototype[interactivePatchDataSymbol];
    assert(patchData?.adapter === "component-state", "active adapter should be component-state");
    assert(patchData?.version === 13, "unexpected interactive patch version");
    await runtime.commands.get("codex-compact").handler("doctor", runtime.ctx);
    const doctor = runtime.notifications.at(-1)?.message ?? "";
    for (const expected of [
      "Completed tool-batch folding: enabled",
      "Fold unit: narrative-bounded activity segment",
      "Renderer patch version: 5",
      "Interactive adapter: component-state",
      "ToolExecutionComponent.render: found",
      "Tool renderer patch version: 1",
      "InteractiveMode.renderSessionItems: found",
      "InteractiveMode.renderSessionContext: missing (expected on supported Pi)",
      "InteractiveMode.showExtensionNotify: found",
      "InteractiveMode.rebuildChatFromMessages: found",
      "Tool-batch fold patch version: 13",
      "Tool-batch fold patch adapter: component-state",
      "Tool-batch fold patch check: compatible",
    ]) {
      assert(doctor.includes(expected), `doctor output missing: ${expected}`);
    }

    const streamingMessage = {
      role: "assistant",
      content: [textMessage("streaming commentary", "commentary"), textMessage("visible final", "final_answer")],
      stopReason: "stop",
    };
    const component = new AssistantMessageComponent(streamingMessage, true);
    const rendered = component.render(100).join("\n");
    assert(rendered.includes("streaming commentary"), "legacy commentary should remain visible by default");
    assert(rendered.includes("visible final"), "assistant renderer hid final text");

    const user = { role: "user", content: [{ type: "text", text: "run tools" }], timestamp: 1 };
    const first = makeBatch("batch_one", 10, ["read", "ffgrep", "bash", "edit", "custom_tool"], [2]);
    first.results[0].content[0].text = "x".repeat(256 * 1024);
    first.results[4].content.push({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
    const customBetween = { type: "custom", customType: "smoke-visible", data: { label: "keep me" }, id: "custom-visible" };
    const sessionMessages = [user, first.assistant];
    runtime.setSessionMessages(sessionMessages);
    const fakeInteractive = createInteractiveRendererHarness(
      InteractiveMode,
      runtime.ctx.sessionManager,
      runtime.ctx.ui,
      () => runtime.getSessionMessages(),
    );

    runtime.handlers.get("message_end")({ type: "message_end", message: first.assistant }, runtime.ctx);
    InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, sessionMessages);
    assert(toolCallCount(fakeInteractive.renderedItems) === 5, "active batch folded before results");
    assert(markerTexts(fakeInteractive.renderedItems).length === 0, "active batch gained an early marker");

    sessionMessages.push(customBetween, ...[first.results[1], first.results[0], ...first.results.slice(2)]);
    const contextBeforeFold = structuredClone(runtime.ctx.sessionManager.buildSessionContext().messages);
    InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, sessionMessages);
    assert(toolCallCount(fakeInteractive.renderedItems) === 5, "batch folded before turn_end after all results appeared");

    const rebuildBeforeToolEnds = fakeInteractive.rebuildCount;
    await InteractiveMode.prototype.handleEvent.call(fakeInteractive, { type: "tool_execution_end", toolCallId: first.calls[1].id });
    await InteractiveMode.prototype.handleEvent.call(fakeInteractive, { type: "tool_execution_end", toolCallId: first.calls[0].id });
    await InteractiveMode.prototype.handleEvent.call(fakeInteractive, {
      type: "agent_end",
      message: first.assistant,
      toolResults: first.results,
    });
    assert(fakeInteractive.rebuildCount === rebuildBeforeToolEnds, "non-turn_end event triggered a batch rebuild");

    InteractiveMode.prototype.showExtensionNotify.call(
      fakeInteractive,
      "RTK rewrite: tail -n 80 service.log -> rtk read service.log --tail=80",
      "info",
    );
    const rtkNoticeComponent = fakeInteractive.chatContainer.children.at(-1);
    assert(rtkNoticeComponent.render(100).join("\n").includes("RTK rewrite:"), "active RTK notice should remain visible before turn_end");

    const firstTurnEnd = { type: "turn_end", message: first.assistant, toolResults: first.results };
    const childrenBeforeTurnEnd = [...fakeInteractive.chatContainer.children];
    const clearCountBeforeTurnEnd = fakeInteractive.chatContainer.clearCount;
    const assistantBeforeTurnEnd = fakeInteractive.assistantComponents.get(first.assistant.responseId);
    const toolsBeforeTurnEnd = new Map(
      fakeInteractive.chatContainer.children
        .filter((child) => child?.toolCallId)
        .map((child) => [child.toolCallId, child]),
    );
    runtime.handlers.get("turn_end")(firstTurnEnd, runtime.ctx);
    await InteractiveMode.prototype.handleEvent.call(fakeInteractive, firstTurnEnd);
    assert(fakeInteractive.rebuildCount === rebuildBeforeToolEnds, "completed turn rebuilt the chat history");
    assert(fakeInteractive.chatContainer.clearCount === clearCountBeforeTurnEnd, "completed turn cleared the chat container");
    assert(
      childrenBeforeTurnEnd.every((child, index) => fakeInteractive.chatContainer.children[index] === child),
      "completed turn replaced or reordered existing chat components",
    );
    assert(
      fakeInteractive.assistantComponents.get(first.assistant.responseId) === assistantBeforeTurnEnd,
      "completed turn replaced the assistant component",
    );
    for (const [toolCallId, toolComponent] of toolsBeforeTurnEnd) {
      assert(
        fakeInteractive.chatContainer.children.includes(toolComponent),
        `completed turn replaced tool component ${toolCallId}`,
      );
      assert(toolComponent.render(100).length === 0, `folded tool component ${toolCallId} still rendered rows`);
    }
    assert(toolCallCount(fakeInteractive.renderedItems) === 0, "completed batch tool calls were not hidden");
    const firstMarker = markerTexts(fakeInteractive.renderedItems)[0] ?? "";
    for (const expected of ["已读取 1 个文件", "搜索 1 次", "运行 1 个命令", "修改 1 次", "调用 1 个其他工具", "1 个错误"]) {
      assert(firstMarker.includes(expected), `tool summary missing: ${expected}`);
    }
    assert(firstMarker.includes("后台通知 1 条"), "pending RTK notice was not merged into the completed activity marker");
    const firstMarkerBlock = fakeInteractive.renderedItems
      .flatMap((item) => item?.role === "assistant" ? item.content : [])
      .find(isMarkerBlock);
    assert(firstMarkerBlock?.text.startsWith("\x1b[2m"), "activity marker did not use the dim theme style");
    assert(rtkNoticeComponent.render(100).length === 0, "completed activity left its RTK notice visible");

    fakeInteractive.chatContainer.addChild({ render: () => ["status boundary"] });
    InteractiveMode.prototype.showExtensionNotify.call(
      fakeInteractive,
      "Observational memory: observer running on ~13,315-token chunk",
      "info",
    );
    const memoryNoticeComponent = fakeInteractive.chatContainer.children.at(-1);
    assert(memoryNoticeComponent !== rtkNoticeComponent, "notice fixture did not create a second Pi status component");
    assert(memoryNoticeComponent.render(100).length === 0, "post-turn observational-memory notice did not join the open activity segment");
    assert(
      markerTexts(fakeInteractive.renderedItems)[0]?.includes("后台通知 2 条"),
      "activity marker did not update after an asynchronous observational-memory notice",
    );
    InteractiveMode.prototype.showExtensionNotify.call(fakeInteractive, "Ordinary Pi status stays visible", "info");
    const ordinaryStatusComponent = fakeInteractive.chatContainer.children.at(-1);
    assert(ordinaryStatusComponent !== memoryNoticeComponent, "ordinary status overwrote a captured activity notice");
    assert(ordinaryStatusComponent.render(100).join("\n").includes("Ordinary Pi status"), "ordinary status was folded by prefix mistake");
    assert(fakeInteractive.renderedItems.includes(customBetween), "interleaved custom item moved or disappeared");
    assert(fakeInteractive.renderedItems.filter((item) => item.role === "toolResult").length === 5, "virtual render removed persisted result items");
    assert(fakeInteractive.renderedItems.includes(first.results[0]), "folding cloned or rewrote a large tool result");

    const foldedAssistant = fakeInteractive.renderedItems.find((item) => item.responseId === first.assistant.responseId);
    const preservedBlocks = foldedAssistant.content.filter((block) => !isMarkerBlock(block));
    const originalNarrativeBlocks = first.assistant.content.filter((block) => block.type !== "toolCall" && block.type !== "thinking");
    assertDeepEqual(preservedBlocks, originalNarrativeBlocks, "folding changed narrative blocks or metadata");
    assert(thinkingBlockCount(fakeInteractive.renderedItems) === 0, "collapsed activity left a Thinking hidden source block");
    assertDeepEqual(runtime.ctx.sessionManager.buildSessionContext().messages, contextBeforeFold, "rendering changed mock LLM context");

    await runtime.shortcuts.get("alt+p").handler(runtime.ctx);
    assert(toolCallCount(fakeInteractive.renderedItems) === 5, "Alt+P did not restore calls");
    assert(thinkingBlockCount(fakeInteractive.renderedItems) === 1, "Alt+P did not restore thinking");
    assert(fakeInteractive.rebuildCount === rebuildBeforeToolEnds, "Alt+P rebuilt the chat history");
    assert(fakeInteractive.chatContainer.clearCount === clearCountBeforeTurnEnd, "Alt+P cleared the chat container");
    assert(
      fakeInteractive.assistantComponents.get(first.assistant.responseId) === assistantBeforeTurnEnd,
      "Alt+P replaced the assistant component",
    );
    for (const [toolCallId, toolComponent] of toolsBeforeTurnEnd) {
      assert(toolComponent.render(100).length > 0, `Alt+P did not restore tool component ${toolCallId}`);
    }
    assert(rtkNoticeComponent.render(100).join("\n").includes("RTK rewrite:"), "Alt+P did not restore RTK notice text");
    assert(memoryNoticeComponent.render(100).join("\n").includes("Observational memory:"), "Alt+P did not restore observational-memory notice text");
    assert(JSON.stringify(fakeInteractive.renderedItems).includes("batch_one result 2"), "Alt+P did not restore error details");
    assert(JSON.stringify(fakeInteractive.renderedItems).includes("aW1hZ2U="), "Alt+P did not restore image output");
    const restoredErrorRow = fakeInteractive.chatContainer.children.find(
      (component) => component?.toolCallId === first.calls[2].id && component?.result?.isError === true,
    );
    assert(restoredErrorRow, "real Pi renderer did not hydrate the restored error result row");
    await runtime.commands.get("codex-compact").handler("toggle", runtime.ctx);
    assert(toolCallCount(fakeInteractive.renderedItems) === 0, "toggle command did not re-fold latest batch");
    assert(rtkNoticeComponent.render(100).length === 0, "toggle command did not re-fold RTK notice");
    assert(memoryNoticeComponent.render(100).length === 0, "toggle command did not re-fold observational-memory notice");
    assert(runtime.notifications.some((entry) => entry.message.includes("工具活动已展开")), "toggle did not report expanded state");

    const rawResult = runtime.terminalInputListeners[0]("\x1bp");
    assert(rawResult?.consume === true, "raw Alt+P was not consumed");
    assert(toolCallCount(fakeInteractive.renderedItems) === 5, "raw Alt+P did not expand latest batch");
    const bareResult = runtime.handlers.get("input")({ type: "input", text: "compact fold" }, runtime.ctx);
    assert(bareResult?.action === "handled", "bare fallback input was not handled");
    assert(toolCallCount(fakeInteractive.renderedItems) === 0, "bare fallback did not re-fold latest batch");

    const second = makeBatch("batch_two", 30, ["read", "bash"]);
    sessionMessages.push(second.assistant);
    runtime.handlers.get("message_end")({ type: "message_end", message: second.assistant }, runtime.ctx);
    InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, sessionMessages);
    assert(markerTexts(fakeInteractive.renderedItems).length === 1, "first batch should stay folded while second is active");
    assert(toolCallCount(fakeInteractive.renderedItems) === 2, "active second batch should stay expanded");
    sessionMessages.push(...second.results);
    const secondTurnEnd = { type: "turn_end", message: second.assistant, toolResults: [...second.results].reverse() };
    runtime.handlers.get("turn_end")(secondTurnEnd, runtime.ctx);
    await InteractiveMode.prototype.handleEvent.call(fakeInteractive, secondTurnEnd);
    assert(markerTexts(fakeInteractive.renderedItems).length === 2, "both completed batches should fold independently");
    assert(toolCallCount(fakeInteractive.renderedItems) === 0, "second completed batch did not fold");

    const finalAssistant = {
      role: "assistant",
      responseId: "final_response",
      timestamp: 50,
      stopReason: "stop",
      content: [textMessage("FINAL ANSWER STAYS", "final_answer", "final-signature")],
    };
    sessionMessages.push(finalAssistant);
    InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, sessionMessages);
    assert(fakeInteractive.renderedItems.at(-1) === finalAssistant, "later final assistant response should pass through unchanged");

    const segmentFirst = makeBatch("segment_first", 90, ["read"]);
    segmentFirst.assistant.content = [
      { type: "thinking", thinking: "segment first thinking", thinkingSignature: "segment-first-thinking" },
      textMessage("我先核对当前实际配置位置。", "commentary", "segment-description"),
      ...segmentFirst.calls,
    ];
    const segmentSecond = makeBatch("segment_second", 100, ["bash", "edit"], [1]);
    segmentSecond.assistant.content = [
      { type: "thinking", thinking: "segment second thinking", thinkingSignature: "segment-second-thinking" },
      ...segmentSecond.calls,
    ];
    const segmentTrailingThinking = {
      role: "assistant",
      responseId: "segment_trailing_thinking",
      timestamp: 110,
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "trailing thinking", thinkingSignature: "segment-trailing-thinking" }],
    };
    const segmentFinal = {
      role: "assistant",
      responseId: "segment_final",
      timestamp: 120,
      stopReason: "stop",
      content: [textMessage("SEGMENT FINAL ANSWER", "final_answer", "segment-final")],
    };

    const liveMergeItems = [segmentFirst.assistant, ...segmentFirst.results];
    const liveMergeInteractive = createInteractiveRendererHarness(
      InteractiveMode,
      runtime.ctx.sessionManager,
      runtime.ctx.ui,
      () => liveMergeItems,
    );
    InteractiveMode.prototype.renderSessionItems.call(liveMergeInteractive, liveMergeItems);
    const liveMarkerComponent = liveMergeInteractive.assistantComponents.get(segmentFirst.assistant.responseId);
    const liveMarkerBefore = liveMarkerComponent?.lastMessage?.content.find(
      isMarkerBlock,
    )?.text ?? "";
    const livePrefix = [...liveMergeInteractive.chatContainer.children];
    const liveClearCount = liveMergeInteractive.chatContainer.clearCount;

    const liveSecondAssistant = new AssistantMessageComponent(segmentSecond.assistant, true);
    liveMergeInteractive.assistantComponents.set(segmentSecond.assistant.responseId, liveSecondAssistant);
    liveMergeInteractive.chatContainer.addChild(liveSecondAssistant);
    const liveSecondTools = [];
    for (const [index, call] of segmentSecond.calls.entries()) {
      const toolComponent = new ToolExecutionComponent(
        call.name,
        call.id,
        call.arguments,
        { showImages: false, imageWidthCells: 60 },
        undefined,
        runtime.ctx.ui,
        process.cwd(),
      );
      toolComponent.updateResult(segmentSecond.results[index]);
      liveMergeInteractive.chatContainer.addChild(toolComponent);
      liveSecondTools.push(toolComponent);
    }
    runtime.handlers.get("message_end")({ type: "message_end", message: segmentSecond.assistant }, runtime.ctx);
    const liveSecondTurnEnd = { type: "turn_end", message: segmentSecond.assistant, toolResults: segmentSecond.results };
    runtime.handlers.get("turn_end")(liveSecondTurnEnd, runtime.ctx);
    await InteractiveMode.prototype.handleEvent.call(liveMergeInteractive, liveSecondTurnEnd);

    const liveMarkerAfter = liveMarkerComponent?.lastMessage?.content.find(
      isMarkerBlock,
    )?.text ?? "";
    assert(liveMarkerBefore !== liveMarkerAfter, "consecutive live batch did not update the existing marker");
    assert(liveMarkerAfter.includes("修改 1 次") && liveMarkerAfter.includes("1 个错误"), "live marker did not aggregate the appended batch");
    assert(liveMergeInteractive.assistantComponents.get(segmentFirst.assistant.responseId) === liveMarkerComponent, "live merge replaced the marker component");
    assert(liveMergeInteractive.chatContainer.clearCount === liveClearCount, "live merge cleared the chat container");
    assert(liveMergeInteractive.rebuildCount === 0, "live merge rebuilt chat history");
    assert(livePrefix.every((child, index) => liveMergeInteractive.chatContainer.children[index] === child), "live merge replaced the existing chat prefix");
    assert(liveSecondTools.every((component) => component.render(100).length === 0), "live merge left appended tool components visible");

    const segmentItems = [user, segmentFirst.assistant];
    const segmentInteractive = createInteractiveRendererHarness(
      InteractiveMode,
      runtime.ctx.sessionManager,
      runtime.ctx.ui,
      () => segmentItems,
    );

    runtime.handlers.get("message_end")({ type: "message_end", message: segmentFirst.assistant }, runtime.ctx);
    InteractiveMode.prototype.renderSessionItems.call(segmentInteractive, segmentItems);
    assert(markerTexts(segmentInteractive.renderedItems).length === 0, "active narrative batch received an activity marker");
    assert(toolCallCount(segmentInteractive.renderedItems) === 1, "active narrative batch did not remain expanded");
    segmentItems.push(...segmentFirst.results);
    const segmentFirstTurnEnd = { type: "turn_end", message: segmentFirst.assistant, toolResults: segmentFirst.results };
    runtime.handlers.get("turn_end")(segmentFirstTurnEnd, runtime.ctx);
    await InteractiveMode.prototype.handleEvent.call(segmentInteractive, segmentFirstTurnEnd);
    assert(markerTexts(segmentInteractive.renderedItems).length === 1, "first completed activity batch did not fold at turn_end");

    segmentItems.push(segmentSecond.assistant);
    runtime.handlers.get("message_end")({ type: "message_end", message: segmentSecond.assistant }, runtime.ctx);
    InteractiveMode.prototype.renderSessionItems.call(segmentInteractive, segmentItems);
    assert(markerTexts(segmentInteractive.renderedItems).length === 1, "prior activity segment did not stay folded while the next batch was active");
    assert(toolCallCount(segmentInteractive.renderedItems) === 2, "active non-narrative batch did not remain expanded");
    assert(thinkingBlockCount(segmentInteractive.renderedItems) === 1, "active non-narrative thinking should remain visible");
    segmentItems.push(...segmentSecond.results);
    const segmentSecondTurnEnd = { type: "turn_end", message: segmentSecond.assistant, toolResults: segmentSecond.results };
    runtime.handlers.get("turn_end")(segmentSecondTurnEnd, runtime.ctx);
    await InteractiveMode.prototype.handleEvent.call(segmentInteractive, segmentSecondTurnEnd);
    assert(segmentInteractive.rebuildCount === 0, "completed activity batches rebuilt the chat history");

    segmentItems.push(segmentTrailingThinking, segmentFinal);
    const segmentItemsBeforeRender = structuredClone(segmentItems);
    InteractiveMode.prototype.renderSessionItems.call(segmentInteractive, segmentItems);
    assert(markerTexts(segmentInteractive.renderedItems).length === 1, "consecutive non-narrative batches did not merge into one activity marker");
    assert(toolCallCount(segmentInteractive.renderedItems) === 0, "collapsed activity segment left tool calls visible");
    assert(thinkingBlockCount(segmentInteractive.renderedItems) === 0, "collapsed activity segment left Thinking hidden source blocks");
    const segmentChatMessages = segmentInteractive.chatContainer.children
      .map((child) => child?.renderedMessage)
      .filter(Boolean);
    assert(
      segmentChatMessages.every((message) => !message.content?.some((block) => block.type === "thinking")),
      "real Pi renderer received a Thinking hidden source block for a collapsed activity segment",
    );
    assert(
      segmentChatMessages.some((message) => message.content?.some((block) => block.text === "我先核对当前实际配置位置。")),
      "real Pi renderer did not receive the narrative description",
    );
    const segmentMarker = markerTexts(segmentInteractive.renderedItems)[0] ?? "";
    for (const expected of ["已读取 1 个文件", "运行 1 个命令", "修改 1 次", "1 个错误"]) {
      assert(segmentMarker.includes(expected), `activity segment summary missing: ${expected}`);
    }
    const segmentNarrative = segmentInteractive.renderedItems.flatMap((item) => item?.role === "assistant"
      ? item.content.filter((block) => block.type === "text" && !isMarkerBlock(block))
      : []);
    assertDeepEqual(
      segmentNarrative,
      [segmentFirst.assistant.content[1], segmentFinal.content[0]],
      "activity segment folding changed description/final text or signature metadata",
    );
    await runtime.shortcuts.get("alt+p").handler(runtime.ctx);
    assert(toolCallCount(segmentInteractive.renderedItems) === 3, "Alt+P did not restore the whole activity segment");
    assert(thinkingBlockCount(segmentInteractive.renderedItems) === 3, "Alt+P did not restore all activity thinking blocks");
    await runtime.commands.get("codex-compact").handler("toggle", runtime.ctx);
    assert(markerTexts(segmentInteractive.renderedItems).length === 1, "toggle did not re-fold the merged activity segment");
    assertDeepEqual(segmentItems, segmentItemsBeforeRender, "activity segment render/toggle mutated original messages or thinking");

    const goalStateAfterAssistant = {
      type: "custom",
      customType: "pi-goal-state",
      data: { status: "active" },
      id: "goal-state-after-assistant",
    };
    const observationsAfterResult = {
      type: "custom",
      customType: "om.observations.recorded",
      data: { count: 1 },
      id: "observations-after-result",
    };
    const customInterleavedItems = [
      user,
      segmentFirst.assistant,
      goalStateAfterAssistant,
      ...segmentFirst.results,
      observationsAfterResult,
      segmentSecond.assistant,
      ...segmentSecond.results,
      segmentFinal,
    ];
    InteractiveMode.prototype.renderSessionItems.call(segmentInteractive, customInterleavedItems);
    assert(markerTexts(segmentInteractive.renderedItems).length === 1, "custom metadata split one continuous activity segment");
    for (const customEntry of [goalStateAfterAssistant, observationsAfterResult]) {
      assert(segmentInteractive.renderedItems.includes(customEntry), `${customEntry.customType} disappeared from render items`);
      assert(
        segmentInteractive.renderedItems.indexOf(customEntry) === customInterleavedItems.indexOf(customEntry),
        `${customEntry.customType} moved within the render stream`,
      );
    }

    const compactionBoundary = {
      role: "compactionSummary",
      summary: "Earlier activity was compacted.",
      timestamp: 125,
    };
    const compactionBoundaryItems = [
      user,
      segmentFirst.assistant,
      ...segmentFirst.results,
      compactionBoundary,
      segmentSecond.assistant,
      ...segmentSecond.results,
      segmentFinal,
    ];
    segmentInteractive.toolOutputExpanded = true;
    InteractiveMode.prototype.renderSessionItems.call(segmentInteractive, compactionBoundaryItems);
    assert(markerTexts(segmentInteractive.renderedItems).length === 2, "compaction summary did not split adjacent activity segments");
    assert(segmentInteractive.renderedItems.includes(compactionBoundary), "compaction boundary disappeared from render items");
    const compactionComponent = segmentInteractive.chatContainer.children.find(
      (component) => component?.message === compactionBoundary,
    );
    assert(compactionComponent?.expanded === false, "compaction summary inherited expanded tool-output state");
    segmentInteractive.toolOutputExpanded = false;

    const boundaryFirst = makeBatch("boundary_first", 130, ["read"]);
    boundaryFirst.assistant.content = [
      { type: "thinking", thinking: "boundary first thinking", thinkingSignature: "boundary-first-thinking" },
      ...boundaryFirst.calls,
    ];
    const boundaryIncomplete = makeBatch("boundary_incomplete", 140, ["bash", "edit"]);
    boundaryIncomplete.assistant.content = [
      { type: "thinking", thinking: "boundary incomplete thinking", thinkingSignature: "boundary-incomplete-thinking" },
      ...boundaryIncomplete.calls,
    ];
    const boundaryLast = makeBatch("boundary_last", 150, ["ffgrep"]);
    boundaryLast.assistant.content = [
      { type: "thinking", thinking: "boundary last thinking", thinkingSignature: "boundary-last-thinking" },
      ...boundaryLast.calls,
    ];
    const failOpenBoundaryItems = [
      user,
      boundaryFirst.assistant,
      ...boundaryFirst.results,
      boundaryIncomplete.assistant,
      boundaryIncomplete.results[0],
      boundaryLast.assistant,
      ...boundaryLast.results,
      segmentFinal,
    ];
    InteractiveMode.prototype.renderSessionItems.call(segmentInteractive, failOpenBoundaryItems);
    assert(markerTexts(segmentInteractive.renderedItems).length === 2, "incomplete batch did not split adjacent complete activity segments");
    assert(toolCallCount(segmentInteractive.renderedItems) === 2, "incomplete boundary batch did not fail open");
    assert(thinkingBlockCount(segmentInteractive.renderedItems) === 1, "incomplete boundary thinking should remain visible");

    const incomplete = makeBatch("incomplete", 60, ["read", "bash"]);
    const duplicate = makeBatch("duplicate", 70, ["read", "bash"]);
    duplicate.assistant.content.filter((block) => block.type === "toolCall")[1].id = duplicate.calls[0].id;
    const orphan = makeBatch("orphan", 80, ["read"]);
    const orphanResult = { role: "toolResult", toolCallId: "unknown_call", content: [{ type: "text", text: "orphan" }], isError: false };
    const malformedItems = [
      incomplete.assistant,
      incomplete.results[0],
      { role: "assistant", content: [{ type: "text", text: "boundary" }], timestamp: 69, stopReason: "stop" },
      duplicate.assistant,
      ...duplicate.results,
      { role: "assistant", content: [{ type: "text", text: "boundary 2" }], timestamp: 79, stopReason: "stop" },
      orphan.assistant,
      orphan.results[0],
      orphanResult,
    ];
    InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, malformedItems);
    assert(toolCallCount(fakeInteractive.renderedItems) === 5, "incomplete/duplicate/orphan batches must fail open");
    assert(markerTexts(fakeInteractive.renderedItems).length === 0, "malformed batch received a fold marker");

    const collidingKeyA = makeBatch("reused_response", 90, ["read"]);
    const collidingKeyB = makeBatch("reused_response", 100, ["bash"]);
    const collidingKeyItems = [
      collidingKeyA.assistant,
      ...collidingKeyA.results,
      collidingKeyB.assistant,
      ...collidingKeyB.results,
    ];
    InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, collidingKeyItems);
    assert(toolCallCount(fakeInteractive.renderedItems) === 2, "duplicate batch keys must fail open");
    assert(markerTexts(fakeInteractive.renderedItems).length === 0, "duplicate batch keys received fold markers");

    for (const [index, stopReason] of ["length", "stop", "error", "aborted"].entries()) {
      const wrongStopReason = makeBatch(`wrong_stop_reason_${stopReason}`, 110 + index, ["read"]);
      wrongStopReason.assistant.stopReason = stopReason;
      InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, [wrongStopReason.assistant, ...wrongStopReason.results]);
      assert(toolCallCount(fakeInteractive.renderedItems) === 1, `${stopReason} assistant message must fail open`);
      assert(markerTexts(fakeInteractive.renderedItems).length === 0, `${stopReason} assistant message received a fold marker`);
    }

    for (const toolName of ["subagent", "trellis_subagent"]) {
      const subagentBatch = makeBatch(`${toolName}_batch`, 120, ["read", toolName]);
      InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, [subagentBatch.assistant, ...subagentBatch.results]);
      assert(toolCallCount(fakeInteractive.renderedItems) === 2, `${toolName} batch was folded`);
      assert(thinkingBlockCount(fakeInteractive.renderedItems) === 1, `${toolName} thinking was folded`);
      assert(markerTexts(fakeInteractive.renderedItems).length === 0, `${toolName} batch received a fold marker`);
    }

    const customCountBeforeAgentEnd = runtime.customEntries.length;
    assert(!runtime.handlers.has("agent_end"), "agent_end should not drive whole-process folding");
    assert(runtime.customEntries.length === customCountBeforeAgentEnd, "whole-process metadata should not be created");

    await runtime.commands.get("codex-compact").handler("audit", runtime.ctx);
    assert(runtime.notifications.at(-1)?.message.includes("No hidden commentary audit entries"), "legacy commentary audit should remain available");
    const fallbackLogs = [];
    const fallbackWarnings = [];
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    console.log = (...args) => fallbackLogs.push(args.join(" "));
    console.warn = (...args) => fallbackWarnings.push(args.join(" "));
    try {
      await runtime.commands.get("codex-compact").handler(undefined, {
        ...runtime.ctx,
        ui: { ...runtime.ctx.ui, notify() { throw new Error("notify failed"); } },
      });
    } finally {
      console.log = originalConsoleLog;
      console.warn = originalConsoleWarn;
    }
    assert(fallbackLogs.some((line) => line.includes("Codex compact:")), "show command should survive stale notify context");
    assert(fallbackWarnings.some((line) => line.includes("notify UI call failed")), "unexpected UI failures should remain diagnosable");

    InteractiveMode.prototype.renderSessionItems.call(fakeInteractive, [first.assistant, ...first.results]);
    const lifecycleAssistant = fakeInteractive.assistantComponents.get(first.assistant.responseId);
    const lifecycleTool = fakeInteractive.chatContainer.children.find(
      (child) => child?.toolCallId === first.calls[0].id,
    );
    assert(markerTexts(fakeInteractive.renderedItems).length === 1, "lifecycle fixture did not start folded");
    assert(lifecycleTool?.render(100).length === 0, "lifecycle fixture tool did not start hidden");
    InteractiveMode.prototype.showExtensionNotify.call(
      fakeInteractive,
      "Observational memory: 1 observation recorded",
      "info",
    );
    const lifecycleNotice = fakeInteractive.chatContainer.children.at(-1);
    assert(lifecycleNotice.render(100).length === 0, "lifecycle fixture notice did not start hidden");

    await runtime.commands.get("codex-compact").handler("off", runtime.ctx);
    assert(!AssistantMessageComponent.prototype[renderPatchSymbol], "off command left AssistantMessageComponent patched");
    assert(!ToolExecutionComponent.prototype[toolRenderPatchSymbol], "off command left ToolExecutionComponent patched");
    assert(!InteractiveMode.prototype[interactivePatchSymbol], "off command left InteractiveMode patched");
    assert(lifecycleAssistant?.lastMessage === first.assistant, "off command left a virtual marker in the assistant component");
    assert(lifecycleTool?.render(100).length > 0, "off command left a tool component hidden");
    assert(lifecycleNotice.render(100).join("\n").includes("Observational memory:"), "off command left a notification component hidden");
    assert(runtime.terminalInputListeners.length === 0, "off command left a raw terminal listener");
    assert(runtime.getToolsExpanded() === false, "off command did not restore tool expansion state");
    await runtime.shortcuts.get("alt+p").handler(runtime.ctx);
    assert(runtime.notifications.at(-1)?.message === "工具活动折叠当前未启用。", "disabled shortcut should report that folding is inactive");
    await runtime.commands.get("codex-compact").handler("on", runtime.ctx);
    assert(AssistantMessageComponent.prototype[renderPatchSymbol], "on command did not restore AssistantMessageComponent patch");
    assert(ToolExecutionComponent.prototype[toolRenderPatchSymbol], "on command did not restore ToolExecutionComponent patch");
    assert(InteractiveMode.prototype[interactivePatchSymbol], "on command did not restore InteractiveMode patch");
    assert(runtime.terminalInputListeners.length === 1, "on command registered duplicate raw terminal listeners");
    assert(runtime.getToolsExpanded() === true, "on command did not reapply tool expansion state");
    const rendererBeforePiReload = InteractiveMode.prototype.renderSessionItems;

    runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, runtime.ctx);
    assert(runtime.terminalInputListeners.length === 0, "session shutdown should remove raw terminal listener");
    assert(!AssistantMessageComponent.prototype[renderPatchSymbol], "session shutdown did not unpatch AssistantMessageComponent");
    assert(!ToolExecutionComponent.prototype[toolRenderPatchSymbol], "session shutdown did not unpatch ToolExecutionComponent");
    assert(!InteractiveMode.prototype[interactivePatchSymbol], "session shutdown did not unpatch InteractiveMode");

    const contextFailureRuntime = createMockRuntime();
    const contextFailureExtension = await loadExtension();
    await contextFailureExtension(contextFailureRuntime.pi);
    const throwingContext = {
      ...contextFailureRuntime.ctx,
      sessionManager: {
        getEntries() { throw new Error("Extension context no longer active"); },
        buildSessionContext() { throw new Error("Extension context no longer active"); },
      },
    };
    await contextFailureRuntime.handlers.get("session_start")({ type: "session_start" }, throwingContext);
    await contextFailureRuntime.commands.get("codex-compact").handler("toggle", throwingContext);
    contextFailureRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, throwingContext);

    const reloadRuntime = createMockRuntime();
    reloadRuntime.setSessionMessages([user, first.assistant, ...first.results]);
    const contextBeforeReload = structuredClone(reloadRuntime.ctx.sessionManager.buildSessionContext().messages);
    const reloadExtension = await loadExtension();
    await reloadExtension(reloadRuntime.pi);
    await reloadRuntime.handlers.get("session_start")({ type: "session_start" }, reloadRuntime.ctx);
    assert(InteractiveMode.prototype[interactivePatchDataSymbol]?.adapter === "component-state", "reload kept a stale adapter closure");
    assert(InteractiveMode.prototype.renderSessionItems !== rendererBeforePiReload, "Pi reload reused the stale interactive closure");
    const patchBeforeConfigReload = InteractiveMode.prototype.renderSessionItems;
    await reloadRuntime.commands.get("codex-compact").handler("reload", reloadRuntime.ctx);
    assert(InteractiveMode.prototype.renderSessionItems === patchBeforeConfigReload, "config reload replaced an already-current patch");
    assert(reloadRuntime.terminalInputListeners.length === 1, "config reload registered duplicate raw terminal listeners");
    assertDeepEqual(reloadRuntime.ctx.sessionManager.buildSessionContext().messages, contextBeforeReload, "config reload changed LLM context");
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-codex-compact-session-"));
    const sessionManager = new SessionManager(process.cwd(), sessionDir, undefined, true, { id: "batch-fold-smoke" });
    const userEntryId = sessionManager.appendMessage(user);
    const assistantEntryId = sessionManager.appendMessage(first.assistant);
    for (const result of first.results) sessionManager.appendMessage(result);
    sessionManager.appendCustomEntry("smoke-visible", { label: "keep me" });
    const fullBatchLeafId = sessionManager.getLeafId();
    const buildRenderItems = () => sessionManager.buildContextEntries().flatMap((entry) => (
      entry.type === "custom" ? [entry] : sessionEntryToContextMessages(entry)
    ));
    const contextBeforeRealRender = structuredClone(sessionManager.buildSessionContext().messages);
    const realRenderHarness = createInteractiveRendererHarness(
      InteractiveMode,
      sessionManager,
      runtime.ctx.ui,
      buildRenderItems,
    );
    InteractiveMode.prototype.renderSessionItems.call(realRenderHarness, buildRenderItems());
    assert(markerTexts(realRenderHarness.renderedItems).length === 1, "real compaction-aware item shape did not fold");
    assert(realRenderHarness.renderedItems.some((item) => item?.type === "custom"), "real custom entry disappeared from render items");
    assertDeepEqual(sessionManager.buildSessionContext().messages, contextBeforeRealRender, "render adapter changed SessionManager context");

    sessionManager.branch(assistantEntryId);
    InteractiveMode.prototype.renderSessionItems.call(realRenderHarness, buildRenderItems());
    assert(toolCallCount(realRenderHarness.renderedItems) === 5, "branch with missing results should fail open");
    assert(markerTexts(realRenderHarness.renderedItems).length === 0, "incomplete selected branch received a marker");

    sessionManager.branch(fullBatchLeafId);
    sessionManager.appendCompaction("compacted history", userEntryId, 1000);
    const contextBeforeCompactedRender = structuredClone(sessionManager.buildSessionContext().messages);
    InteractiveMode.prototype.renderSessionItems.call(realRenderHarness, buildRenderItems());
    assert(realRenderHarness.renderedItems[0]?.role === "compactionSummary", "compaction-aware projection was not used");
    assert(markerTexts(realRenderHarness.renderedItems).length === 1, "kept batch did not fold after compaction");
    assertDeepEqual(sessionManager.buildSessionContext().messages, contextBeforeCompactedRender, "compacted render changed LLM context");
    const sessionJsonl = readFileSync(sessionManager.getSessionFile(), "utf8");
    assert(!sessionJsonl.includes("⌕ 已读取"), "virtual tool marker leaked into session JSONL");
    assert(!JSON.stringify(sessionManager.buildSessionContext().messages).includes("⌕ 已读取"), "virtual tool marker leaked into LLM context");
    reloadRuntime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, reloadRuntime.ctx);
  } finally {
    AssistantMessageComponent.prototype.updateContent = realUpdateContent;
    AssistantMessageComponent.prototype[renderPatchSymbol] = false;
    AssistantMessageComponent.prototype[renderPatchDataSymbol] = undefined;
    ToolExecutionComponent.prototype.render = realToolRender;
    ToolExecutionComponent.prototype[toolRenderPatchSymbol] = false;
    ToolExecutionComponent.prototype[toolRenderPatchDataSymbol] = undefined;
    InteractiveMode.prototype.renderSessionItems = realRenderSessionItems;
    InteractiveMode.prototype.handleEvent = realHandleEvent;
    InteractiveMode.prototype.createExtensionUIContext = realCreateExtensionUIContext;
    InteractiveMode.prototype.addExtensionTerminalInputListener = realAddExtensionTerminalInputListener;
    InteractiveMode.prototype.showExtensionNotify = realShowExtensionNotify;
    InteractiveMode.prototype.rebuildChatFromMessages = realRebuildChatFromMessages;
    InteractiveMode.prototype[interactivePatchSymbol] = false;
    InteractiveMode.prototype[interactivePatchDataSymbol] = undefined;
  }

  console.log("pi-codex-compact smoke test passed");
}

await main();
