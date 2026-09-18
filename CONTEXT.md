# agent-backplane

The shared, self-hosted state plane that autonomous agents attach to. This glossary defines the terms used across the project.

## Language

**Workspace**:
The tenancy boundary that owns a set of schemas, queues, and audit history. Created by humans, never by agents.
_Avoid_: Swarm, project, tenant, namespace

**Principal**:
A named agent identity that acts inside a Workspace under its own credential. Principals can create schemas and queues within their Workspace but never a new Workspace.
_Avoid_: Agent (when meaning the identity), bot, service account

**Run**:
One invocation of a Principal. Every statement, message, blob and schema change is stamped with the Run that caused it. Carries harness, model and a label when the caller supplies them; extra facts live in open-ended metadata.
_Avoid_: Session, job, execution, trace

**Harness**:
The environment a Principal executes in, such as Claude Code, Codex, or a hosted bot. The backplane never controls a Harness; it only records which one a Run came from.
_Avoid_: Runtime, client, platform

**Approval**:
A request, raised by a Principal against a row or message, that an Approver must decide before the gated action proceeds.
_Avoid_: Review, sign-off, hold, confirmation

**Approver**:
A User or a Principal granted the right to decide Approvals in a Workspace. A human may delegate approving to a trusted Principal.
_Avoid_: Reviewer, admin, owner

**User**:
A human with a login. Users create Workspaces and are the only identities that can grant Approver rights.
_Avoid_: Operator, human, account

**Queue**:
A named, Workspace-scoped stream of Messages that Principals send to and claim from. Messages are never edited in place.
_Avoid_: Topic, channel, table, job list

**Message**:
A payload sent to a Queue by a Principal, carrying an idempotency key. Its stored body is scrubbed after expiry; its envelope, hash and provenance, including the producer's Principal and Run, never change.
_Avoid_: Job, task, event, item

**Delivery**:
One attempt to hand a Message to a consumer. A Delivery owns the lifecycle: scheduled, ready, leased, begun, held, ambiguous, effect-paused, succeeded, dead-lettered, or cancelled. Retries and replays create new Deliveries linked to the original.
_Avoid_: Attempt, lease, claim (as a noun), receipt

**Begun** (`begun`):
A Delivery state recording that its consumer has begun the Message’s Effect while holding a live Receipt. An unreported outcome after lease expiry makes the Delivery ambiguous.

**Effect-paused** (`effect-paused`):
A Delivery state for a begun Effect whose consuming Principal was revoked by a User. The Effect’s outcome remains unresolved and the Delivery cannot be dispatched automatically.

**Receipt**:
The opaque, expiring token a consumer gets when it claims a Delivery. Every ack, nack, renew or hold must present a valid Receipt; an expired Receipt can do nothing.
_Avoid_: Lease token, handle, lock, visibility timeout

**Migration**:
An imperative SQL change to a Workspace's schema, submitted with the schema revision it was written against. Applied once, recorded forever, never reverted, only followed by another Migration.
_Avoid_: Push, sync, schema update, patch

**Effect**:
An irreversible action in the outside world that a Message asks for, such as submitting a form or sending an email. One Message carries at most one Effect, identified by an Effect Key that survives retries and replays.
_Avoid_: Side effect, action, external call

**Reconciliation**:
A recorded decision, with evidence, about whether an Effect happened after a Delivery became ambiguous. Outcomes are applied, not applied, or unknown.
_Avoid_: Retry, resolution, cleanup

**Audit Event**:
One immutable record of something that happened in a Workspace, stamped with the Principal, Run, or User that caused it. The ordered stream of Audit Events is the only event stream the backplane has.
_Avoid_: Log line, change event, notification

**Checkpoint**:
A complete, fenced recovery set for the local deployment: PostgreSQL base backup and required WAL, durable filesystem stores, the server image, and a manifest with identity, audit heads and checksums. Named by its UTC capture timestamp.
_Avoid_: Snapshot (when meaning the coordinated recovery set)
