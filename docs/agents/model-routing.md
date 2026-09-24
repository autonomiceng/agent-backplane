# Model routing for agent-backplane

Routing for every delegation from this repo, plus the risk paths and the brief templates every delegation carries. Launch mechanics: devloop `docs/agents/skills/codex-exec/SKILL.md`.

## Routing

Decided by the Owner 2026-09-16 for the three stack repos (agent-backplane, llm-gateway-stack, observability-stack).

| Work | Model + effort | Verified by |
| --- | --- | --- |
| Orchestration, design, plans, prose, UI, AGENTS.md | Claude Fable 5.1 | gpt-6 high |
| Final review of a risk path (below) or anything touching persistent data | Claude Fable 5.1 | none; this is the last gate |
| Red team, design review, high-risk implementation (risk paths, Compose, bootstrap, migrations) | gpt-6 high | Claude Fable 5.1 |
| Routine and mechanical implementation | gpt-5.6-sol medium | gpt-6 medium or Claude Fable 5.1 |

Rules:

- The verifier is from a different model family than the implementer when possible. If tokens or a service are unavailable, use the best available and say so in the report.
- A verifier never sees the implementer's reasoning, only the diff and the brief. Refutation mandate, at most ten findings, each with an exact fix.
- At most two concurrent workers on one host.
- Launch durable jobs through `devloop agent` (skill: `codex-exec`) and wait in the background.
- Report every delegation as task, model, effort.

## Risk paths

A slice that touches any of these is high risk and gets a Fable review before merge:

- Run context propagation and audit stamping (ADR-0001)
- The SQL executor, statement allowlist, search_path, executor role (ADR-0004)
- Receipt validation and Delivery state transitions (ADR-0005)
- The transaction endpoint and its idempotency key (ADR-0011)
- Migration apply and compare-and-swap (ADR-0004)
- API key hashing, revocation, Principal suspension (ADR-0010)
- Effect Keys, ambiguous state, Reconciliation (ADR-0012)
- Approval binding and self-approval rules (ADR-0007)

## The short leash for GPT models

Observed in devloop: sol and astra overproduce tests, widen scope, and install shims that make a check pass. Every implementation brief therefore states:

- An enumerated test list with a numeric budget. Overage without a one-line justification fails the slice.
- Explicit non-goals. Anything outside them is a deviation and must be declared.
- No new dependencies without approval.
- No shims, wrappers or PATH tricks around a failing check. The reviewer re-runs every check unshimmed.
- The exact acceptance commands. Green claims are re-run by the orchestrator.
- The slice's binding ADRs by number. Changing ratified semantics is declared, never done quietly.

Paste both blocks verbatim into every implementation delegation:

> CODE DISCIPLINE: Make the smallest spec-complete change; add no speculative abstraction and no dependency without approval; match repo idiom, strictness, and naming; comment only inexpressible constraints; extract shared code on its third occurrence; no shims or wrappers around a failing check; report every spec deviation and exact verification commands and counts.

> TEST DISCIPLINE: Write only the enumerated tests (budget: N cases; any overage requires a one-line justification); each test names and uniquely detects a plausible defect; assert observable outcomes against a real Postgres, never call sequences or mocks of the database; no permutation sweeps or tests of libraries, logs, or typechecked facts; consolidate scenarios with related postconditions.

## Implementation brief template

```text
SLICE <id> - <title>. Workspace: <absolute worktree path>. Branch: <name>.
Read first: CONTEXT.md, docs/DESIGN.md, docs/adr/<binding ADRs>, AGENTS.md "Where code lives".

VALUE: <one sentence, what becomes observable>.
TOUCHES: <module paths>. Do not edit: <shared files owned by the orchestrator>.
DEPENDS ON: <slice ids, already merged>.
NON-GOALS: <list>.
TESTS (budget N): 1. <case: defect it detects> ...
DONE WHEN: <exact command or request and expected output>.
ACCEPTANCE: <exact commands: typecheck, lint, test>.
REPORT: deviations, commands run with counts, anything you could not verify.

<CODE DISCIPLINE block>
<TEST DISCIPLINE block>
```

## Review brief template

```text
BLIND REVIEW - slice <id>, <worktree path>, diff <base>..HEAD. Read-only.
Mandate: refutation. Assume the green claims are wrong and try to show it.
Re-run: <acceptance commands>, unshimmed.
Focus: <risk path questions for this slice>.
Report at most 10 findings, each with severity, file:line, defect, exact fix. Absence of findings after real effort is a valid result.
```
