// Bootstrap's pure checkpoint transitions and version-1 disk boundary.
import { record } from "./http.ts";
import { uuid } from "./credential-file.ts";
type Base = { version: 1; url: string; email: string };
type Field = "userId" | "workspaceId" | "principalId" | "credentialFile";
type State<S extends string | undefined, F> = Readonly<Base & { step: S } & F & { [K in Exclude<Field, keyof F>]?: never }>;
type U = { userId: string };
type W = U & { workspaceId: string };
type P = W & { principalId: string };
type K = P & { credentialFile: string };
export type BootstrapCheckpoint =
  | State<undefined, Record<never, never>> | State<"enrollment:in-flight", Record<never, never>>
  | State<"enrollment:saved", U> | State<"workspace:in-flight", U>
  | State<"workspace:saved", W> | State<"principal:in-flight", W> | State<"principal:saved", P>
  | State<"key:in-flight", K> | State<"key:ambiguous", K> | State<"key:saved", K>;
type At<S extends BootstrapCheckpoint["step"]> = Extract<BootstrapCheckpoint, { step: S }>;
type Next<T> = T | { error: "checkpoint_transition_invalid" };
type Invalid = { error: "checkpoint_invalid"; reason: string };
type KeyOutcome = { kind: "saved"; credentialFile: string } | { kind: "ambiguous" }
  | { kind: "unsent"; reason: "transport_unsent" | "user_session_required" | "unsafe_session_file" };
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
function validSource(source: unknown, step: BootstrapCheckpoint["step"]) {
  if (!record(source) || source.step !== step) return false;
  const parsed = checkpointValue(source);
  return !("error" in parsed) && Reflect.ownKeys(source).length === Reflect.ownKeys(parsed).length
    && Object.entries(parsed).every(([key, value]) => Object.hasOwn(source, key) && source[key] === value);
}
export function fromInitial(s: At<undefined>): Next<At<"enrollment:in-flight">> {
  return validSource(s, undefined) ? Object.freeze({ ...s, step: "enrollment:in-flight" }) : { error: "checkpoint_transition_invalid" };
}
export function fromEnrollmentInFlight(s: At<"enrollment:in-flight">, userId: string): Next<At<"enrollment:saved">> {
  if (!validSource(s, "enrollment:in-flight")) return { error: "checkpoint_transition_invalid" };
  return nonempty(userId) ? Object.freeze({ ...s, step: "enrollment:saved", userId }) : { error: "checkpoint_transition_invalid" };
}
export function fromEnrollmentSaved(s: At<"enrollment:saved">): Next<At<"workspace:in-flight">> {
  return validSource(s, "enrollment:saved") ? Object.freeze({ ...s, step: "workspace:in-flight" }) : { error: "checkpoint_transition_invalid" };
}
export function fromWorkspaceInFlight(s: At<"workspace:in-flight">, workspaceId: string): Next<At<"workspace:saved">> {
  if (!validSource(s, "workspace:in-flight")) return { error: "checkpoint_transition_invalid" };
  return uuid(workspaceId.toLowerCase()) ? Object.freeze({ ...s, step: "workspace:saved", workspaceId: workspaceId.toLowerCase() }) : { error: "checkpoint_transition_invalid" };
}
export function fromWorkspaceSaved(s: At<"workspace:saved">): Next<At<"principal:in-flight">> {
  return validSource(s, "workspace:saved") ? Object.freeze({ ...s, step: "principal:in-flight" }) : { error: "checkpoint_transition_invalid" };
}
export function fromPrincipalInFlight(s: At<"principal:in-flight">, principalId: string): Next<At<"principal:saved">> {
  if (!validSource(s, "principal:in-flight")) return { error: "checkpoint_transition_invalid" };
  return uuid(principalId.toLowerCase()) ? Object.freeze({ ...s, step: "principal:saved", principalId: principalId.toLowerCase() }) : { error: "checkpoint_transition_invalid" };
}
export function fromPrincipalSaved(s: At<"principal:saved">, credentialFile: string): Next<At<"key:in-flight">> {
  if (!validSource(s, "principal:saved")) return { error: "checkpoint_transition_invalid" };
  return nonempty(credentialFile) ? Object.freeze({ ...s, step: "key:in-flight", credentialFile }) : { error: "checkpoint_transition_invalid" };
}
export function fromKeyInFlight(s: At<"key:in-flight">, outcome: KeyOutcome): Next<At<"key:saved" | "key:ambiguous" | "principal:saved">> {
  if (!validSource(s, "key:in-flight")) return { error: "checkpoint_transition_invalid" };
  switch (outcome.kind) {
    case "saved": return nonempty(outcome.credentialFile) ? Object.freeze({ ...s, step: "key:saved", credentialFile: outcome.credentialFile }) : { error: "checkpoint_transition_invalid" };
    case "ambiguous": return Object.freeze({ ...s, step: "key:ambiguous" });
    case "unsent": {
      if (!["transport_unsent", "user_session_required", "unsafe_session_file"].includes(outcome.reason)) return { error: "checkpoint_transition_invalid" };
      const { credentialFile: _, ...identity } = s;
      return Object.freeze({ ...identity, step: "principal:saved" });
    }
    default: { const unreachable: never = outcome; return unreachable; }
  }
}
export function fromKeyAmbiguous(s: At<"key:ambiguous">, verifiedCredentialFile: string): Next<At<"key:saved">> {
  if (!validSource(s, "key:ambiguous")) return { error: "checkpoint_transition_invalid" };
  return nonempty(verifiedCredentialFile) ? Object.freeze({ ...s, step: "key:saved", credentialFile: verifiedCredentialFile }) : { error: "checkpoint_transition_invalid" };
}
export function fromKeySaved(s: At<"key:saved">, verifiedCredentialFile: string): Next<At<"key:saved">> {
  if (!validSource(s, "key:saved")) return { error: "checkpoint_transition_invalid" };
  return nonempty(verifiedCredentialFile) ? Object.freeze({ ...s, credentialFile: verifiedCredentialFile }) : { error: "checkpoint_transition_invalid" };
}
export function parseCheckpoint(bytes: string): BootstrapCheckpoint | Invalid {
  try { return checkpointValue(JSON.parse(bytes)); } catch { return { error: "checkpoint_invalid", reason: "malformed JSON" }; }
}
function checkpointValue(value: unknown): BootstrapCheckpoint | Invalid {
  const invalid = (reason: string): Invalid => ({ error: "checkpoint_invalid", reason });
  if (!record(value) || value.version !== 1) return invalid("expected version 1 object");
  if (Object.keys(value).some(k => !["version", "url", "email", "step", "userId", "workspaceId", "principalId", "credentialFile", "recoveryFile"].includes(k))) return invalid("unknown field or inline credential");
  try { if (typeof value.url !== "string" || !["http:", "https:"].includes(new URL(value.url).protocol) || new URL(value.url).origin !== value.url) return invalid("url must be a canonical origin"); }
  catch { return invalid("url must be a canonical origin"); }
  if (typeof value.url !== "string" || !nonempty(value.email) || value.email !== value.email.trim().toLowerCase()) return invalid("email must be normalized and nonempty");
  for (const field of ["credentialFile", "recoveryFile"]) if (value[field] !== undefined && !nonempty(value[field])) return invalid("invalid credential-file reference");
  if (value.credentialFile !== undefined && value.recoveryFile !== undefined && value.credentialFile !== value.recoveryFile) return invalid("conflicting credential-file references");
  const base: Base = { version: 1, url: value.url, email: value.email }, step = value.step;
  const userId = value.userId, workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.toLowerCase() : value.workspaceId;
  const principalId = typeof value.principalId === "string" ? value.principalId.toLowerCase() : value.principalId, credentialFile = value.credentialFile ?? value.recoveryFile;
  switch (step) {
    case undefined: case "enrollment:in-flight":
      if (userId !== undefined || workspaceId !== undefined || principalId !== undefined) return invalid("unexpected ids before enrollment");
      return Object.freeze({ ...base, step });
    case "enrollment:saved": case "workspace:in-flight":
      if (!nonempty(userId) || workspaceId !== undefined || principalId !== undefined) return invalid("expected userId only");
      return Object.freeze({ ...base, step, userId });
    case "workspace:saved": case "principal:in-flight":
      if (!nonempty(userId) || !uuid(workspaceId) || principalId !== undefined) return invalid("expected userId and Workspace UUID only");
      return Object.freeze({ ...base, step, userId, workspaceId });
    case "principal:saved":
      if (!nonempty(userId) || !uuid(workspaceId) || !uuid(principalId)) return invalid("expected userId, Workspace and Principal UUIDs");
      return Object.freeze({ ...base, step, userId, workspaceId, principalId });
    case "key:in-flight": case "key:ambiguous": case "key:saved":
      if (!nonempty(userId) || !uuid(workspaceId) || !uuid(principalId) || !nonempty(credentialFile)) return invalid("expected all ids and credential-file reference");
      return Object.freeze({ ...base, step, userId, workspaceId, principalId, credentialFile });
    default: return invalid("unknown step");
  }
}
export function serializeCheckpoint(state: BootstrapCheckpoint): string {
  const base = { version: state.version, url: state.url, email: state.email };
  switch (state.step) {
    case undefined: return JSON.stringify(base);
    case "enrollment:in-flight": return JSON.stringify({ ...base, step: state.step });
    case "enrollment:saved": case "workspace:in-flight": return JSON.stringify({ ...base, step: state.step, userId: state.userId });
    case "workspace:saved": case "principal:in-flight": return JSON.stringify({ ...base, step: state.step, userId: state.userId, workspaceId: state.workspaceId });
    case "principal:saved": return JSON.stringify({ ...base, step: state.step, userId: state.userId, workspaceId: state.workspaceId, principalId: state.principalId });
    case "key:in-flight": case "key:ambiguous": case "key:saved": return JSON.stringify({ ...base, step: state.step, userId: state.userId, workspaceId: state.workspaceId, principalId: state.principalId, credentialFile: state.credentialFile });
    default: { const unreachable: never = state; return unreachable; }
  }
}
