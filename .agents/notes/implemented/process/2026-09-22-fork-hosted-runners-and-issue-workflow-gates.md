# Agent Note: Fork hosted-runner fallback and canonical-repository issue gates

Status: implemented

English | [中文](2026-09-22-fork-hosted-runners-and-issue-workflow-gates.zh.md)

## Problem

The required Linux and native Windows CI jobs select the enterprise larger-runner pools, and the two failover switches only redirect them to Blacksmith or the self-hosted VM. A personal fork can reach none of those pools, so every fork pull request queued its required jobs forever and never produced a verdict.

The Issue lifecycle and Issue policy workflows assume the canonical `deepseek-harness/deepseek-harness` repository: the lifecycle job mints a token from an App installation the fork does not have, and the policy preflight reads the canonical repository's pull request by the fork's PR number. Both workflows failed on every fork event, which hid real failures behind permanent red checks.

## Decision

The [CI workflow](../../../../.github/workflows/ci.yml) runner selectors for the three enterprise Linux jobs and the three native Windows jobs add one clause before the enterprise default: when `github.event.repository.fork` is true, the job runs on `ubuntu-latest` or `windows-latest`. Both failover switches keep precedence, so the canonical repository's selection is unchanged, and the aggregate verdict job already targets the standard hosted runner.

The [Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) job gates on `github.repository == 'deepseek-harness/deepseek-harness'` in the workflow file, because its token step fails before any script runs. The [Issue policy](../../../../.github/workflows/issue-policy.yml) job stays unconditional, as its trusted-preflight contract requires; instead the preflight script exempts an event whose `repository.full_name` is not the canonical repository, writing `exempt=true`, `needs-project=false`, and `legacy-automated=true` so the token and validation steps skip without any API read. The script runs from the default branch, so a fork gains the exemption once its default branch carries this change.

## Verification

[Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the fork clause in every enterprise selector, evaluate each selector with the fork flag set to prove the hosted fallback wins only when no failover switch applies, and pin the canonical-repository condition on the lifecycle job. [Issue-management tests](../../../../.github/issue-management/policy.test.mjs) pin that a non-canonical event is exempt without a request and that the canonical repository still runs the full preflight.

## Alternatives considered

**Set the failover variables on the fork.** Both switch values name pools the fork still cannot reach, and adding a third value would grow the canonical selector for a case that is not a failover.

**Gate the policy job in the workflow file too.** The policy workflow's tests require the job and its preflight to stay unconditional so a required check can never be skipped by a workflow edit; the script-level exemption keeps that contract and still costs a fork nothing but one checkout.

**Remove the enterprise pools from the fork's workflows.** That diverges the fork's CI from upstream on every sync; one additive clause merges cleanly and keeps the canonical behavior byte-for-byte when the flag is false.

## Consequences

Fork pull requests get a real CI verdict on standard hosted runners, at standard-runner speed, and the issue workflows report as skipped instead of failed. The DeepSeek-defaults headless fixture widens its stream idle budget from 150 ms to 1 s, matching the pi-ai defaults fixture, because a standard runner can stall the fixture server's 60 ms keep-alives long enough to trigger a retry and break the request count. The canonical repository's selection is unchanged. The `ci-master.yml` push workflow still names self-hosted and enterprise pools directly, so a push to a fork's default branch queues those jobs; that workflow is not a pull-request gate and stays as upstream ships it.
