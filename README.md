# DSH Plugins

Seven plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Five of them turn it into a multi-agent workbench: several models answer the
same question independently, review each other, and vote — and then, if you
want, split the agreed work across those same models and vote again on the code
they each wrote. Nothing metered runs until you have seen what it will cost and
pressed Approve.

The other two are a Claude Code quota panel. They have nothing to do with the
council and depend on none of it; they are here because this is where the other
panels live, and they install the same way.

## What's here

### The council

| Package | What it does |
| --- | --- |
| `@deepseek-ai/dsh-tool-council` | The council, the swarm, the proposing round, and the pipeline that chains them. Six tools, a two-factor approval gate in front of each spending one, a live cost estimator, a citation audit, and a quota hold that parks a run rather than failing it. |
| `@deepseek-ai/dsh-agent-memory` | Durable memory shared across every seat and session, over the storage domain. Exposes `memory_write`, `memory_recall`, and `memory_forget`, plus a digest file that CLI seats read as a system prompt. |
| `@deepseek-ai/dsh-web-search-cli` | Routes web search to whichever provider is cheapest — an already-authenticated agent CLI, billed to its subscription, before a metered API key. |
| `@deepseek-ai/dsh-client-ui-council-budget` | The browser surface: budget panel, the Approve control, council and swarm toggles beside the composer, the swarm roster, and a pipeline panel with saved runs. |
| `@deepseek-ai/dsh-client-ui-openrouter-monitor` | Sidebar footer panel showing OpenRouter credit balance and per-model cost breakdown. |

### Claude Code quota — independent of the above

| Package | What it does |
| --- | --- |
| `@deepseek-ai/dsh-quota-claude` | Host half. Reads Claude Code's quota and publishes it through the `claude-quota` settings namespace, which the client already mirrors — no new wire method. A live reading costs a request against the quota it reports, so it never runs on a timer or at boot: boot publishes the status line's cache file, which is free, and a live call happens only when someone presses Refresh. |
| `@deepseek-ai/dsh-client-ui-claude-quota` | The panel. Sits directly above the council budget panel and shows the provider's own percentages, worded as `/usage` worded them. Nothing here infers a ceiling from token counts. |

## The six tools

| Tool | What it does |
| --- | --- |
| `council` | Seats plan, say what they need looked up, draft in parallel, review each other, and vote. |
| `swarm` | Splits a request into units and runs them across the seats in dependency waves. For work that needs dividing rather than debating. |
| `propose` | Every seat writes its own version of the same change into a tree of its own, then the council votes on which version should be implemented. |
| `pipeline` | Chains council → swarm → council. One call advances one stage; each stage still passes its own tool's gate. |
| `save_pipeline_preset` | Saves a run as a named preset, so it becomes a button rather than a paragraph retyped. |
| `council_capacity` | Projects what a given monthly configuration actually buys, in work rather than in dollars. |

## The approval gate

Every tool that spends stops before it spends, and the gate is deliberately
two-factor:

1. A press of the **Approve** control, which writes a settings key. No
   model-facing tool can write that key — it is reachable only from the browser.
2. A user turn after that press.

Both are required, approvals are single-use, and they expire. The reason is
concrete: a model asked to respect a `plan` argument will write its own plan and
pass it. Caller flags that could weaken the gate are ignored while unapproved.
The council, the swarm and the proposing round each hold their own slots, so
approving a debate cannot authorise a graph of workers, and neither can
authorise every seat writing code.

## How a council run works

1. **Plan.** One seat sketches the work and its scale. Nothing metered runs yet.
2. **Estimate.** Live OpenRouter pricing is applied to the plan. If the run
   looks likely to breach the configured daily, weekly, or monthly ceiling, it
   says so before anything is spent — and then it stops at the gate.
3. **Research.** Each seat says what it needs looked up, and what source files
   it needs to see. Those searches and reads are performed on its behalf and the
   results are shared with every seat, so one lookup serves the whole council.
4. **Draft.** Every enabled seat answers independently, in parallel.
5. **Review.** Each seat scores every other seat's draft and votes.
6. **Audit.** Cited URLs are checked. Anything that came from the shared
   evidence is trusted; anything else is fetched and must answer.
7. **Tally.** Peer endorsement decides first; self-votes are weighted at half,
   so a confident seat cannot crown itself. A seat that cited what does not
   resolve is scored down, not merely annotated. Seats that failed to review are
   reported rather than silently dropped.

Output is colour-coded per seat, in ANSI for the terminal and coloured discs for
the chat surface. `--no-color`, `NO_COLOR`, and `TERM=dumb` are all honoured.

## Seats, and what a seat can reach

Two transports:

- **CLI seats** — a locally installed, already-logged-in agent CLI. Cost is
  absorbed by that subscription, so these never touch the metered budget.
- **OpenRouter seats** — any model OpenRouter serves. Extra seats can be added
  from the budget panel at runtime; colours are assigned automatically.

Five seats ship configured: `claude` and `openai` on their CLIs, `kimi` and
`deepseek` on OpenRouter, and `free-claude` — the same `claude` binary pointed
at a local proxy with its own config directory, off by default because it needs
that proxy running.

No seat is required. If a CLI is missing or a key is absent, that seat drops out
with a stated reason and the run continues on the rest.

