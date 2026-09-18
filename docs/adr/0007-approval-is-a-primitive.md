---
status: accepted
date: 2026-09-14
---
# Approval is a first-class primitive

A Principal can request an Approval against a row, a message or a migration. An Approver decides it. Approvers are Users, or Principals a User has delegated to (for example a chief-of-staff agent). A held message leaves dispatch entirely; approval grants a new claim rather than reviving the old lease. Approvals bind to the exact version of the thing approved and expire. Self-approval is off by default.

Why: human approval before irreversible actions was the first requirement every consumer raised, and a backend primitive with an inbox in the dashboard is something no competitor offers.

Limit, stated plainly: Approval only governs actions the backplane mediates. An agent with its own credentials to an outside system can still act.
