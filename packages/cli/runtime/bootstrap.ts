// Resumable first-User provisioning; every uncertain mutation retains durable recovery evidence.
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { CliError, credentials } from "./credentials.ts";
import { credentialValue, privateRead, privateWrite, privateLock, canonicalUuid } from "./credential-file.ts";
import { safeDirectory } from "./secure-directory.ts";
import { login, sessionHeaders } from "./login.ts";
import { request, json, record } from "./http.ts";
import { type BootstrapCheckpoint, parseCheckpoint, serializeCheckpoint, fromInitial, fromEnrollmentInFlight, fromEnrollmentSaved, fromWorkspaceInFlight, fromWorkspaceSaved, fromPrincipalInFlight, fromPrincipalSaved, fromKeyInFlight, fromKeyAmbiguous, fromKeySaved } from "./bootstrap-checkpoint.ts";
import type { Execution } from "./execute.ts";
export const bootstrapHelp = "bp bootstrap [--url URL] --email EMAIL --capability-file PATH [--workspace-id UUID] [--principal-id UUID] [--recover-key-file PATH]; password: terminal or BP_BOOTSTRAP_PASSWORD";
export async function bootstrap(argv: string[], io: Execution, invoke: (id: string, flags: string[], body?: unknown) => Promise<unknown>): Promise<unknown> {
  const options: import("node:util").ParseArgsConfig["options"] = Object.fromEntries(["url", "email", "capability-file", "workspace-id", "principal-id", "recover-key-file"].map(k => [k, { type: "string" }]));
  const parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(parsed.values)) { if (typeof value !== "string") throw new CliError("invalid_arguments", 1); values[key] = value; }
  for (const flag of ["workspace-id", "principal-id"]) if (values[flag] !== undefined) values[flag] = canonicalUuid(values[flag]);
  if (values.url && io.env.BP_URL && values.url !== io.env.BP_URL) throw new CliError("url_conflict", 1);
  io.env = { ...io.env, BP_USER_PASSWORD: undefined, BP_URL: values.url ?? io.env.BP_URL ?? "http://localhost:3000", BP_USER_EMAIL: (values.email ?? io.env.BP_USER_EMAIL)?.trim().toLowerCase() };
  const config = (() => { try { return credentials(io.env, "user", undefined); } catch { throw new CliError("invalid_url", 1); } })(), origin = new URL(config.url).origin;
  if (config.url !== origin || io.env.BP_AUTH_URL && io.env.BP_AUTH_URL !== origin) throw new CliError("origin_conflict", 1);
  const directory = join(dirname(config.directory), "bootstrap"), digest = createHash("sha256").update(origin).digest("hex");
  await safeDirectory(dirname(directory)); await safeDirectory(directory);
  const path = join(directory, `${digest}.json`), credentialPath = join(directory, `${digest}.credentials.json`);
  const unlock = await privateLock(`${path}.lock`);
  let failed = false;
  try {
    const previous = await privateRead(path);
    const parsedState = parseCheckpoint(previous ?? JSON.stringify({ version: 1, url: origin, email: io.env.BP_USER_EMAIL }));
    if ("error" in parsedState) throw new CliError(parsedState.error, 1, undefined, { reason: parsedState.reason,
      recovery: "Preserve checkpoint and credential files. Reconcile IDs against server records and the matching User session; repair from evidence or restore a known-good checkpoint." });
    let state = parsedState;
    if (state.url !== origin || io.env.BP_USER_EMAIL && state.email !== io.env.BP_USER_EMAIL) throw new CliError("checkpoint_conflict", 2);
    io.env.BP_USER_EMAIL = state.email;
    if (values["workspace-id"] && state.workspaceId && values["workspace-id"] !== state.workspaceId
      || values["principal-id"] && state.principalId && values["principal-id"] !== state.principalId) throw new CliError("adoption_conflict", 2);
    if (previous === undefined) await privateWrite(path, serializeCheckpoint(state));
    const save = async <T extends BootstrapCheckpoint>(next: T | { error: "checkpoint_transition_invalid" }): Promise<T> => {
      if ("error" in next) throw new CliError(next.error, 2);
      await privateWrite(path, serializeCheckpoint(next), true); return next;
    };
    const flags = () => ["--workspace-id", String(state.workspaceId), "--principal-id", String(state.principalId)];
    const ambiguous = () => {
      const base = `bp bootstrap --url '${origin}'`;
      throw new CliError("key_ambiguous", 3, undefined, { workspaceId: state.workspaceId, principalId: state.principalId, commands: [
        `BP_URL='${origin}' BP_USER_EMAIL=USER_EMAIL bp auth issue-principal-key ${flags().join(" ")} --credential-out NEW_PRIVATE_FILE`, `${base} --recover-key-file NEW_PRIVATE_FILE`] });
    };
    const verify = async (value: unknown) => {
      const key = credentialValue(value);
      if (key.url !== origin || key.workspaceId !== state.workspaceId || key.principalId !== state.principalId) throw new CliError("credential_identity_conflict", 2);
      const response = await request(credentials({ ...io.env, BP_KEY: key.key }, "principal", key.workspaceId), `/api/v1/workspaces/${key.workspaceId}/whoami`, "GET", undefined, new Headers(), undefined, io.signal, io.transport).catch(() => { throw new CliError("server_not_ready", 2); });
      const identity = await json(response);
      if (!response.ok || !record(identity) || identity.workspaceId !== key.workspaceId || identity.principalId !== key.principalId) throw new CliError("saved_credential_invalid", 2);
      return key;
    };
    const result = (key: Awaited<ReturnType<typeof verify>>, savedPath: string) => ({
      workspaceId: key.workspaceId, principalId: key.principalId, credentialsFile: savedPath,
      mcpServers: { backplane: { command: "bp", args: ["mcp"], env: { BP_CREDENTIALS_FILE: savedPath } } },
    });
    const finish = async (savedPath: string) => {
      const saved = await privateRead(savedPath);
      if (!saved) throw new CliError("credential_file_recovery_required", 2);
      return result(await verify(JSON.parse(saved)), savedPath);
    };
    let userId: string | undefined;
    const authenticate = async () => {
      if (userId) return userId;
      let session: unknown;
      try {
        const headers = await sessionHeaders(config, io.env);
        const response = await request(config, "/api/auth/get-session", "GET", undefined, headers, undefined, io.signal, io.transport);
        if (response.ok) session = await json(response);
      } catch { /* Missing or expired sessions resume through ordinary sign-in. */ }
      if (!record(session) || !record(session.user)) {
        io.env.BP_USER_PASSWORD = await bootstrapPassword(io);
        await login(io).catch(() => { throw new CliError("identity_recovery_required", 2); });
        const response = await request(config, "/api/auth/get-session", "GET", undefined, await sessionHeaders(config, io.env), undefined, io.signal, io.transport);
        session = await json(response);
      }
      if (!record(session) || !record(session.user) || typeof session.user.id !== "string" || session.user.email !== state.email
        || state.userId && state.userId !== session.user.id) throw new CliError("session_identity_conflict", 2);
      userId = session.user.id; return userId;
    };
    const validatePrincipal = async (workspaceId: string, principalId?: string) => {
      let after: string | undefined, found = false;
      do {
        const page = await invoke("listPrincipals", ["--workspace-id", workspaceId, ...(after ? ["--after", after] : [])]);
        if (!record(page) || !Array.isArray(page.items)) throw new CliError("principal_list_invalid", 2);
        found ||= page.items.some(item => record(item) && item.id === principalId && item.status === "active");
        after = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      } while (principalId && !found && after);
      if (principalId && !found) throw new CliError("principal_adoption_invalid", 2);
    };
    const ready = state.credentialFile === undefined ? await readiness(io) : undefined;
    if (ready === "pending" && state.userId) throw new CliError("enrollment_state_conflict", 2);
    for (;;) {
      if (state.credentialFile === undefined && values["recover-key-file"]) throw new CliError("checkpoint_recovery_required", 2);
      switch (state.step) {
        case undefined: case "enrollment:in-flight": {
          if (ready === "pending") {
            const capability = values["capability-file"] && await privateRead(values["capability-file"]);
            if (!capability || !/^[a-f0-9]{64}$/.test(capability.trim())) throw new CliError("capability_file_required", 2);
            const password = await bootstrapPassword(io);
            if (state.step === undefined) state = await save(fromInitial(state));
            const enrolling = state;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const enrolled = await invoke("enrollFirstUser", [], { email: state.email, password, capability: capability.trim() });
                if (!record(enrolled) || typeof enrolled.userId !== "string") throw new CliError("enrollment_response_invalid", 2);
                state = await save(fromEnrollmentInFlight(enrolling, enrolled.userId)); break;
              } catch (e) {
                if (e instanceof CliError && e.status && e.status >= 400 && e.status < 500) throw new CliError(e.error, e.status === 403 || e.status === 409 ? 2 : 1, e.status);
                if (await readiness(io) === "claimed") break;
                if (attempt === 1) throw new CliError("enrollment_recovery_required", 2);
              }
            }
          }
          if (state.step === undefined) state = await save(fromInitial(state));
          if (state.step === "enrollment:in-flight") state = await save(fromEnrollmentInFlight(state, await authenticate()));
          continue;
        }
        case "enrollment:saved":
          await authenticate(); state = await save(fromEnrollmentSaved(state));
          // This invocation owns the fresh in-flight state and may create the Workspace.
          if (!values["workspace-id"]) {
            const value = await invoke("createWorkspace", [], { name: "default" }).catch(() => { throw new CliError("workspace_adoption_required", 2); });
            if (!record(value) || typeof value.id !== "string") throw new CliError("workspace_adoption_required", 2);
            state = await save(fromWorkspaceInFlight(state, value.id));
          }
          continue;
        case "workspace:in-flight": {
          await authenticate();
          const id = values["workspace-id"];
          if (!id) throw new CliError("workspace_adoption_required", 2, undefined, { flag: "--workspace-id" });
          await validatePrincipal(id); state = await save(fromWorkspaceInFlight(state, id)); continue;
        }
        case "workspace:saved":
          await authenticate(); await validatePrincipal(state.workspaceId); state = await save(fromWorkspaceSaved(state));
          if (!values["principal-id"]) {
            const value = await invoke("createPrincipal", flags().slice(0, 2), { name: "default" }).catch(() => { throw new CliError("principal_adoption_required", 2); });
            if (!record(value) || typeof value.id !== "string") throw new CliError("principal_adoption_required", 2);
            state = await save(fromPrincipalInFlight(state, value.id));
          }
          continue;
        case "principal:in-flight": {
          await authenticate();
          const id = values["principal-id"];
          if (!id) throw new CliError("principal_adoption_required", 2, undefined, { flag: "--principal-id" });
          await validatePrincipal(state.workspaceId, id); state = await save(fromPrincipalInFlight(state, id)); continue;
        }
        case "principal:saved": {
          await authenticate(); await validatePrincipal(state.workspaceId, state.principalId);
          state = await save(fromPrincipalSaved(state, credentialPath));
          let invoked = false;
          try {
            await sessionHeaders(config, io.env);
            invoked = true;
            const metadata = await invoke("getPrincipalKey", flags());
            if (metadata !== null) { state = await save(fromKeyInFlight(state, { kind: "ambiguous" })); return ambiguous(); }
            invoked = false; await sessionHeaders(config, io.env); invoked = true;
            const issued = await invoke("issuePrincipalKey", flags());
            if (!record(issued)) throw new CliError("invalid_response", 1);
            const key = credentialValue({ url: origin, workspaceId: state.workspaceId, principalId: state.principalId, key: issued.key });
            if (issued.prefix !== key.key.split("_")[1] || typeof issued.createdAt !== "string" || !Number.isFinite(Date.parse(issued.createdAt))
              || issued.rotatedAt !== null && (typeof issued.rotatedAt !== "string" || !Number.isFinite(Date.parse(issued.rotatedAt)))) throw new CliError("invalid_response", 1);
            await privateWrite(credentialPath, JSON.stringify(key));
            state = await save(fromKeyInFlight(state, { kind: "saved", credentialFile: credentialPath }));
          } catch (error) {
            if (state.step !== "key:in-flight") return ambiguous();
            if (error instanceof CliError && error.status === undefined && (error.error === "transport_unsent" || !invoked && (error.error === "user_session_required" || error.error === "unsafe_session_file"))) {
              state = await save(fromKeyInFlight(state, { kind: "unsent", reason: error.error })); throw new CliError(error.error, error.error === "unsafe_session_file" ? 1 : 2, error.status);
            }
            await save(fromKeyInFlight(state, { kind: "ambiguous" })).catch(() => {}); return ambiguous();
          }
          continue;
        }
        case "key:in-flight": {
          const issuing = state;
          try { await finish(state.credentialFile); state = await save(fromKeyInFlight(state, { kind: "saved", credentialFile: state.credentialFile })); }
          catch { state = await save(fromKeyInFlight(issuing, { kind: "ambiguous" })).catch(() => ambiguous()); }
          continue;
        }
        case "key:ambiguous": case "key:saved": {
          const recovery = values["recover-key-file"];
          if (!recovery) return state.step === "key:saved" ? await finish(state.credentialFile) : ambiguous();
          const recovered = await verify(JSON.parse(await privateRead(recovery) ?? "null")), recoveryFile = join(directory, `${digest}.${crypto.randomUUID()}.credentials.json`);
          try {
            await privateWrite(recoveryFile, JSON.stringify(recovered));
            state = await save(state.step === "key:saved" ? fromKeySaved(state, recoveryFile) : fromKeyAmbiguous(state, recoveryFile));
          } catch { if (state.step === "key:saved") throw new CliError("credential_file_recovery_required", 2); return ambiguous(); }
          return result(recovered, recoveryFile);
        }
        default: { const unreachable: never = state; return unreachable; }
      }
    }
  } catch (error) { failed = true; throw error; }
  finally { await unlock().catch(() => { if (!failed) throw new CliError("private_lock_recovery_required", 2); }); }
}
async function bootstrapPassword(io: Execution): Promise<string> {
  const password = io.env.BP_BOOTSTRAP_PASSWORD ?? io.env.BP_USER_PASSWORD ?? await io.password?.();
  if (!password) throw new CliError("bootstrap_password_required", 1);
  io.env.BP_USER_PASSWORD = password; return password;
}

async function readiness(io: Execution): Promise<string> {
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(io.signal ? [io.signal] : [])]);
  while (!signal.aborted) {
    try {
      const response = await request(credentials(io.env, "none", undefined), "/health/ready", "GET", undefined, new Headers(), undefined, signal, io.transport);
      const value = await json(response);
      if (record(value) && record(value.enrollment)) {
        if (value.enrollment.state === "recovery_required") throw new CliError("recovery_required", 2);
        if (response.ok && ["pending", "claimed"].includes(String(value.enrollment.state))) return String(value.enrollment.state);
      }
    } catch (e) { if (e instanceof CliError && e.error === "recovery_required") throw e; }
    await Bun.sleep(250);
  }
  throw new CliError("server_not_ready", 2);
}
