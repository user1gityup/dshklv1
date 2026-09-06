# @deepseek-ai/dsh-quota-claude

Publishes the Claude Code subscription quota — session and weekly percentages, reset wording, request counts, and the two usage-shape figures — into the `claude-quota` settings namespace, where the browser panel in `@deepseek-ai/dsh-client-ui-claude-quota` reads it.

The figures come from `claude -p "/usage"`, which the Claude Code CLI answers locally without an assistant turn. Nothing on disk carries the allowance: the session logs record tokens spent, never the ceiling they were spent against, so folding tokens can measure work done but cannot measure quota left. Percentages published here are the provider's own; this package derives none of them.

## Cost model

A live reading costs one request against the same quota it reports, so it never runs on a timer, at boot, or on a page load. Two paths write figures:

- **Boot** reads the status line's cache file (`~/.claude/statusline/usage-cache.json` by default) and publishes it if it is newer than what the namespace already carries. Free.
- **Refresh** runs the CLI once, publishes the result, and writes it back to the same cache file so the status line benefits from the call rather than paying for its own. Triggered only when `refreshRequestedAt` moves forward, which the panel's button does.

A refresh that returns nothing usable leaves the published figures standing and sets `refreshState` to `failed`; blanking real numbers on a transient failure would read as a quota reset that did not happen.

## Configuration

`config.enabled: false` registers nothing. `cachePath` overrides the shared cache file; empty means the status line's default path. `timeoutMs` caps one CLI call (default 90000); the child is killed at the cap and whatever arrived is parsed.

The remaining namespace fields are published state, not user configuration: `sessionPercent`, `sessionResets`, `weekPercent`, `weekResets`, `requests24h`, `sessions24h`, `requests7d`, `sessions7d`, `bigContextPercent`, `bigContextThresholdK`, `longSessionPercent`, `longSessionHours`, and `capturedAt`. A settings `update` treats `undefined` as "leave unchanged" rather than "clear", so a figure the CLI did not report is published as `-1` (`''` for the two reset strings) — zero cannot mean absent, because 0% used is a real reading at the start of a week. `refreshState` is `''`, `running`, `ok`, or `failed`.

## Model Experience

None, as the package registers no tool, prompt section, or result renderer; its output is one settings namespace read by a browser panel.

#### KV Cache effect

Independent: nothing this package writes enters a model request, so no prefix is added, replaced, or invalidated. The `/usage` subprocess is a separate CLI invocation that shares no context with the harness's own requests.

## Known Limitations and Deferred Work

- **The reading is parsed from prose** — `/usage` prints text meant for a person, so a wording change in the Claude Code CLI silently drops the fields whose patterns stop matching, leaving them absent rather than failing loudly. Each field is matched independently to keep the loss to one figure.
- **Windows and npm-global paths only** — the binary is located at three known install paths before falling back to the bare command name, and a `.cmd` shim is deliberately not spawned (a shell would be required). An installation elsewhere on PATH resolves only through that fallback.
- **No per-session attribution** — the namespace carries the account-wide reading the CLI reports. Which harness session consumed the quota is not derivable from it.
