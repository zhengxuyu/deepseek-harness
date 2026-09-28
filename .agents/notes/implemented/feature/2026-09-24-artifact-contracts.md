# Agent Note: Output contracts on Team tasks, checked at completion

Status: implemented

English | [中文](2026-09-24-artifact-contracts.zh.md)

## Problem

`complete` on the Team board trusted the caller. A task was done when its owner said so, whatever was on disk: a delivery with one file written before a kill scored as an honest wrong answer, a module split across two teammates scored zero because the scorer takes one file, and a verifier's re-run regressed an output the first attempt had right with nothing recording the earlier version. Nothing declared what a task would produce, so two live tasks could promise the same file, and a teammate started from the Lead's prose rather than from the recorded task.

## Decision

A task declares `outputs`, a list of `ArtifactContract`s: a workspace-relative path, normalized like a write scope and unique within the task, and a kind. `file` must exist and be non-empty; `json` must parse and, with `schema`, validate against the JSON Schema subset `@deepseek-ai/dsh-tools` enforces; `csv` needs a header and a row; `npy` and `image` must start with their format's magic bytes; `python` must be an entry file whose imports name no module defined in the workspace, found by scanning import lines and checking `<name>.py` and `<name>/__init__.py`, so the file runs alone. `complete` checks every non-optional contract through `ctx.fs` against the Lead's working directory and refuses with `TEAM_TASK_OUTPUT_MISSING` naming each unacceptable output; without the filesystem service a task with declared outputs cannot complete (`TEAM_OUTPUTS_UNCHECKABLE`). Accepted outputs are recorded as `artifacts` with bytes and sha256, present only on a completed task and cleared by `reopen`. An output at a path an earlier completed task produced with different content records that task as `supersedes`; with `artifactRoot` configured every completed output is retained under `<artifactRoot>/<team>/<task>/<path>` and the superseded version's retained copy is named as `previousVersion`. A live task cannot declare a path another live task declares (`TEAM_TASK_OUTPUT_CONFLICT`).

`edgeInstructions` records what a task takes from each blocker, keyed by blocker id and validated against `blockedBy`. The `claim` result and the `reassign`-to-member result carry a `brief` composed by the harness from the durable graph: the task's text, each blocker with its status, recorded artifacts, and instruction, and the outputs as the definition of done. A reassigned member also receives the brief as durable mail from the Lead, sent without awaiting delivery. The Team tools require `outputs` on `team_task_create`, accept blocker entries as ids or `{task, instruction}`, and expose the new fields in the task view; the policy text states the rule. All three durable fields are optional properties on the existing version-3 `team/task` payload, acknowledged as a same-version change.

## Alternatives considered

**Mark a claimed completion with missing outputs `failed`.** Rejected because the board has no failed task status, by an earlier decision; refusing `complete` with the missing outputs named is the precondition-failure-as-observation rule, leaves the task in progress for its owner to finish, and never records a completion the workspace does not back.

**Run the Python entry file to prove it stands alone.** Rejected for now because executing a deliverable inside `complete` is a side effect the board should not own and needs a Python in the Team service's process; a static scan of import lines against the workspace catches the split-module case the benchmark measured.

**Retain previous versions inside the workspace.** Rejected because the scorer collects the workspace; retention lives under a configured harness-local root, and a deployment without one still records hashes and supersession.

**Type the contract schema with `dsh-tools`' `JsonSchemaNode` in the shared types.** Rejected because the Team types are read by the browser client and the Remote boundary refuses unconstrained data; the schema is a `Record<string, JsonValue>` and is asserted against the supported subset when the contract is declared.

## Testing

Package tests cover contract normalization and its refusals, the live-path conflict at create and edit, every kind's acceptance and rejection message, schema validation, the standalone scan including relative imports, an empty file, a directory at the path, artifacts recorded with hashes and cleared on reopen, supersession with and without a retained previous version, completion without the filesystem service, edge instructions validated and carried into the brief, the brief returned on claim and mailed on reassign, the contained failure of that mail, the import scanner, the projection's rules for artifacts and instructions, and the tool surface: required outputs, blocker objects, the edited contract list, and the brief in the claim result. The `team-targets` snapshot pins the changed policy text and schemas.

## Consequences

`completed` now means the declared artifacts exist and look like what was declared, which is what settlement, credit over the artifact ancestry, and the scorer all need; a wrong but well-formed artifact still completes. Every task creation names its deliverables, which costs the Lead the declaration up front and refuses a decomposition that never says what it will produce.
