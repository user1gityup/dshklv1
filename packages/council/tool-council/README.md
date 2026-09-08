# Council tools and API staging

English | [中文](README.zh.md)

Council, swarm, pipeline and proposal tools coordinate CLI and API seats. Plan approval remains separate from filesystem write authorization.

After the human selects workspace-write in the session permission control and sends exactly go, `stage_work` saves already-produced API code without a CLI or model call. Its `files_json` argument maps relative paths to complete text. Each batch creates `<session workspace>/.dsh-staging/<batch id>` and reports its files. Limits are 100 files and 1,000,000 input characters. Absolute paths, traversal and conflicting Windows spellings are rejected. Failures report partial output.

Proposal rounds also use the DSH filesystem sandbox and .dsh-staging, separated by run and seat. The legacy workRoot setting cannot redirect writes outside the workspace. Local CLI permissions and launch arguments are unchanged; API agents can stage work while those seats are unavailable.

## Model Experience

`council.swarmProfile` selects `economy` or `fastest` in the roster. Economy contests every unit with at least two eligible free seats and requires paid review. Escalation allows one paid candidate and at most two paid reviews per unit. Fastest uses one paid worker per unit across parallel dependency waves. Both respect worker kinds; reviewers need review capability. UI units prefer an eligible selected sample author. No profile preserves existing routing.

Graphs carry `acceptance`, `files`, and `tier` (`ui` or `general`). Economy requires acceptance conditions. Units cannot target the same file. Candidate files use the existing sandbox permission gate and separate run/unit/seat directories. Failed review blocks dependants. Model review does not run tests or apply files.

Approval preserves the profile. Presets accept `mode: council | economy | fastest` without authorizing execution. Pipeline planning and review use paid seats in execution modes. Estimates include candidate reads, selection, paid review and bounded fallback; unpriced calls remain explicit.

Plan votes are unchanged. Rival excerpts endorsed by two distinct seats may be integrated by the original winner. Failed integration preserves the original plan.

The tool schema explains staging and its approval requirement. Results identify candidate files for later implementation, without applying them to another repository. Staging adds no model call; generation of the contents remains normally billed. The new schema changes the request prefix after reload.

## Known Limitations and Deferred Work

Staging does not execute, commit, queue pushes or retry unavailable seats. A new session requires new approval and go. This does not sandbox local CLI seats or strengthen Windows process confinement.
