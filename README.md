# pi-codex-compact

Codex-style compact display for Pi. The extension keeps assistant narrative text visible, keeps the active tool batch expanded, and folds consecutive completed thinking/tool activity between narrative boundaries into one Chinese summary:

```text
assistant commentary
⌕ 已读取 4 个文件、搜索 2 次、运行 3 个命令；1 个错误  ▾
assistant final answer
```

Collapsed activity segments hide their thinking, tool-call/result presentation, and matching background `info` notices from observational memory or RTK rewrites. Assistant text, text signatures/metadata, custom entries, and final answers keep their original order and content; invisible custom metadata is transparent to grouping, and expanding a segment restores its original thinking, tool details, and notices.

Press `alt+p` to expand or re-fold the latest completed activity segment. `/codex-compact toggle` (alias: `fold`) and bare input `codex-compact toggle` / `compact fold` remain available when a terminal does not deliver the shortcut.

## Behavior

- A batch is one assistant message containing tool calls plus exactly one finalized result for every call ID.
- An activity segment starts with a complete narrative-bearing batch and absorbs following complete batches that contain no assistant text. A standalone complete batch also forms a segment.
- Any non-empty assistant `text` is a narrative boundary and is always preserved. The extension never guesses from wording or provider-specific commentary/final-answer signatures.
- User messages, compaction summaries, other structural items, and active/incomplete/malformed batches end the current segment. `type: "custom"` metadata stays in its original render position but does not split otherwise continuous tool activity.
- Compaction summaries start collapsed independently of the current tool-output expansion state; Pi's normal expand shortcut can still reveal them explicitly.
- The batch remains expanded while running, including the interval after individual parallel tools finish but before `turn_end`.
- At a complete `turn_end`, the extension updates the existing assistant component and hides the existing tool components in place. It does not clear or rebuild chat history, so the editor/footer remain anchored and earlier component identity is preserved.
- Subagent batches, duplicate or missing call IDs, duplicate/missing results, orphan results, failed/aborted assistant messages, and other unreliable pairings fail open and remain expanded.
- Summary counts aggregate every batch in the segment: reads (`read`), searches (`grep`/`rg`/`ffgrep`/`find`/`fffind`/`fast_context_search`), commands (`bash`), modifications (`edit`/`write`), other tools, and errors.
- Informational notices beginning with `Observational memory:` or `RTK rewrite:` join the current activity marker as `后台通知 N 条`. Warnings and errors stay visible.
- Folding is render-only. `InteractiveMode.renderSessionItems()` still receives the original items; the assistant component projects a virtual marker from its original message, while each folded `ToolExecutionComponent` renders zero rows without losing its result, error, image, or renderer state. No session message is appended or rewritten.
- Existing `pi-codex-compact.process-group` custom entries remain harmless non-context history, but no new whole-process group is created at `agent_end` and old groups no longer drive rendering.
- Legacy signed-commentary stripping and audit commands remain available independently; stripping is off by default.

## Commands

