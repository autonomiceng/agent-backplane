# agent-backplane

The shared, self-hosted state plane that autonomous agents attach to. The terms below are
used across the project, one sentence each; avoid the listed alternatives.

**Workspace**: the tenancy boundary that owns a set of schemas, Queues and audit history,
created by humans and never by agents.
_Avoid_: swarm, project, tenant, namespace

**Principal**: a named agent identity that acts inside a Workspace under its own credential
and can create schemas and Queues there but never a new Workspace.
_Avoid_: agent (when meaning the identity), bot, service account

**Run**: one invocation of a Principal, stamped on every statement, Message, blob and
schema change it causes, carrying harness, model and a label when the caller supplies them.
_Avoid_: session, job, execution, trace

**Files**: the operator capability for storing and retrieving blobs with Workspace
permissions and provenance.
_Avoid_: blobs (when naming the capability)

**Functions**: the operator capability for deploying and invoking code with a deploying
Principal's authority and attributed Runs.
_Avoid_: compute (when naming the capability)

**Runtime Identity**: the measured executable bytes used to run a deployed function,
separate from image packaging and control-software evidence.
_Avoid_: image digest, attestation

**Harness**: the environment a Principal executes in, such as Claude Code, Codex or a
hosted bot, which the backplane records but never controls.
_Avoid_: runtime, client, platform

**Approval**: a request, raised by a Principal against a row or Message, that an Approver
must decide before the gated action proceeds.
_Avoid_: review, sign-off, hold, confirmation

**Approver**: a User, or a Principal a User has delegated to, with the right to decide
Approvals in a Workspace.
_Avoid_: reviewer, admin, owner

**User**: a human with a login, the only identity that creates Workspaces and grants
Approver rights.
_Avoid_: operator, human, account

**Queue**: a named, Workspace-scoped stream of Messages that Principals send to and claim
from, never edited in place.
_Avoid_: topic, channel, table, job list

**Message**: a payload sent to a Queue by a Principal with an idempotency key, whose body is
scrubbed after expiry while its envelope, hash and provenance never change.
_Avoid_: job, task, event, item

**Delivery**: one attempt to hand a Message to a consumer, owning the lifecycle scheduled,
ready, leased, begun, held, ambiguous, effect-paused, succeeded, dead-lettered or cancelled;
retries and replays create new Deliveries linked to the original.
_Avoid_: attempt, lease, claim (as a noun), receipt

**Begun** (`begun`): the Delivery state recording that its consumer has begun the
Message's Effect while holding a live Receipt; an unreported outcome after lease expiry
makes the Delivery ambiguous.

**Effect-paused** (`effect-paused`): the Delivery state for a begun Effect whose consuming
Principal was revoked by a User, leaving the outcome unresolved and the Delivery undispatchable.

**Receipt**: the opaque, expiring token a consumer gets when it claims a Delivery, required
by every ack, nack, renew or hold.
_Avoid_: lease token, handle, lock, visibility timeout

**Migration**: an imperative SQL change to a Workspace's schema, submitted with the schema
revision it was written against, applied once, recorded forever and never reverted.
_Avoid_: push, sync, schema update, patch

**Effect**: an irreversible action in the outside world that a Message asks for, at most one
per Message, identified by an Effect Key that survives retries and replays.
_Avoid_: side effect, action, external call

**Reconciliation**: a recorded decision, with evidence, about whether an Effect happened
after a Delivery became ambiguous: applied, not applied or unknown.
_Avoid_: retry, resolution, cleanup

**Audit Event**: one immutable record of something that happened in a Workspace, stamped
with the Principal, Run or User that caused it; the ordered stream of Audit Events is the
only event stream the backplane has.
_Avoid_: log line, change event, notification

**Checkpoint**: a complete, fenced recovery set for the local deployment (PostgreSQL base
backup and WAL, durable filesystem stores, the server image and a manifest with identity,
audit heads and checksums), named by its UTC capture timestamp.
_Avoid_: snapshot (when meaning the coordinated recovery set)

**Bootstrap**: `python3 scripts/bootstrap.py`, the host entrypoint that records the Compose
selection in `.env`, generates secrets once, creates the Platform Network and volumes,
starts the stack and exports the enrollment capability; profiles `blobs`, `compute` and
`edge` are opt-in and a recorded selection is preserved on rerun.
_Avoid_: prepare, preparation, installer

**Enrollment**: creating the first User from the capability file with `bp bootstrap`, run
through `compose.enroll.yaml` inside the server image; the claim is permanent (ADR-0020).
_Avoid_: sign-up, onboarding, registration

**Status Document**: the public Status v2 document the server serves at `/status.json` in
every access mode, built from configuration through a closed projection, listing each
component's configured image, version, profile state, health path and the newest
Checkpoint the server knew of, never the operations document.
_Avoid_: status observation, operations document (for the public form)
