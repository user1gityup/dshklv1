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

![Where each tool lives in the DSH window: the council and swarm toggles beside
the composer, the swarm roster and pipeline panel, and the quota, budget and
OpenRouter panels in the sidebar footer](docs/ui-map.png)

## What's here

### The council

| Package | What it does |
| --- | --- |
| `@deepseek-ai/dsh-tool-council` | The council, the swarm, the proposing round, and the pipeline that chains them. Seven tools, a two-factor approval gate in front of each spending one, a live cost estimator, a citation audit, and a quota hold that parks a run rather than failing it. |
| `@deepseek-ai/dsh-agent-memory` | Durable memory shared across every seat and session, over the storage domain. Exposes `memory_write`, `memory_recall`, and `memory_forget`, plus a digest file that CLI seats read as a system prompt. |
| `@deepseek-ai/dsh-web-search-cli` | Routes web search to whichever provider is cheapest — an already-authenticated agent CLI, billed to its subscription, before a metered API key. |
| `@deepseek-ai/dsh-client-ui-council-budget` | The browser surface: budget panel, the Approve control, council and swarm toggles beside the composer, the swarm roster, and a pipeline panel with saved runs. |
| `@deepseek-ai/dsh-client-ui-openrouter-monitor` | Sidebar footer panel showing OpenRouter credit balance and per-model cost breakdown. |

### Claude Code quota — independent of the above

| Package | What it does |
| --- | --- |
| `@deepseek-ai/dsh-quota-claude` | Host half. Reads Claude Code's quota and publishes it through the `claude-quota` settings namespace, which the client already mirrors — no new wire method. A live reading costs a request against the quota it reports, so it never runs on a timer or at boot: boot publishes the status line's cache file, which is free, and a live call happens only when someone presses Refresh. |
| `@deepseek-ai/dsh-client-ui-claude-quota` | The panel. Sits directly above the council budget panel and shows the provider's own percentages, worded as `/usage` worded them. Nothing here infers a ceiling from token counts. |

## The seven tools

| Tool | What it does |
| --- | --- |
| `council` | Seats plan, say what they need looked up, draft in parallel, review each other, and vote. |
| `swarm` | Splits a request into units and runs them across the seats in dependency waves. For work that needs dividing rather than debating. |
| `propose` | Every seat writes its own version of the same change into a tree of its own, then the council votes on which version should be implemented. |
| `pipeline` | Chains council → swarm → council. One call advances one stage; each stage still passes its own tool's gate. |
| `save_pipeline_preset` | Saves a run as a named preset, so it becomes a button rather than a paragraph retyped. |
| `council_capacity` | Projects what a given monthly configuration actually buys, in work rather than in dollars. |
| `stage_work` | Writes code a seat has already produced into the session's own `.dsh-staging/`, never into your repository. Behind a separate two-step gate: a workspace-write selection in the permission control, then a literal `go` from you. Costs no model call — the generation was already billed. Needs [`integration/07`](integration/). |

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

Six seats ship configured:

| Seat | Transport | Cost | On by default |
| --- | --- | --- | --- |
| `claude` | Claude Code CLI | subscription | yes |
| `openai` | Codex CLI | subscription | yes |
| `kimi` | OpenRouter, `moonshotai/kimi-k2` | metered | yes |
| `deepseek` | OpenRouter, `deepseek/deepseek-v4-pro` | metered | yes |
| `free-claude` | Claude Code CLI via a local proxy | free | **no** |
| `openrouter-free` | a local free-model proxy | free | **no** |

