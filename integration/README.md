# Host wiring

These diffs are generated against stock DeepSeek Harness `master` at
`b150a551b8`, and every one of them applies to that tree with a plain
`git apply`. On a newer `master` line numbers will have drifted — use
`git apply -3`, or apply them by hand. Read each one before you do: five of the
six only add lines, and the sixth changes one setting, described below.

Order matters. The bundle must **mount** each plugin in `cordis.patch.yml` *and*
**declare** it in the bundle's `package.json`. Doing only the first builds
cleanly and then fails at boot with an unresolved plugin — a confusing failure
worth avoiding.

| # | File | What it does |
| --- | --- | --- |
| 01 | `packages/bundle/base/cordis.patch.yml` | Mounts `agent-memory`, `tool-council`, and `web-search-cli` on the host. Also switches the web seam to the router (see below). |
| 02 | `packages/bundle/base/package.json` | Declares those three as workspace dependencies. |
| 03 | `packages/bundle/web-app/cordis.patch.yml` | Mounts the two client panels. |
| 04 | `packages/bundle/web-app/package.json` | Declares them as workspace dependencies. |
| 05 | `packages/client/ui-sidebar/**` | Adds a `sidebar.region.action` list slot upstream doesn't have. The budget panel mounts into it. This one modifies an upstream package. |
| 06 | `tsconfig.client.json`, `tsconfig.host.json` | Adds the five project references. |

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

## Slot placement

`ui-council-budget` registers into four host slots, and only one of them needs a
patch:

| Slot | Registered | Upstream? |
| --- | --- | --- |
| `sidebar.region.action` | the budget panel | **No** — added by diff 05 |
| `conversation.input.right` | council toggle, swarm toggle | Yes |
| `conversation.input.dock` | swarm roster, pipeline panel | Yes |
| `tool.call.toolview` | the Approve control, and the council's own call view | Yes |

So diff 05 is the only one that modifies an upstream package, and it exists
solely to give the budget panel somewhere to live. If you would rather not patch
upstream, mount `ui-council-budget` into an existing slot instead —
`sidebar.footer.action` works, at the cost of position. The panel measures its
trigger's rect at open time and positions itself relative to it, so it will not
cover its own button wherever it ends up.

The other three slots are upstream as they stand, which is why the swarm roster,
the pipeline panel and the Approve control need no wiring of their own.
