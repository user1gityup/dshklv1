# Saved runs

A saved run is a request written once and kept, so that starting it is a button
press rather than a paragraph retyped. The pipeline panel lists them as pills;
picking one aims the Run button at it, and pressing Run starts the chain.

A preset authorises nothing. It is text. Every stage it reaches still stops at
its own approval gate, and you still press Approve and speak before anything is
spent. That is why a preset is the one settings key a model is allowed to write:
saving one cannot start anything.

## Where they live

In `$DSH_HOME/settings.yaml`, under the `council` namespace:

```yaml
council:
  pipelinePresets:
    <area>/<name>:
      name: <the button label>
      query: <the whole request>
      autoAdvance: false
```

The id is `area/name`, both halves lowercase kebab — letters, digits and
hyphens. The panel sorts by id, so an area groups its own runs together and the
area shows on the pill as a chip. A `query` holds up to 64,000 characters, which
is enough for a full brief; there is no need to point it at a file.

`autoAdvance` sends the continue prompt once per stage so you are not clicking
through a chain you have already approved. It never fires while a run is held on
an exhausted quota, it clears itself when the run ends, and it does **not** touch
approval — unless `autoApprove` is on, every stage still stops at its gate.

You can also save one from inside a session — "save that as a preset called
`web/ship-landing`" — which goes through `save_pipeline_preset`. That tool can
express a preset map and nothing else, so no approval slot is reachable from it.

## Before the first run

Set `council.fileRoots` to the directories the seats may be shown files from,
comma-separated:

```yaml
council:
  fileRoots: /path/to/repo-one,/path/to/repo-two
```

Until it is set, **no seat is told it may ask for a file**, and every stage will
reason from memory rather than from your source. An OpenRouter seat has no
filesystem at all; it asks with `READ: <path>` and is handed the text, and a
path outside these roots is refused. This is the setting that decides what the
council can see.

## What's here

| File | What it is |
| --- | --- |
| [`codebase-review.yaml`](codebase-review.yaml) | A three-stage review of one or more codebases: agree a debug plan and a dev checklist, execute it, then review what was done. Written for the awkward case where two codebases share modules that have diverged. |

Paste the block into `council.pipelinePresets`, replace everything in angle
brackets, and it appears on the panel at the next call — settings are read per
invocation, so no restart.

## Writing your own

Three things separate a preset that works from one that wastes a round.

**Say what the stages must produce, not just the topic.** A stage told "review
the auth code" returns an essay. A stage told to return items that each name a
file and the failure it causes returns a list you can act on.

**Say what a seat should do when it does not know.** Models fill gaps by
default. An instruction to mark something "not assessed" rather than guess is
worth more than any amount of encouragement to be careful.

**Tell them to ask for the file.** Seats can request source with `READ:` lines,
but a seat that is not told to will answer from memory. If a stage depends on
what the code actually says, say so in the prompt.

Worth adding to any preset that touches a repository: a line saying nothing is
committed or pushed by any seat, and a line asking each agent to name its own
model in what it writes. Several models write into one transcript, and the model
name is the only thing that says which one made a claim.
