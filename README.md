# DSH Council Plugins

Five plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
that turn it into a multi-agent workbench: several models answer the same
question independently, review each other, and vote — under a budget you can see
before you spend it.

## What's here

| Package | What it does |
| --- | --- |
| `@deepseek-ai/dsh-tool-council` | The council itself. Seats draft in parallel, review each other's drafts, then vote. Includes a planning gate, a live cost estimator, and a balance guard that refuses to start a run it cannot pay for. |
| `@deepseek-ai/dsh-agent-memory` | Durable memory shared across every seat and session, over the storage domain. Exposes `memory_write`, `memory_recall`, and `memory_forget`, plus a digest file that CLI seats can read. |
| `@deepseek-ai/dsh-web-search-cli` | Routes web search to whichever provider is cheapest — an already-authenticated agent CLI (billed to its subscription) before a metered API key. |
| `@deepseek-ai/dsh-client-ui-council-budget` | Sidebar panel: spend to date, projected capacity, per-seat toggles, and a form for adding OpenRouter models. Ships a council on/off switch that sits beside the composer's send button. |
| `@deepseek-ai/dsh-client-ui-openrouter-monitor` | Sidebar footer panel showing OpenRouter credit balance and per-model cost breakdown. |

## How the council works

1. **Plan.** One seat sketches the work and its scale. Nothing metered runs yet.
2. **Estimate.** Live OpenRouter pricing is applied to the plan. If the run looks
   likely to breach the configured daily, weekly, or monthly ceiling, it says so
   before anything is spent.
3. **Draft.** Every enabled seat answers independently, in parallel.
4. **Review.** Each seat scores every other seat's draft and votes.
5. **Tally.** Peer endorsement decides first; self-votes are weighted at half,
   so a confident seat cannot simply crown itself. Seats that failed to review
   are reported rather than silently dropped.

Output is colour-coded per seat, in ANSI for the terminal and coloured discs for
the chat surface. `--no-color`, `NO_COLOR`, and `TERM=dumb` are all honoured.

## Seats

Two transports are supported:

- **CLI seats** — a locally installed, already-logged-in agent CLI
  (`claude`, `codex`). Cost is absorbed by that subscription, so these seats
  never touch the metered budget.
- **OpenRouter seats** — any model OpenRouter serves. Extra seats can be added
  from the budget panel at runtime; colours are assigned automatically.

No seat is required. If a CLI is missing or a key is absent, that seat drops out
with a stated reason and the run continues on the rest.

## Install

These packages are written to drop into a DSH checkout as workspace packages.

```bash
DSH=<path-to-your-deepseek-harness-checkout>
cp -r packages/council/tool-council            "$DSH/packages/council/tool-council"
cp -r packages/memory/agent-memory             "$DSH/packages/memory/agent-memory"
cp -r packages/web/web-search-cli              "$DSH/packages/web/web-search-cli"
cp -r packages/client/ui-council-budget        "$DSH/packages/client/ui-council-budget"
cp -r packages/client/ui-openrouter-monitor    "$DSH/packages/client/ui-openrouter-monitor"
```

Then apply the host-side wiring in [`integration/`](integration/) — the bundle
must both mount each plugin *and* declare it as a dependency, or it will build
cleanly and fail at boot. Finally:

```bash
pnpm install
pnpm build
```

See [`integration/README.md`](integration/README.md) for the ordered steps.

## Configuration

Credentials are read from the environment and from DSH's own credential store.
Nothing is read from, or written to, this repository.

| Variable | Used by | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | council seats, search router | Only needed for OpenRouter seats. |

CLI seats need no key here — they use whatever login the CLI already holds.

## Requirements

- DeepSeek Harness, recent `master`
- Node 22+, pnpm 11+
- Optional: `claude` and/or `codex` on `PATH` for CLI seats
- Optional: an OpenRouter account for hosted seats

## Status

Working and in daily use, with these known limits:

- **Hosted seats can fabricate tool calls.** Some models emit literal
  `<tool>web_search</tool>` text and then report training-data figures as though
  they had been verified. Peer review catches this often but not always. There
  is no URL-verification step yet.
- **Subscription capacity is not measurable.** Neither `claude` nor `codex`
  reports remaining quota, so CLI seats are counted in throughput, never in
  dollars. The capacity projection says so in its own caveats.
- **Cost figures are estimates.** Prompt size is assumed at 3x output; a
  cache-heavy workload costs considerably less than projected.

## Licence

MIT. Built against DeepSeek Harness, also MIT — see [LICENSE](LICENSE).