**An OpenRouter seat has no filesystem, no network, and no tools.** It is a bare
chat completion. Rather than pretend otherwise, the council brokers both
directions:

- **Reading.** A seat writes `READ: <path>` and is handed the text. It never
  holds a handle, a directory listing, or a glob. Paths are resolved against
  roots you configure and refused outside them, and per-file and per-run
  character caps keep one file from flooding every later prompt. Truncation is
  marked rather than silent.
- **Writing.** In a proposing round a seat writes `WRITE: <path>` and a fenced
  block, and the host writes it under that seat's own root — never into your
  repository, and never where another seat's candidate lives. A fence that was
  never closed is dropped rather than written, because a truncated source file
  looks complete.

Swarm and proposing-round workers are seats, which means they are one-shot
prompts. They read, analyse and report; the shipped CLI seats run with
`--allowedTools WebSearch,WebFetch,Read,Glob,Grep` and write nothing. Widening
that is a change to a seat's own argv, made by you.

## Layout

```
packages/
  council/tool-council/          28 source modules, 16 test files
    src/
      council.ts     the council run: plan, research, draft, review, tally
      swarm.ts       decomposed work run across the seats, behind its own gate
      propose.ts     every seat writes the same change into its own tree
      select.ts      the vote that picks which candidate is implemented
      pipeline.ts    council → swarm → council as one resumable chain
      approval.ts    the two-factor gate every spending tool stops at
      files.ts       READ: broker — a seat asks, the host reads
      writes.ts      WRITE: broker — a seat proposes, the host places it
      decompose.ts   a request → a validated task graph
      roster.ts      which seat takes which unit
      evidence.ts    seat-directed search, shared across the council
      verify.ts      citation audit
      quota-hold.ts  park a run on an exhausted allowance instead of failing
      presets.ts     saved runs; the one settings key a model may write
      estimate.ts    execution-cost.ts  budget.ts  capacity.ts  usage.ts
      seats.ts       colors.ts  markdown.ts  report.ts  credentials.ts
  memory/agent-memory/           memory_write, memory_recall, memory_forget
  web/web-search-cli/            cost-ordered search router
  client/ui-council-budget/      budget panel, Approve control, toggles,
                                 swarm roster, pipeline panel with saved runs
  client/ui-openrouter-monitor/  balance and per-model cost
  quota/quota-claude/            reads Claude Code's quota, publishes it
  client/ui-claude-quota/        the panel that shows it
integration/                     six diffs for the host wiring, applied by hand
examples/                        a saved run you can paste in, and how they work
```

The two quota packages are independent: they import nothing from the council
and the council imports nothing from them. Install either family without the
other.

## Install

These packages are written to drop into a DSH checkout as workspace packages.

```bash
DSH=<path-to-your-deepseek-harness-checkout>
cp -r packages/council/tool-council            "$DSH/packages/council/tool-council"
cp -r packages/memory/agent-memory             "$DSH/packages/memory/agent-memory"
cp -r packages/web/web-search-cli              "$DSH/packages/web/web-search-cli"
cp -r packages/client/ui-council-budget        "$DSH/packages/client/ui-council-budget"
cp -r packages/client/ui-openrouter-monitor    "$DSH/packages/client/ui-openrouter-monitor"
cp -r packages/quota/quota-claude              "$DSH/packages/quota/quota-claude"
cp -r packages/client/ui-claude-quota          "$DSH/packages/client/ui-claude-quota"
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

Settings live in the `council` namespace and are read per invocation, so a
toggle takes effect on the next call without a restart. Two are worth knowing
before a first run: `fileRoots`, a comma-separated list of directories seats may
ask to be shown files from — empty by default, and while it is empty no seat is
even told it may ask; and `autoApprove`, which is off, and which only a person
can turn on.

A run you expect to repeat can be saved as a preset and started from a pill on
the pipeline panel. [`examples/`](examples/) has a ready-to-paste one and the
settings shape behind it.

## Requirements

- DeepSeek Harness, recent `master`
- Node 22+, pnpm 11+
- Optional: an agent CLI on `PATH` for CLI seats
- Optional: an OpenRouter account for hosted seats

## Status

Working and in daily use, with these known limits:

- **Hosted seats can still fabricate.** The citation audit catches URLs that do
  not resolve and scores them down, and shared evidence removes most of the
  incentive. Neither catches a real page cited for a claim it does not make.
- **The council's own capacity figures are against a budget you set.**
  Consumption is read from the CLIs' local session logs, so throughput is real,
  but the council infers no account ceiling and states none. The quota panel is
  the exception and is separate for that reason: it reports Claude Code's real
  percentages because it asks `/usage` for them, at the cost of a request
  against the quota, and only when you press Refresh.
- **Cost figures are estimates.** Prompt size is assumed at 3x output; a
  cache-heavy workload costs considerably less than projected. A unit of swarm
  work is assumed to produce 6,000 output tokens, which a seat writing whole
  files will exceed.
- **A seat cannot iterate.** Workers are one-shot prompts, not sessions. A
  proposing round buys several independent attempts, not several rounds of one.

## Licence

MIT. Built against DeepSeek Harness, also MIT — see [LICENSE](LICENSE).