The two free seats ship off because each needs a local process running, and a
seat that fails on every run of a fresh install is worse than one you turn on.
[Setting up the free seats](#the-free-seats) covers both.

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
integration/                     eight diffs for the host wiring, applied by hand
proxies/openrouter-free/         the local free-model proxy the free seat needs
scripts/                         launcher, proxy supervision, and a seat check
examples/                        a saved run you can paste in, and how they work
docs/                            the figure at the top of this file
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

Three of the eight diffs extend upstream packages rather than only adding to the
bundle, and two of those are load-bearing at *build* time, not boot time: without
`07` the staging test does not typecheck, and without `08` the client build fails
on four errors in `ui-council-budget`. Both are described in that README.

This exact sequence — a stock checkout at `b150a551b8`, all eight diffs, these
packages copied in — was built from scratch to confirm it: `pnpm install` then
`pnpm build`, 206 client artifacts, exit 0.

## Configuration

Credentials are read from the environment and from DSH's own credential store.
Nothing is read from, or written to, this repository.

| Variable | Used by | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | `kimi`, `deepseek`, the search router, and the openrouter-free proxy | Only needed for OpenRouter seats. Free models are billed at zero, not served anonymously, so the free proxy needs it too. |
| `FCC_DSH_API_KEY` | the Free Claude Code *provider*, if you add one to the model picker | Not needed for the `free-claude` council seat, which authenticates to the proxy itself. |

CLI seats need no key here — they use whatever login the CLI already holds. The
launcher also reads a key from `$DSH_HOME/.credentials.yaml` when the
environment has none, so there is one copy rather than two.

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

### What you do *not* need

- **Docker, or any container runtime.** Nothing here is containerised and
  neither is DSH: the harness is a Node workspace, and the two proxies are
  ordinary Python processes on localhost. There is no Dockerfile and no compose
  file in this repository or in the harness.
- **An Anthropic or OpenAI API key.** The `claude` and `openai` seats are the
  agent CLIs you have already signed in to; they inherit that session and are
  billed to it. The council never handles their credentials.
- **A DeepSeek key.** `web-search-deepseek` is switched off by the wiring, and
  the `deepseek` seat is a model served through OpenRouter, not DeepSeek's own
  API.
- **Anything installed by hand from npm.** The plugins pull `zod` and `react`,
  and `pnpm install` in the harness resolves both.

### What you do need

| | Version | Why |
| --- | --- | --- |
| DeepSeek Harness | recent `master` | the host. The wiring diffs are generated against `b150a551b8`. |
| Node | `^22.19.0 \|\| >=24.0.0` | DSH's own `engines` range — note the gap: 22.0–22.18 and every 23.x are outside it. Not enforced by `pnpm install` (there is no `engine-strict`), so an unsupported Node fails later, in the build, where the cause is less obvious. |
| pnpm | 11.7+ | DSH pins `pnpm@11.7.0` in `packageManager`. |
| git | any | the `integration/` diffs are applied with `git apply`. |

Per seat, all optional — a seat with nothing behind it drops out and the run
continues:

| For | You need |
| --- | --- |
| `claude`, `free-claude` | the Claude Code CLI on `PATH`, already signed in |
| `openai` | the Codex CLI on `PATH`, already signed in |
| `kimi`, `deepseek` | an OpenRouter account and `OPENROUTER_API_KEY` |
| `free-claude` | Free Claude Code running on `127.0.0.1:8082` — Python 3.14+ |
| `openrouter-free` | the proxy in `proxies/openrouter-free` on `127.0.0.1:8080` — Python 3.10+ (tested on 3.14), and an OpenRouter key |

On Windows, `corepack enable` can fail with `EPERM`; install pnpm globally with
`npm i -g pnpm` instead, and call it as `pnpm.cmd` from PowerShell.

### Preflight

Everything above, checked at once. Anything that errors is a seat you will not
get, not a broken install:

```bash
node --version                  # ^22.19.0 || >=24.0.0
pnpm --version                  # 11.7+
git --version
claude --version                # the `claude` and `free-claude` seats
codex --version                 # the `openai` seat
python --version                # 3.14+ for Free Claude Code; 3.10+ for the free-model proxy
echo "${OPENROUTER_API_KEY:0:8}"   # the metered seats, and the free-model proxy
curl -s http://127.0.0.1:8082/v1/models   # Free Claude Code, if you run it
curl -s http://127.0.0.1:8080/health      # the free-model proxy, if you run it
```

Once the plugins are installed, `scripts/verify-seats.cmd` does the same job
from the inside: it checks the compiled artifact, resolves each CLI seat's
binary, confirms each configured proxy is ready rather than merely listening,
and asks the free seats a real question. It calls no metered seat unless you
pass `--paid`.

## The free seats

Two seats cost nothing per token, and both need a process listening on
localhost. Each **fails loudly** when nothing is there. That is deliberate: a
silent fallback would quietly spend the paid subscription the free seat exists
to spare.

### `free-claude` — Free Claude Code, port 8082

The same `claude` binary as the paid seat, run as a different instance of
itself. Two things make it separate rather than a duplicate, and both matter:

- `ANTHROPIC_BASE_URL` points at the local proxy, so the request never reaches
  Anthropic and never draws on the subscription.
- `CLAUDE_CONFIG_DIR` gives it its own config, credentials and session state.
  **Without this the two seats share `~/.claude` and the free one can silently
  fall back to the logged-in subscription** — the exact outcome it exists to
  avoid.

The seat sets both itself; you do not configure them. What you provide is the
proxy — [Free Claude Code](https://github.com/Alishahryar1/free-claude-code),
which needs **Python 3.14 or newer**. It has its own one-line installer; the
route used here is a clone, so the code can be read before it runs:

```bash
git clone https://github.com/Alishahryar1/free-claude-code
cd free-claude-code
uv sync                           # it ships a uv.lock
.venv/Scripts/fcc-server          # Windows; .venv/bin/fcc-server elsewhere
```

Add at least one provider in its admin UI at
<http://127.0.0.1:8082/admin>, then check both endpoints answer:

```bash
curl http://127.0.0.1:8082/health
curl http://127.0.0.1:8082/v1/models
```

A model catalogue that comes back empty is the failure worth catching early: the
proxy is listening, so a port check passes, but every seat request will fail.
The launcher in [`scripts/`](scripts/) treats "healthy **and** a non-empty
catalogue" as the only definition of ready, for that reason.

Then enable the seat in `$DSH_HOME/settings.yaml`:

```yaml
council:
  seats:
    free-claude:
      enabled: true
```

**Configure a fallback chain in the proxy.** Free-tier capacity belongs to the
provider, not to you. Measured here: with one provider and no fallbacks, a 529
retried into the same wall for 84 seconds and the run's timeout killed the seat;
with a chain across three providers the same prompt answered in 18. The seat
carries a 420s timeout because a free tier retries through refusals before it
answers.

To offer the proxy as a *model* in DSH's picker as well as a council seat, add a
provider — that is the `Free — large tier (routed by FCC)` entry marked **3** in
the figure at the top:

```yaml
llm-pi-ai:
  providers:
    free-claude-code:
      displayName: Free Claude Code
      apiKeyEnv: FCC_DSH_API_KEY
      api: openai-responses
      baseURL: http://127.0.0.1:8082/v1
      models:
        - id: claude-sonnet-4-20250514
          name: Free (routed by FCC)
          contextWindow: 131072
```

Use the routed aliases above, not a pinned upstream model id. Naming a specific
provider model pins one model and bypasses the proxy's own routing, so the
fallback chain never fires.

### `openrouter-free` — the free-model pool, port 8080

Ships in this repository at [`proxies/openrouter-free`](proxies/openrouter-free/).
It keeps a pool of OpenRouter's zero-priced models and rewrites the seat's
`proxy-auto` placeholder to whichever one it currently prefers, so the seat does
not have to know which free models exist this week.

```bash
cd proxies/openrouter-free
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
export OPENROUTER_API_KEY=sk-or-v1-...
python -m openrouter_proxy
```

Then:

```yaml
council:
  seats:
    openrouter-free:
      enabled: true
```

Its own README covers the flags, the `--keep-alive` trap, and the model-picker
provider block.

## Running it

[`scripts/`](scripts/) is the launcher used here daily. It starts DSH, brings up
whichever proxies you have configured, watches them while DSH runs, and stops
the ones it started when DSH exits. It is Windows-flavoured (`.cmd` plus
PowerShell); on other platforms the plugins work the same and you start the
proxies yourself.

```powershell
./scripts/install.ps1 -DshRoot C:\src\deepseek-harness `
                      -FccDir  C:\src\free-claude-code `
                      -WithOpenRouterFree
```

That writes `scripts/dsh-env.cmd` — the one file naming paths on your machine,
and the one file that is gitignored — and puts a **DSH** shortcut on the
Desktop pointing at `scripts/launch-dsh.cmd`. Omit either proxy flag and that
seat simply stays off; the launcher will not start a proxy it has not been told
where to find.

| Script | What it does |
| --- | --- |
| `launch-dsh.cmd` | What the Desktop shortcut runs. Refuses early with a readable message if the web bundle has not been built. |
| `dsh-session.cjs` | Starts each configured proxy, runs DSH as its child, re-checks the proxies every 30 seconds, and stops what it started on exit. Recovery is capped at three attempts, so a proxy that will not come back stays down and says so. |
| `proxy-control.ps1` | `start`/`stop`/`status`/`restart` for one proxy. Ownership is recorded as PID **plus process start ticks**: a mismatch refuses to stop anything, so a reused PID is never killed and a proxy you started by hand is left alone. |
| `rebuild-dsh.cmd` | `pnpm install && pnpm build`, then launch. |
| `verify-seats.cmd` | Checks the compiled artifact, that each CLI seat's binary resolves, that configured proxies are ready, and that each seat answers a real prompt. Calls no metered seat. |

Stopping the proxy is a process *tree* kill, not a PID kill. The server spawns a
worker that holds the port; killing the parent alone leaks the worker and leaves
the port bound, which then looks like "something is already listening".

One sharp edge if you drive `proxy-control.ps1` by hand: **do not pipe its
output**. The proxy it starts outlives the call and holds the inherited pipe
open, so `proxy-control.ps1 ... | Out-Null` does not return until the proxy
stops. Run it bare, or capture the exit code. `dsh-session.cjs` inherits the
console rather than piping, so it is unaffected.

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
