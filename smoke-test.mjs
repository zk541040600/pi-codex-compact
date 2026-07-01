import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(__dirname, "index.cjs");
const configPath = join(__dirname, "config.json");
const settingsPath = "/root/.pi/agent/settings.json";
const piPackageRoot = "/root/node-v22.22.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent";
const assistantMessagePath = join(piPackageRoot, "dist/modes/interactive/components/assistant-message.js");
const interactiveModePath = join(piPackageRoot, "dist/modes/interactive/interactive-mode.js");
const sessionManagerPath = join(piPackageRoot, "dist/core/session-manager.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
        if (index >= 0) {
          terminalInputListeners.splice(index, 1);
        }
      };
    },
    setHiddenThinkingLabel(value) {
      calls.push(["setHiddenThinkingLabel", value]);
    },
    setToolsExpanded(value) {
      calls.push(["setToolsExpanded", value]);
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
      if (content === undefined) {
        widgets.delete(key);
      } else {
        widgets.set(key, { content, options });
      }
    },
    theme: {
      fg(_style, text) {
        return text;
      },
    },
  };

  const ctx = {
    ui,
    sessionManager: {
      getEntries: () => customEntries,
      buildSessionContext: () => ({ messages: sessionMessages, thinkingLevel: "off", model: null }),
      getSessionId: () => "smoke-session",
      getLeafId: () => "leaf-smoke",
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

function contextText(context) {
  return JSON.stringify(context.messages);
}

async function main() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert(config.stripCommentaryText === false, "default config should not strip commentary while streaming");
  assert(config.foldCompletedTurnProcess === true, "default config should fold completed turn process");
  assert(config.foldUnsignedFinalSections === true, "default config should enable strict final-section fallback");
  assert(config.deriveFoldGroupsOnRender === false, "default config should not retroactively derive fold groups while rendering");
  assert(config.turnProcessFoldShortcut === "alt+p", "default process fold shortcut should be alt+p");
  assert(config.collapseToolOutput === false, "default config should leave tools expanded while processing");

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert(
    settings.extensions?.includes("./extensions/pi-codex-compact/index.cjs"),
    "settings.json does not register pi-codex-compact cache-busting loader",
  );

  const extension = await import(`${pathToFileURL(extensionPath).href}?smoke=${Date.now()}`);
  const { AssistantMessageComponent } = await import(pathToFileURL(assistantMessagePath).href);
  const { InteractiveMode } = await import(pathToFileURL(interactiveModePath).href);
  const { SessionManager } = await import(pathToFileURL(sessionManagerPath).href);

  const renderPatchSymbol = Symbol.for("pi-codex-compact.assistant-renderer-patched");
  const renderPatchDataSymbol = Symbol.for("pi-codex-compact.assistant-renderer-patch-data");
  const interactivePatchSymbol = Symbol.for("pi-codex-compact.interactive-render-patched");
  const interactivePatchDataSymbol = Symbol.for("pi-codex-compact.interactive-render-patch-data");

  const originalUpdateContent = AssistantMessageComponent.prototype[renderPatchDataSymbol]?.originalUpdateContent
    ?? AssistantMessageComponent.prototype.updateContent;
  AssistantMessageComponent.prototype.updateContent = originalUpdateContent;
  AssistantMessageComponent.prototype[renderPatchSymbol] = false;
  AssistantMessageComponent.prototype[renderPatchDataSymbol] = undefined;

  const realRenderSessionContext = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalRenderSessionContext
    ?? InteractiveMode.prototype.renderSessionContext;
  const realHandleEvent = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalHandleEvent
    ?? InteractiveMode.prototype.handleEvent;
  const realCreateExtensionUIContext = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalCreateExtensionUIContext
    ?? InteractiveMode.prototype.createExtensionUIContext;
  const realAddExtensionTerminalInputListener = InteractiveMode.prototype[interactivePatchDataSymbol]?.originalAddExtensionTerminalInputListener
    ?? InteractiveMode.prototype.addExtensionTerminalInputListener;

  InteractiveMode.prototype.createExtensionUIContext = undefined;
  const incompatibleRuntime = createMockRuntime();
  await extension.default(incompatibleRuntime.pi);
  await incompatibleRuntime.handlers.get("session_start")({ type: "session_start" }, incompatibleRuntime.ctx);
  assert(
    incompatibleRuntime.statuses.some((status) => status.key === "codex-compact-fold" && String(status.text).includes("incompatible")),
    "missing InteractiveMode helper should mark fold patch incompatible instead of throwing",
  );
  InteractiveMode.prototype.createExtensionUIContext = realCreateExtensionUIContext;
  InteractiveMode.prototype.addExtensionTerminalInputListener = realAddExtensionTerminalInputListener;

  InteractiveMode.prototype.renderSessionContext = function fakeRenderSessionContext(sessionContext) {
    this.renderedContext = sessionContext;
  };
  InteractiveMode.prototype.handleEvent = async function fakeHandleEvent(event) {
    this.handledEvents = [...(this.handledEvents ?? []), event.type];
  };
  InteractiveMode.prototype[interactivePatchSymbol] = false;
  InteractiveMode.prototype[interactivePatchDataSymbol] = undefined;

  const runtime = createMockRuntime();
  await extension.default(runtime.pi);

  assert(runtime.handlers.has("session_start"), "session_start handler missing");
  assert(runtime.handlers.has("agent_end"), "agent_end handler missing");
  assert(runtime.handlers.has("message_end"), "message_end handler missing");
  assert(runtime.commands.has("codex-compact"), "codex-compact command missing");
  assert(runtime.shortcuts.has("alt+p"), "turn process fold shortcut missing");

  await runtime.handlers.get("session_start")({ type: "session_start" }, runtime.ctx);
  assert(
    runtime.statuses.some((status) => status.key === "codex-compact" && String(status.text).includes("fold patch")),
    "session_start did not enable turn fold patch status",
  );

  await runtime.commands.get("codex-compact").handler("doctor", runtime.ctx);
  const doctor = runtime.notifications.at(-1)?.message ?? "";
  for (const expected of [
    "pi-codex-compact doctor",
    "Config load: ok",
    "Turn process folding: enabled",
    "Unsigned final-section fallback: enabled",
    "Render-derived fold groups: disabled",
    "Renderer patch version: 3",
    "Turn fold patch version: 5",
    "Turn fold patch check: compatible",
  ]) {
    assert(doctor.includes(expected), `doctor output missing: ${expected}`);
  }

  const streamingMessage = {
    role: "assistant",
    content: [
      textMessage("streaming process text", "commentary", "render-commentary"),
      textMessage("visible final text", "final_answer", "render-final"),
    ],
    stopReason: "stop",
  };
  const component = new AssistantMessageComponent(streamingMessage, true);
  const rendered = component.render(100).join("\n");
  assert(rendered.includes("streaming process text"), "streaming commentary should remain visible by default");
  assert(!rendered.includes("commentary hidden"), "legacy commentary marker should be off by default");
  assert(rendered.includes("visible final text"), "renderer hid final answer");

  const finalizedMessage = {
    role: "assistant",
    api: "openai-responses",
    provider: "cch-responses",
    model: "gpt-test",
    responseId: "resp_smoke",
    stopReason: "stop",
    timestamp: 123,
    content: [
      textMessage("sensitive process", "commentary", "final-commentary"),
      { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: {} },
      textMessage("final answer", "final_answer", "final-answer"),
    ],
  };
  const messageEndResult = runtime.handlers.get("message_end")({ type: "message_end", message: finalizedMessage }, runtime.ctx);
  assert(messageEndResult === undefined, "message_end should not strip commentary when legacy stripping is off");

  const userMessage = { role: "user", content: [{ type: "text", text: "please solve" }], timestamp: 1 };
  const processAssistant = {
    role: "assistant",
    content: [
      textMessage("thinking aloud", "commentary", "process-commentary"),
      { type: "thinking", thinking: "model thinking summary" },
      { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "x" } },
    ],
    stopReason: "tool_use",
    timestamp: 2,
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call_1|fc_1",
    content: [{ type: "text", text: "tool output" }],
    isError: false,
    timestamp: 3,
  };
  const finalAssistant = {
    role: "assistant",
    provider: "cch-responses",
    model: "gpt-test",
    responseId: "resp_turn_fold",
    stopReason: "stop",
    timestamp: 4,
    content: [
      textMessage("SIGNED_PROCESS_SHOULD_HIDE\n\n---\n\n## ✅ 结论：final conclusion", "final_answer", "turn-final"),
    ],
  };

  runtime.handlers.get("agent_end")(
    { type: "agent_end", messages: [processAssistant, toolResult, finalAssistant] },
    runtime.ctx,
  );
  const processGroups = runtime.customEntries.filter((entry) => entry.customType === "pi-codex-compact.process-group");
  assert(processGroups.length === 1, "agent_end did not create process group metadata");
  assert(processGroups[0].data.counts.toolCalls === 1, "process group did not count tool calls");
  assert(processGroups[0].data.counts.toolResults === 1, "process group did not count tool results");
  assert(processGroups[0].data.counts.thinking === 1, "process group did not count thinking blocks");
  assert(processGroups[0].data.counts.assistant === 2, "process group did not count assistant process text and signed final-section preamble");

  const fakeInteractive = {
    sessionManager: runtime.ctx.sessionManager,
    renderedContext: undefined,
    rebuildChatFromMessages() {
      InteractiveMode.prototype.renderSessionContext.call(this, {
        messages: [userMessage, processAssistant, toolResult, finalAssistant],
        thinkingLevel: "off",
        model: null,
      });
    },
  };

  InteractiveMode.prototype.renderSessionContext.call(fakeInteractive, {
    messages: [userMessage, processAssistant, toolResult, finalAssistant],
    thinkingLevel: "off",
    model: null,
  });
  runtime.setSessionMessages([userMessage, processAssistant, toolResult, finalAssistant]);
  let foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process hidden"), "folded context missing process marker");
  assert(foldedText.includes("1 tool calls"), "folded marker missing tool call count");
  assert(foldedText.includes("1 tool results"), "folded marker missing tool result count");
  assert(foldedText.includes("final conclusion"), "folded context missing final answer");
  assert(!foldedText.includes("thinking aloud"), "folded context leaked process text");
  assert(!foldedText.includes("SIGNED_PROCESS_SHOULD_HIDE"), "folded context leaked signed final-answer preamble");
  assert(!foldedText.includes("tool output"), "folded context leaked tool result");

  await runtime.shortcuts.get("alt+p").handler(runtime.ctx);
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process shown"), "Alt+P did not show process marker");
  assert(foldedText.includes("thinking aloud"), "Alt+P did not restore process text");
  assert(foldedText.includes("tool output"), "Alt+P did not restore tool result");

  await runtime.shortcuts.get("alt+p").handler(runtime.ctx);
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process hidden"), "second Alt+P did not hide process marker");
  assert(!foldedText.includes("thinking aloud"), "second Alt+P did not hide process text");

  await runtime.commands.get("codex-compact").handler("toggle", runtime.ctx);
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process shown"), "toggle command did not show process marker");
  assert(foldedText.includes("thinking aloud"), "toggle command did not restore process text");

  await runtime.commands.get("codex-compact").handler("fold", runtime.ctx);
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process hidden"), "fold command alias did not hide process marker");
  assert(!foldedText.includes("thinking aloud"), "fold command alias did not hide process text");

  assert(runtime.terminalInputListeners.length === 1, "raw Alt+P terminal input listener should be registered");
  const rawAltPResult = runtime.terminalInputListeners[0]("\x1bp");
  assert(rawAltPResult?.consume === true, "raw Alt+P terminal input should be consumed");
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process shown"), "raw Alt+P terminal input did not show process marker");
  assert(foldedText.includes("thinking aloud"), "raw Alt+P terminal input did not restore process text");

  const rawF8Result = runtime.terminalInputListeners[0]("\x1b[19~");
  assert(rawF8Result === undefined, "raw F8 should not be consumed when shortcut is alt+p");

  const rawAltPSecondResult = runtime.terminalInputListeners[0]("\x1bp");
  assert(rawAltPSecondResult?.consume === true, "second raw Alt+P terminal input should be consumed");
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process hidden"), "second raw Alt+P terminal input did not hide process marker");
  assert(!foldedText.includes("thinking aloud"), "second raw Alt+P terminal input did not hide process text");

  const bareToggleResult = runtime.handlers.get("input")({ type: "input", text: "codex-compact toggle", source: "interactive" }, runtime.ctx);
  assert(bareToggleResult?.action === "handled", "bare codex-compact toggle input should be handled");
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process shown"), "bare codex-compact toggle input did not show process marker");
  assert(foldedText.includes("thinking aloud"), "bare codex-compact toggle input did not restore process text");
  assert(runtime.notifications.some((entry) => entry.message.includes("Process group shown")), "toggle should notify shown state");

  const bareFoldResult = runtime.handlers.get("input")({ type: "input", text: "compact fold", source: "interactive" }, runtime.ctx);
  assert(bareFoldResult?.action === "handled", "bare compact fold input should be handled");
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process hidden"), "bare compact fold input did not hide process marker");

  const invisibleLatestGroup = {
    ...processGroups[0].data,
    groupId: "pg_invisible_latest",
    final: {
      ...processGroups[0].data.final,
      responseId: "resp_invisible_latest",
      timestamp: 99,
      textSignatureIds: ["invisible-final"],
    },
    counts: { assistant: 99, thinking: 0, toolCalls: 0, toolResults: 0, custom: 0, total: 99 },
  };
  runtime.customEntries.push({
    type: "custom",
    id: "custom_invisible_latest",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "pi-codex-compact.process-group",
    data: invisibleLatestGroup,
  });
  await runtime.commands.get("codex-compact").handler("toggle", runtime.ctx);
  foldedText = contextText(fakeInteractive.renderedContext);
  assert(foldedText.includes("process shown"), "toggle should target the latest visible process group, not an invisible persisted group");
  assert(foldedText.includes("thinking aloud"), "visible process group did not expand after invisible latest entry was appended");
  assert(runtime.notifications.at(-1)?.message.includes("5 entries"), "toggle notification targeted an invisible persisted process group");

  const normalInputResult = runtime.handlers.get("input")({ type: "input", text: "normal chat", source: "interactive" }, runtime.ctx);
  assert(normalInputResult?.action === "continue", "normal input should pass through");

  const unsignedFinalAssistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "cch-anthropic",
    model: "mimo-test",
    stopReason: "stop",
    timestamp: 5,
    content: [
      { type: "thinking", thinking: "hidden native thinking" },
      {
        type: "text",
        text: "UNSIGNED_PROCESS_SHOULD_HIDE\n\n---\n\n## ✅ 结论：UNSIGNED_FINAL_SHOULD_STAY",
      },
    ],
  };
  const unsignedContext = {
    messages: [userMessage, unsignedFinalAssistant],
    thinkingLevel: "off",
    model: null,
  };
  runtime.setSessionMessages(unsignedContext.messages);
  InteractiveMode.prototype.renderSessionContext.call(fakeInteractive, unsignedContext);
  const unsignedUnfoldedText = contextText(fakeInteractive.renderedContext);
  assert(!unsignedUnfoldedText.includes("process hidden"), "render-only derivation should be off by default");
  assert(unsignedUnfoldedText.includes("UNSIGNED_PROCESS_SHOULD_HIDE"), "history without process-group metadata should not be retro-folded");

  runtime.handlers.get("agent_end")({ type: "agent_end", messages: [unsignedFinalAssistant] }, runtime.ctx);
  InteractiveMode.prototype.renderSessionContext.call(fakeInteractive, unsignedContext);
  const unsignedFoldedText = contextText(fakeInteractive.renderedContext);
  assert(unsignedFoldedText.includes("process hidden"), "unsigned final-section fallback did not add process marker after agent_end");
  assert(unsignedFoldedText.includes("UNSIGNED_FINAL_SHOULD_STAY"), "unsigned fallback hid final section");
  assert(!unsignedFoldedText.includes("UNSIGNED_PROCESS_SHOULD_HIDE"), "unsigned fallback leaked process preamble");

  const beforePlanGroupCount = runtime.customEntries.filter((entry) => entry.customType === "pi-codex-compact.process-group").length;
  runtime.handlers.get("agent_end")({
    type: "agent_end",
    messages: [{
      role: "assistant",
      api: "openai-responses",
      provider: "cch-responses",
      model: "gpt-test",
      responseId: "resp_plan_section",
      stopReason: "stop",
      timestamp: 6,
      content: [textMessage("PLAN_SECTION_SHOULD_NOT_SPLIT\n\n---\n\n## 方案一：not a final answer", "final_answer", "plan-section")],
    }],
  }, runtime.ctx);
  const afterPlanGroupCount = runtime.customEntries.filter((entry) => entry.customType === "pi-codex-compact.process-group").length;
  assert(afterPlanGroupCount === beforePlanGroupCount, "方案/建议 section should not trigger final-section folding");

  await runtime.commands.get("codex-compact").handler("audit", runtime.ctx);
  const auditNotice = runtime.notifications.at(-1)?.message ?? "";
  assert(auditNotice.includes("No hidden commentary audit entries"), "audit should be empty when legacy stripping is off");

  const reloadedRuntime = createMockRuntime();
  await extension.default(reloadedRuntime.pi);
  await reloadedRuntime.handlers.get("session_start")({ type: "session_start" }, reloadedRuntime.ctx);
  reloadedRuntime.handlers.get("agent_end")(
    { type: "agent_end", messages: [processAssistant, toolResult, finalAssistant] },
    reloadedRuntime.ctx,
  );
  reloadedRuntime.setSessionMessages([userMessage, processAssistant, toolResult, finalAssistant]);
  const reloadedInteractive = {
    sessionManager: reloadedRuntime.ctx.sessionManager,
    renderedContext: undefined,
    rebuildChatFromMessages() {
      InteractiveMode.prototype.renderSessionContext.call(this, {
        messages: [userMessage, processAssistant, toolResult, finalAssistant],
        thinkingLevel: "off",
        model: null,
      });
    },
  };
  InteractiveMode.prototype.renderSessionContext.call(reloadedInteractive, {
    messages: [userMessage, processAssistant, toolResult, finalAssistant],
    thinkingLevel: "off",
    model: null,
  });
  let reloadedText = contextText(reloadedInteractive.renderedContext);
  assert(reloadedText.includes("process hidden"), "reloaded fold patch did not fold process group");
  await reloadedRuntime.shortcuts.get("alt+p").handler(reloadedRuntime.ctx);
  reloadedText = contextText(reloadedInteractive.renderedContext);
  assert(reloadedText.includes("process shown"), "reloaded fold patch did not show process marker");
  assert(reloadedText.includes("thinking aloud"), "reloaded fold patch kept old module fold state");
  assert(reloadedText.includes("tool output"), "reloaded fold patch did not restore tool result");

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-codex-compact-session-"));
  const sessionManager = new SessionManager(process.cwd(), sessionDir, undefined, false, { id: "audit-smoke" });
  sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  sessionManager.appendCustomEntry("pi-codex-compact.process-group", {
    groupId: "pg_context_safe",
    counts: { total: 1, assistant: 1 },
    hiddenBlocks: [{ text: "secret process" }],
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
    api: "openai-responses",
    provider: "cch-responses",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const llmContext = JSON.stringify(sessionManager.buildSessionContext().messages);
  assert(!llmContext.includes("secret process"), "custom process group leaked into LLM context");
  assert(!llmContext.includes("process hidden"), "render-only process marker leaked into LLM context");
  assert(llmContext.includes("final answer"), "assistant final answer missing from LLM context");

  InteractiveMode.prototype.renderSessionContext = realRenderSessionContext;
  InteractiveMode.prototype.handleEvent = realHandleEvent;
  InteractiveMode.prototype.createExtensionUIContext = realCreateExtensionUIContext;
  InteractiveMode.prototype.addExtensionTerminalInputListener = realAddExtensionTerminalInputListener;

  console.log("pi-codex-compact smoke test passed");
}

await main();
