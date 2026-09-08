# Host wiring

These diffs are generated against stock DeepSeek Harness `master` at
`b150a551b8`, and every one of them applies to that tree with a plain
`git apply`. On a newer `master` line numbers will have drifted — use
`git apply -3`, or apply them by hand. Read each one before you do: five of the
eight only add lines, one changes a setting (described below), and two extend
upstream packages (07 and 08).

Order matters. The bundle must **mount** each plugin in `cordis.patch.yml` *and*
**declare** it in the bundle's `package.json`. Doing only the first builds
cleanly and then fails at boot with an unresolved plugin — a confusing failure
worth avoiding.

| # | File | What it does |
| --- | --- | --- |
| 01 | `packages/bundle/base/cordis.patch.yml` | Mounts `agent-memory`, `tool-council`, `quota-claude` and `web-search-cli` on the host. Also switches the web seam to the router (see below). |
| 02 | `packages/bundle/base/package.json` | Declares those four as workspace dependencies. |
| 03 | `packages/bundle/web-app/cordis.patch.yml` | Mounts the three client panels. |
| 04 | `packages/bundle/web-app/package.json` | Declares them as workspace dependencies. |
| 05 | `packages/client/ui-sidebar/**` | Adds a `sidebar.region.action` list slot upstream doesn't have. The budget and quota panels mount into it. This one modifies an upstream package. |
| 06 | `tsconfig.client.json`, `tsconfig.host.json` | Adds the seven project references. |
| 07 | `packages/sandbox/sandbox-policy/**` | Adds the workspace-write gate `tool-council`'s `stage_work` is built on. Modifies an upstream package; see below. |
| 08 | `packages/client/ui-conversation/**` | Adds a `conversation.column.top` slot upstream doesn't have. The pipeline panel and the gate strip mount into it. Modifies an upstream package. |

Installing only one family is fine. For the council alone, drop the
`quota-claude` and `ui-claude-quota` lines from diffs 01, 02, 03, 04 and 06 —
but keep diff 05, which the budget panel needs. For the quota panel alone, keep
only those lines, and diff 05 with them — the quota panel needs neither diff 07
nor anything else here.

Then:

```bash
pnpm install
pnpm build
```

## A note on diff 01

Two changes there are opinions, not requirements:

- It sets `web.searchProvider: router` and disables `web-search-deepseek`.
  The web seam throws `WEB_PROVIDER_AMBIGUOUS` when more than one provider is
  usable and none is named — it will not pick for you. The router exists to make
  that choice on cost grounds.
- If you keep `web-search-deepseek` enabled instead, leave `searchProvider`
  pointed at it and skip mounting `web-search-cli`. Do not pin
  `searchProvider` to a provider you have disabled; that fails at boot.

## A note on diff 07

`tool-council` ships `stage_work`, which writes already-produced code into a
session's `.dsh-staging/` rather than into your repository. It is gated on a
two-step approval that upstream `sandbox-policy` does not have, so the diff adds
it: `approveWorkspaceWrites` arms a grant from the browser's permission control
and enables nothing by itself, and the grant only becomes real when the human
then sends exactly `go` in that session. Both steps are required, the grant
expires (15 minutes by default), and a delegated agent cannot arm one.

Two config keys come with it, both default `false`, so applying the diff changes
no behaviour until you turn them on in `packages/bundle/base/cordis.patch.yml`:

```yaml
    - id: sandbox-policy
      name: '@deepseek-ai/dsh-sandbox-policy'
      config:
        requireWriteConfirmation: true
        confinedOnly: true
```

`requireWriteConfirmation` is what makes the two-step gate live. `confinedOnly`
refuses `danger-full-access` outright, including an explicit escalation request.

**Skip this diff if you do not want `stage_work`.** Nothing else in the council
depends on it. One file will not typecheck without it —
`tool-council/tests/staging.spec.ts`, which is the only caller of
`approveWorkspaceWrites`/`revokeWorkspaceWrites` — so delete that test if you
leave the diff out. `src/staging.ts` itself still compiles, because it only uses
`resolve`, which upstream already has; but with no way to arm a grant,
`stage_work` will refuse every write. Dropping the tool entirely means removing
`src/staging.ts` and its `registerStaging` call in `src/index.ts` too.

## A note on diff 08

The pipeline panel and the council gate strip need a place that does not scroll
away. The upstream conversation dock cannot be that place: it rides the hero to
mid-column on a blank session and sinks to the floor once messages arrive, so
the one control you reach for after a long run ends up wherever the transcript
left it. Diff 08 adds a `conversation.column.top` slot that stays put.

Without it the client build fails, not at boot — `conversation.column.top` is
not in the slot-name union, and the panels' `inject: sessionId => …` form has no
matching overload. Four TypeScript errors in `ui-council-budget`, all the same
cause.

## Slot placement

The client panels register into five host slots, and two of them need a patch:

| Slot | Registered | Upstream? |
| --- | --- | --- |
| `sidebar.region.action` | the budget panel, and the quota panel above it | **No** — added by diff 05 |
| `conversation.column.top` | the pipeline panel, and the gate strip above it | **No** — added by diff 08 |
| `conversation.input.right` | council toggle, swarm toggle | Yes |
| `conversation.input.dock` | swarm roster | Yes |
| `tool.call.toolview` | the Approve control, and the council's own call view | Yes |

Diffs 05 and 08 exist solely to give those panels somewhere to live. If you
would rather not patch upstream, mount them into an existing slot instead —
`sidebar.footer.action` and `conversation.input.dock` both work, at the cost of
position. The budget panel measures its trigger's rect at open time and
positions itself relative to it, so it will not cover its own button wherever it
ends up.

The other three slots are upstream as they stand, which is why the toggles, the
swarm roster and the Approve control need no wiring of their own.

Note that diff 05 is needed by `ui-claude-quota` as well as `ui-council-budget`.
The quota panel is otherwise independent of the council — it imports nothing
from it — but it does want the same slot, at order 0 so it sits above the
budget panel.
