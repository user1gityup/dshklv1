# @deepseek-ai/dsh-client-ui-claude-quota

Sidebar panel showing the Claude Code subscription quota: session and weekly meters, when each window resets, recent request and session counts, and the two figures that describe what the usage looked like — the share spent at large context, and the share from long-running sessions.

It registers one `sidebar.region.action` entry at order 0, directly above the council budget panel (order 1). The two answer different questions and are read together: what a council run will cost, and how much subscription allowance is left to run it on.

## Where the figures come from

The panel is a read-only projection of the `claude-quota` settings namespace, which `@deepseek-ai/dsh-quota-claude` publishes. A browser tab can neither spawn the Claude Code CLI nor read `~/.claude`, so every figure arrives through settings sync; absent figures arrive as `-1` (`''` for reset strings) and render as nothing rather than as zero.

The one write this panel makes is `refreshRequestedAt`. Pressing Refresh sets it to the current time; the host half watches that field, spends one request on `claude -p "/usage"`, and publishes the result. The button is disabled while `refreshState` is `running` and while the namespace is not writable, and the panel states the cost of a refresh next to it.

Meters turn amber at 70% and red at 90%. Those two colors are literal mid-tones rather than alias tokens because no `--dsw-alias-*` token carries a warning color; every other color in the panel is a token.

## Model Experience

None, as the package renders one browser-side sidebar panel and registers no tool, prompt section, or model-visible text.

#### KV Cache effect

Independent: the panel contributes nothing to a model request, so it neither extends nor invalidates any cached prefix. Its Refresh button spends a separate Claude Code CLI request that shares no context with the harness.

## Known Limitations and Deferred Work

- **No automatic freshness** — figures are as old as the last cache write or Refresh press, and the panel shows their timestamp rather than refreshing itself. Polling would spend quota to report quota.
- **Single account** — the namespace carries one reading, so a machine running Claude Code under more than one account shows whichever account the CLI answers as.
