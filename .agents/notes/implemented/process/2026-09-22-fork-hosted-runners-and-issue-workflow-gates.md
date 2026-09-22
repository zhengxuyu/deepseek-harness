# Agent Note: Fork hosted-runner fallback and canonical-repository issue gates

Status: implemented

English | [中文](2026-09-22-fork-hosted-runners-and-issue-workflow-gates.zh.md)

## Problem

The required Linux and native Windows CI jobs select the enterprise larger-runner pools, and the two failover switches only redirect them to Blacksmith or the self-hosted VM. A personal fork can reach none of those pools, so every fork pull request queued its required jobs forever and never produced a verdict.

The Issue lifecycle and Issue policy workflows assume the canonical `deepseek-harness/deepseek-harness` repository: the lifecycle job mints a token from an App installation the fork does not have, and the policy preflight reads the canonical repository's pull request by the fork's PR number. Both workflows failed on every fork event, which hid real failures behind permanent red checks.

## Decision

The [CI workflow](../../../../.github/workflows/ci.yml) runner selectors for the three enterprise Linux jobs and the three native Windows jobs add one clause before the enterprise default: when `github.event.repository.fork` is true, the job runs on `ubuntu-latest` or `windows-latest`. Both failover switches keep precedence, so the canonical repository's selection is unchanged, and the aggregate verdict job already targets the standard hosted runner.

The [Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) and [Issue policy](../../../../.github/workflows/issue-policy.yml) jobs gate on `github.repository == 'deepseek-harness/deepseek-harness'`. The gate lives in the workflow file rather than the policy script because both workflows check out the default-branch script, which a fork's default branch may not carry yet, and because the lifecycle token step fails before any script runs.

## Verification

[Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the fork clause in every enterprise selector, evaluate each selector with the fork flag set to prove the hosted fallback wins only when no failover switch applies, and pin the canonical-repository condition on both issue jobs.

## Alternatives considered

**Set the failover variables on the fork.** Both switch values name pools the fork still cannot reach, and adding a third value would grow the canonical selector for a case that is not a failover.

**Guard inside the policy script.** The script runs from the default branch, so the guard would not protect a fork whose default branch predates it, and the lifecycle token step fails before the script starts.

**Remove the enterprise pools from the fork's workflows.** That diverges the fork's CI from upstream on every sync; one additive clause merges cleanly and keeps the canonical behavior byte-for-byte when the flag is false.

## Consequences

Fork pull requests get a real CI verdict on standard hosted runners, at standard-runner speed, and the issue workflows report as skipped instead of failed. The canonical repository's selection is unchanged. The `ci-master.yml` push workflow still names self-hosted and enterprise pools directly, so a push to a fork's default branch queues those jobs; that workflow is not a pull-request gate and stays as upstream ships it.
