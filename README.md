# pi-codex-compact

Codex-style compact display for Pi. The extension keeps the active tool batch visible, then folds each reliably completed batch at `turn_end` into one Chinese summary:

```text
assistant commentary
⌕ 已读取 4 个文件、搜索 2 次、运行 3 个命令；1 个错误  ▾
assistant final answer
```

Only tool-call/result presentation is folded. Assistant text, thinking blocks, signatures/metadata, custom entries, and final answers keep their original order and content.

Press `alt+p` to expand or re-fold the latest completed batch. `/codex-compact toggle` (alias: `fold`) and bare input `codex-compact toggle` / `compact fold` remain available when a terminal does not deliver the shortcut.

## Behavior

- A batch is one assistant message containing tool calls plus exactly one finalized result for every call ID.
- The batch remains expanded while running, including the interval after individual parallel tools finish but before `turn_end`.
- At a complete `turn_end`, the TUI rebuilds once and folds that batch. Earlier batches can therefore stay folded while the next batch streams normally.
- Duplicate or missing call IDs, duplicate/missing results, orphan results, failed/aborted assistant messages, and other unreliable pairings fail open and remain expanded.
- Summary counts are based on calls: reads (`read`), searches (`grep`/`rg`/`ffgrep`/`find`/`fffind`/`fast_context_search`), commands (`bash`), modifications (`edit`/`write`), and other tools. Error count is always shown.
- Folding is render-only. It shallow-copies the assistant message passed to `InteractiveMode.renderSessionItems()`, replaces only `toolCall` blocks with a virtual marker, and does not append or rewrite session messages.
- Existing `pi-codex-compact.process-group` custom entries remain harmless non-context history, but no new whole-process group is created at `agent_end` and old groups no longer drive rendering.
- Legacy signed-commentary stripping and audit commands remain available independently; stripping is off by default.

## Commands

```text
/codex-compact show    # current mode, shortcut, and config path
/codex-compact doctor  # actual renderer adapter, compatibility, and patch version
/codex-compact reload  # reload config.json
/codex-compact toggle  # expand/re-fold latest completed tool batch
/codex-compact fold    # alias for toggle
/codex-compact audit   # legacy hidden-commentary audit counts
/codex-compact latest  # legacy hidden-commentary metadata
/codex-compact summary # alias for latest
/codex-compact off     # disable runtime rendering/filtering tweaks
/codex-compact on      # re-enable runtime rendering/filtering tweaks
```

## Configuration

Runtime configuration is `/root/.pi/agent/extensions/pi-codex-compact/config.json`:

```json
{
  "enabled": true,
  "stripCommentaryText": false,
  "foldCompletedToolBatches": true,
  "toolBatchFoldShortcut": "alt+p",
  "toolBatchFoldMarker": "⌕ {summary}{errors}  {chevron}",
  "auditHiddenCommentary": true,
  "auditMaxTextChars": 200000,
  "patchInternalRenderers": true,
  "showHiddenCommentaryMarker": true,
  "hiddenCommentaryMarker": "[commentary hidden: {count} block(s); press {shortcut} for summary below]",
  "hiddenSummaryShortcut": "",
  "assistantMessageModulePath": "",
  "interactiveModeModulePath": "",
  "collapseToolOutput": false,
  "hideWorkingRow": false,
  "hiddenThinkingLabel": "Thinking hidden",
  "workingMessage": "working…"
}
```

### Batch options

- `foldCompletedToolBatches`: enables batch folding; default `true`. Set it to `false` for immediate rollback to normal Pi tool rendering.
- `toolBatchFoldShortcut`: shortcut used by Pi and the raw-terminal fallback.
- `toolBatchFoldMarker`: supports `{summary}`, `{errors}`, and `{chevron}`. For migration it also accepts legacy placeholders `{state}`, `{total}`, `{details}`, `{shortcut}`, and `{action}`.
- If a new batch shortcut/marker key is absent, `turnProcessFoldShortcut` / `processFoldMarker` are accepted as deprecated aliases. They do not re-enable whole-turn hiding.
- Obsolete `foldCompletedTurnProcess`, `foldUnsignedFinalSections`, and `deriveFoldGroupsOnRender` keys are ignored. Whole-turn `agent_end` folding is no longer rendered or persisted.
- `collapseToolOutput` controls detail expansion inside visible Pi tool rows; it is independent from completed-batch folding and defaults to `false`.

### Legacy commentary options

- `stripCommentaryText`: when `true`, finalized signed `commentary` text is removed using the legacy message filter and optionally audited. It defaults to `false`.
- `auditHiddenCommentary`, `showHiddenCommentaryMarker`, `hiddenCommentaryMarker`, and `hiddenSummaryShortcut` control the existing audit/summary UI.
- Commentary-only responses fail open and remain visible. Audit truncation counts Unicode code points, so it never stores half of a surrogate pair.
- `patchInternalRenderers` is the master switch for both Pi-internal prototype adapters. Deprecated `patchAssistantRenderer` is accepted as an alias when the new key is absent.
- `assistantMessageModulePath` and `interactiveModeModulePath` can override Pi internal module discovery.

After editing non-shortcut configuration, run `/codex-compact reload`. Shortcut changes and extension-code changes require Pi `/reload`; Pi then tears down the old instance, restores patched prototypes/UI state, and lets `index.cjs` load a fresh module instance.

## Pi 0.80.6 compatibility

The supported adapter is:

```text
InteractiveMode.renderSessionItems(items, options)
InteractiveMode.handleEvent(event)
InteractiveMode.createExtensionUIContext(...)
InteractiveMode.addExtensionTerminalInputListener(...)
InteractiveMode.rebuildChatFromMessages()
```

Pi 0.80.6 does **not** expose `renderSessionContext()`. `/codex-compact doctor` reports the detected adapter (`renderSessionItems`), patch version, individual method presence (including the rebuild method required for immediate `turn_end` folding), and the true compatible/incompatible state. If required methods are missing, the extension fails open and leaves normal TUI rendering untouched.

The patched `handleEvent()` rebuilds only after a complete tool-bearing `turn_end`; individual `tool_execution_end` and `agent_end` events do not trigger batch folding.

## Verification

```bash
cd /root/.pi/agent/extensions/pi-codex-compact
npm run check
npm test
```

The smoke suite verifies:

- the installed package is Pi 0.80.6 with real `renderSessionItems` and without obsolete `renderSessionContext`;
- active, sequential, two-batch, parallel completion-order, error, incomplete, duplicate, and orphan cases;
- preservation of commentary, thinking, signatures, final text, custom entries, and result order;
- `Alt+P`, slash command, bare-input fallback, reload, stale extension contexts, and legacy commentary audit;
- deep equality of `SessionManager.buildSessionContext().messages` before/after rendering and absence of virtual markers from session JSONL.

## Safety and limitations

- Tool results (including errors and images) are hidden only while their completed batch is folded and are restored by toggle. Error count remains visible in the summary.
- A terminating structured-output tool result is also folded after a reliable `turn_end`; use `Alt+P` to inspect it. Pi does not persist the raw `terminate` hint, so reload-safe structural reconstruction cannot distinguish this case.
- Historical/resumed/branched/compacted views are derived from the compaction-aware items passed to `renderSessionItems`; no global message index or persisted fold state is used.
- The adapter uses Pi internal APIs and may require an update after Pi upgrades. Run doctor and the smoke suite after upgrading Pi.
- TUI prototype patching and terminal listeners are skipped in RPC, JSON, and print modes.
