# pi-codex-compact

Codex-style compact display for Pi.

Default behavior is now **turn process folding**: Pi shows the full assistant process while the model is working, then after a normally completed OpenAI Responses turn with signed `phase="final_answer"`, the TUI folds that turn's process block and leaves the final answer visible.

```text
user request

[process hidden: 4 entries: 1 assistant, 1 thinking, 1 tool calls, 1 tool results; press alt+p to show latest]

final answer
```

Press `alt+p` to restore/hide the latest folded process block in place. If the terminal does not deliver the shortcut to Pi, use `/codex-compact toggle` (alias: `/codex-compact fold`) as the same in-place toggle. Bare input `codex-compact toggle` / `compact fold` is also intercepted as a fallback.

## What it does

- Keeps streaming/working output visible by default: commentary, thinking, tool calls, and tool results are shown while the agent is active.
- On `agent_end`, folds only normal completed turns that contain signed OpenAI Responses `phase="final_answer"` text.
- Does **not** fold failed/aborted/timeout turns.
- Uses signed `final_answer` metadata when available.
- Also has a strict final-section fallback for messages that contain a clear markdown final section such as `---` followed by `✅ 结论` / `Conclusion`; this also applies inside signed `phase="final_answer"` blocks.
- Does not use broad headings such as `方案` or `建议` as final-answer boundaries, to avoid folding normal analysis sections.
- Folds by rendering only: original messages and tool results are not modified, so LLM context remains intact.
- Stores fold metadata in a non-context `custom` entry named `pi-codex-compact.process-group`.
- Inserts the fold marker and final-answer-only assistant message virtually during TUI rendering; neither is written into session message content.
- Keeps legacy commentary stripping and hidden-commentary audit commands available, but legacy stripping is off by default.

## Commands

```text
/codex-compact show    # show current mode summary and config path
/codex-compact audit   # show legacy hidden-commentary audit counts; does not print hidden text
/codex-compact latest  # show legacy hidden block metadata; does not print hidden text
/codex-compact summary # alias for latest
/codex-compact doctor  # check config loading and renderer/fold patch compatibility
/codex-compact reload  # reload config.json without restarting Pi
/codex-compact off     # disable folding/filtering/UI tweaks for this runtime session
/codex-compact on      # re-enable folding/filtering/UI tweaks
```

## Configuration

Runtime defaults live in:

```text
/root/.pi/agent/extensions/pi-codex-compact/config.json
```

Supported keys:

```json
{
  "enabled": true,
  "stripCommentaryText": false,
  "foldCompletedTurnProcess": true,
  "foldUnsignedFinalSections": true,
  "deriveFoldGroupsOnRender": false,
  "auditHiddenCommentary": true,
  "auditMaxTextChars": 200000,
  "patchAssistantRenderer": true,
  "showHiddenCommentaryMarker": true,
  "hiddenCommentaryMarker": "[commentary hidden: {count} block(s); press {shortcut} for summary below]",
  "hiddenSummaryShortcut": "",
  "turnProcessFoldShortcut": "alt+p",
  "processFoldMarker": "[process {state}: {total} entries: {details}; press {shortcut} to {action} latest]",
  "assistantMessageModulePath": "",
  "interactiveModeModulePath": "",
  "collapseToolOutput": false,
  "hideWorkingRow": false,
  "hiddenThinkingLabel": "Thinking hidden",
  "workingMessage": "working…"
}
```

Notes:

- `stripCommentaryText`: legacy mode. When `true`, finalized signed `commentary` text is removed from stored assistant messages and audited. Default is `false` so working output remains visible.
- `foldCompletedTurnProcess`: enables the new turn process folding mode.
- `foldUnsignedFinalSections`: enables conservative final-section splitting when a clear conclusion/answer marker is present. Despite the legacy name, this also splits signed `final_answer` blocks that contain a process preamble plus a final section.
- `deriveFoldGroupsOnRender`: optional compatibility mode for render-only derivation of missing fold metadata. Default is `false` to avoid retroactively folding old history.
- `turnProcessFoldShortcut`: shortcut for showing/hiding the latest folded process group in place. `/codex-compact toggle` and bare `codex-compact toggle` are command/input fallbacks for terminals that do not pass the shortcut through.
- `processFoldMarker`: marker template. Supports `{state}`, `{total}`, `{details}`, `{shortcut}`, and `{action}`.
- `patchAssistantRenderer`: enables internal Pi renderer patches. It now covers both legacy assistant-message rendering and turn process folding.
- `interactiveModeModulePath`: optional explicit path to Pi's internal `interactive-mode.js`; empty means auto-detect plus local fallback.
- `assistantMessageModulePath`: optional explicit path to Pi's internal `assistant-message.js`; empty means auto-detect plus local fallback.
- `collapseToolOutput`: default is `false` so processing remains fully visible before folding.

After editing `config.json`, run:

```text
/codex-compact reload
```

After editing extension code, run Pi `/reload` so `index.cjs` reloads a fresh `index.js` instance.

## Doctor

```text
/codex-compact doctor
```