```text
/codex-compact show    # current mode, shortcut, and config path
/codex-compact doctor  # actual renderer adapter, compatibility, and patch version
/codex-compact reload  # reload config.json
/codex-compact toggle  # expand/re-fold latest completed tool activity segment
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

### Activity-folding options

- `foldCompletedToolBatches`: backward-compatible key that enables completed activity-segment folding; default `true`. Set it to `false` for immediate rollback to normal Pi thinking/tool rendering.
- `toolBatchFoldShortcut`: shortcut used by Pi and the raw-terminal fallback to toggle the latest activity segment.
- `toolBatchFoldMarker`: aggregate segment marker; supports `{summary}`, `{errors}`, and `{chevron}`. For migration it also accepts legacy placeholders `{state}`, `{total}`, `{details}`, `{shortcut}`, and `{action}`.
- If a new batch shortcut/marker key is absent, `turnProcessFoldShortcut` / `processFoldMarker` are accepted as deprecated aliases. They do not re-enable whole-turn hiding.
- Obsolete `foldCompletedTurnProcess`, `foldUnsignedFinalSections`, and `deriveFoldGroupsOnRender` keys are ignored. Whole-turn `agent_end` folding is no longer rendered or persisted.
- `collapseToolOutput` controls detail expansion inside visible Pi tool rows; it is independent from activity-segment folding and defaults to `false`.
- `hiddenThinkingLabel` still controls active or explicitly expanded thinking rows. Collapsed activity segments do not render those thinking blocks at all.

### Legacy commentary options

- `stripCommentaryText`: when `true`, finalized signed `commentary` text is removed using the legacy message filter and optionally audited. It defaults to `false`.
- `auditHiddenCommentary`, `showHiddenCommentaryMarker`, `hiddenCommentaryMarker`, and `hiddenSummaryShortcut` control the existing audit/summary UI.
- Commentary-only responses fail open and remain visible. Audit truncation counts Unicode code points, so it never stores half of a surrogate pair.
- `patchInternalRenderers` is the master switch for the assistant, tool, and interactive Pi-internal adapters. All three must be compatible or activity folding fails open. Deprecated `patchAssistantRenderer` is accepted as an alias when the new key is absent.
- `assistantMessageModulePath` and `interactiveModeModulePath` can override Pi internal module discovery.

After editing non-shortcut configuration, run `/codex-compact reload`. Shortcut changes and extension-code changes require Pi `/reload`; Pi then tears down the old instance, restores patched prototypes/UI state, and lets `index.cjs` load a fresh module instance.

## Pi 0.80.6-0.80.7 compatibility

The supported adapter is:

```text
InteractiveMode.renderSessionItems(items, options)
InteractiveMode.handleEvent(event)
InteractiveMode.createExtensionUIContext(...)
InteractiveMode.addExtensionTerminalInputListener(...)
InteractiveMode.showExtensionNotify(message, type)
AssistantMessageComponent.updateContent(message)
ToolExecutionComponent.render(width)
```

Supported Pi versions do **not** expose `renderSessionContext()`. `/codex-compact doctor` reports the detected adapter (`component-state`), all three patch versions, individual method presence, and the true compatible/incompatible state. `rebuildChatFromMessages()` is reported for diagnostics but is deliberately not required or called by routine folding. If a required component method is missing, the extension fails open and leaves normal TUI rendering untouched.

The patched `handleEvent()` updates fold state after a complete tool-bearing `turn_end` and requests a normal TUI render. Individual `tool_execution_end` and `agent_end` events do not trigger activity folding. Alt+P refreshes the same component instances instead of reconstructing the transcript.

## Verification

```bash
cd /root/.pi/agent/extensions/pi-codex-compact
npm run check
npm test
```

The smoke suite verifies:

- the installed package is a supported Pi 0.80.6-0.80.7 build with real `renderSessionItems` and without obsolete `renderSessionContext`;
- active, sequential, merged multi-batch activity, text boundaries, parallel completion-order, error, incomplete, duplicate, and orphan cases;
- folded thinking removal, whole-segment thinking/tool restoration, transparent interleaved custom metadata, and preservation of narrative text, signatures, final text, custom entries, and result order;
- zero chat rebuilds/clears at `turn_end` and Alt+P, stable assistant/tool component identity, and zero-row folded tool rendering with live result state retained;
- observational-memory/RTK informational notices joining the same marker, Alt+P restoration, and off/shutdown cleanup;
- `Alt+P`, slash command, bare-input fallback, reload, stale extension contexts, and legacy commentary audit;
- deep equality of `SessionManager.buildSessionContext().messages` before/after rendering and absence of virtual markers from session JSONL.

## Safety and limitations

- Thinking and tool results (including errors and images) are hidden only while their completed activity segment is folded and are restored by toggle. Error count remains visible in the aggregate summary.
- A terminating structured-output tool result is also folded after a reliable `turn_end`; use `Alt+P` to inspect it. Pi does not persist the raw `terminate` hint, so reload-safe structural reconstruction cannot distinguish this case.
- Historical/resumed/branched/compacted views derive activity segments from the compaction-aware items passed to `renderSessionItems`; no global message index or persisted fold state is used.
- The adapter uses Pi internal APIs and may require an update after Pi upgrades. Run doctor and the smoke suite after upgrading Pi.
- TUI prototype patching and terminal listeners are skipped in RPC, JSON, and print modes.