The doctor command reports:

- config load status
- legacy assistant renderer patch compatibility/version
- interactive mode fold patch compatibility/version; version bumps force `/reload` to replace stale render closures
- current shortcut/config state

## Verification

Run the local smoke test after changing extension code or config behavior:

```bash
cd /root/.pi/agent/extensions/pi-codex-compact
npm run check
npm test
```

The smoke test covers:

- default config parsing
- Pi settings registration
- `/codex-compact doctor`
- streaming commentary staying visible by default
- `agent_end` process-group metadata creation
- folded render output hiding process while preserving final answer
- no retroactive render-only folding by default
- `方案` / `建议` headings do not trigger final-section folding
- `alt+p` restoring/hiding the latest folded process in place
- process-group custom entries staying out of `SessionManager.buildSessionContext()`

## Safety rules

- `final_answer` text is never hidden by folding; folded render uses a virtual final-answer-only assistant message.
- Original user, assistant, and tool-result messages are not modified for turn folding.
- LLM context keeps the full process B; folding is a TUI-only view transform.
- Failed/aborted/timeout turns are not folded.
- Providers without signed `phase="final_answer"` are folded only after `agent_end` creates process-group metadata using the strict final-section fallback; old history is not retro-folded by default.
- Fold markers are virtual render artifacts and do not enter assistant message content or LLM context.

## Activation

The extension is registered in:

```text
/root/.pi/agent/settings.json
```

Reload Pi after code edits:

```text
/reload
```

## Known limitations

- The renderer/fold patches use Pi internal APIs (`AssistantMessageComponent` and `InteractiveMode`) and may need adjustment after Pi upgrades.
- Current fallback absolute paths target the local Pi install under `/root/node-v22.22.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent`.
- Live visual behavior should still be confirmed inside Pi TUI after `/reload`.

## Debugging fold issues

If `alt+p` (or `/codex-compact toggle`) announces `Process group shown` but the folded block does not visually expand, or the shortcut seems dead, use the built-in diagnostic logger to pinpoint where the fold/expand pipeline breaks.

### Enable diagnostics

`index.js` ships a `dbg()` helper gated by `DEBUG_FOLD` at the top of the file:

```js
const DEBUG_FOLD = false;                         // set true temporarily to enable
const DEBUG_LOG_PATH = "/tmp/codex-compact-debug.log";
function dbg(msg) { /* appendFileSync with timestamp */ }
```

`dbg()` writes timestamped lines to `/tmp/codex-compact-debug.log` and is wired into the four decision points of the fold pipeline:

1. `toggleLatestProcessGroup` — logs `TOGGLE: latest.groupId=... willShow=... expandedProcessGroupId=... persistedGroups=... groups=...` and `TOGGLE: rebuilt=...`.
2. `buildFoldRanges` — logs every group's `groupId`, resolved `finalIndex`, and `expanded` flag; logs `SKIP group ... (finalIndex<0)` or `SKIP group ... (startIndex>finalIndex)` when a group cannot be matched to a final message.
3. `prepareSessionContextForProcessFolding` — logs `prepareFold: groups=... ranges=... expandedRanges=...` plus one `prepareFold range:` line per resolved range with its `start`, `final`, and `expanded`.
4. `requestProcessFoldRerender` — logs whether the live `InteractiveMode` instance was resolved from the context (`contextInstance=yes/no`, `hasRebuild=...`, `lastInstance=...`) and whether `rebuildChatFromMessages()` was actually called.

### Capture procedure

```text
1. Set DEBUG_FOLD = true in index.js temporarily.
2. In Pi TUI: /reload                       # reload the patched index.js
3. Ask the model a question and let it finish (so a fold group is created).
4. Press alt+p once.                        # reproduce the symptom
5. Inspect: cat /tmp/codex-compact-debug.log
```

### Reading the log

- No `TOGGLE:` line after pressing `alt+p` → the shortcut did not reach `toggleLatestProcessGroup` (reload not applied, or terminal swallowed `alt+p`; fall back to `/codex-compact toggle`).
- `TOGGLE: latest.groupId=undefined` or `No folded process group` → no foldable group exists; check whether `agent_end` wrote a `pi-codex-compact.process-group` custom entry.
- `buildFoldRanges: SKIP group <id> (finalIndex<0)` for the toggled group → `messageMatchesProcessGroupFinal` cannot find the final message in the rebuilt `buildSessionContext()` messages, so the range is dropped and nothing can expand. This is the most common cause of "shown but not expanded".
- `prepareFold range: expanded=false` despite `TOGGLE` setting `expandedProcessGroupId` → the `groupId` resolved during rebuild differs from the one captured at toggle time (persisted vs derived id mismatch).
- `requestRerender: contextInstance=no lastInstance=no` → the live `InteractiveMode` instance could not be resolved, so `rebuildChatFromMessages()` never runs and only a cheap `requestRender` fires; the fold state changes but the view is not rebuilt.

### Cleanup

After diagnosing, set `DEBUG_FOLD = false` (or remove the `dbg` calls) and `/reload` again to stop log growth.
