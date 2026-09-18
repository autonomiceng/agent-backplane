// Version-1 compatibility and strict bytes-to-state validation share one table-driven scenario.
import { expect, test } from "bun:test";
import { type BootstrapCheckpoint, parseCheckpoint, serializeCheckpoint, fromInitial, fromEnrollmentInFlight, fromEnrollmentSaved, fromWorkspaceInFlight, fromWorkspaceSaved, fromPrincipalInFlight, fromPrincipalSaved, fromKeyInFlight, fromKeyAmbiguous, fromKeySaved } from "./bootstrap-checkpoint.ts";

test("a checkpoint file on disk is parsed into a state it does not represent", () => {
  const base = { version: 1, url: "http://localhost", email: "first@example.com" } as const;
  const u = { userId: "opaque-user" }, w = { ...u, workspaceId: "abcdefab-1234-5678-9012-abcdefabcdef" };
  const p = { ...w, principalId: "fedcbafe-1234-5678-9012-fedcbafedcba" }, k = { ...p, credentialFile: "/private/key.json" };
  const rows = [
    { step: undefined, fields: {} }, { step: "enrollment:in-flight", fields: {} },
    { step: "enrollment:saved", fields: u }, { step: "workspace:in-flight", fields: u },
    { step: "workspace:saved", fields: w }, { step: "principal:in-flight", fields: w },
    { step: "principal:saved", fields: p }, { step: "key:in-flight", fields: k },
    { step: "key:ambiguous", fields: k }, { step: "key:saved", fields: k },
  ] as const;
  for (const { step, fields } of rows) {
    const parsed = parseCheckpoint(JSON.stringify({ ...base, step, credentialFile: k.credentialFile, ...fields,
      ...("workspaceId" in fields ? { workspaceId: fields.workspaceId.toUpperCase() } : {}),
      ...("principalId" in fields ? { principalId: fields.principalId.toUpperCase() } : {}) }));
    expect<unknown>(parsed).toEqual({ ...base, step, ...fields });
    if ("error" in parsed) throw new Error(parsed.reason);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseCheckpoint(serializeCheckpoint(parsed))).toEqual(parsed);
    const extended = { ...parsed, key: "inline-secret" };
    expect(JSON.parse(serializeCheckpoint(extended))).toEqual({ ...base, ...(step ? { step } : {}), ...fields });
  }
  for (const references of [{ recoveryFile: k.credentialFile }, { recoveryFile: k.credentialFile, credentialFile: k.credentialFile }]) {
    expect(parseCheckpoint(JSON.stringify({ ...base, step: "key:in-flight", ...p, ...references }))).toEqual({ ...base, step: "key:in-flight", ...k });
  }
  const invalid = [
    "{broken-secret", "null", "[]", JSON.stringify({ ...base, version: 2 }),
    ...[
      { step: "future-secret" }, { url: "http://localhost/" }, { url: "file:///private" }, { url: "invalid-secret" },
      { email: "" }, { email: " FIRST@example.com " }, { userId: u.userId },
      { step: "enrollment:in-flight", ...u }, { step: "enrollment:saved" },
      { step: "workspace:in-flight", ...w }, { step: "workspace:saved", ...u },
      { step: "workspace:saved", ...p }, { step: "principal:in-flight", ...w, workspaceId: "invalid-secret" },
      { step: "principal:saved", ...w }, { step: "principal:saved", ...p, userId: " " },
      { step: "key:in-flight", ...k, userId: undefined }, { step: "key:ambiguous", ...k, workspaceId: undefined },
      { step: "key:saved", ...k, principalId: undefined }, { step: "key:in-flight", ...p },
      { step: "key:ambiguous", ...k, credentialFile: "" }, { credentialFile: {} }, { recoveryFile: "\0" },
      { step: "key:saved", ...k, recoveryFile: "/conflicting-secret" },
      { step: "key:saved", ...k, key: "inline-secret" }, { extra: "unknown-secret" },
    ].map(fields => JSON.stringify({ ...base, ...fields })),
  ];
  for (const bytes of invalid) {
    const parsed = parseCheckpoint(bytes);
    expect(parsed).toMatchObject({ error: "checkpoint_invalid", reason: expect.any(String) });
    expect(Object.keys(parsed).sort()).toEqual(["error", "reason"]);
    expect(JSON.stringify(parsed)).not.toContain("secret");
  }
  const accept = <T extends BootstrapCheckpoint>(result: T | { error: "checkpoint_transition_invalid" }): T => {
    if ("error" in result) throw new Error(result.error);
    return result;
  };
  const initial = parseCheckpoint(JSON.stringify(base));
  if ("error" in initial || initial.step !== undefined) throw new Error("initial checkpoint rejected");
  const enrollment = accept(fromInitial(initial)), enrolled = accept(fromEnrollmentInFlight(enrollment, u.userId));
  const workspace = accept(fromEnrollmentSaved(enrolled)), workspaceSaved = accept(fromWorkspaceInFlight(workspace, w.workspaceId.toUpperCase()));
  const principal = accept(fromWorkspaceSaved(workspaceSaved)), principalSaved = accept(fromPrincipalInFlight(principal, p.principalId.toUpperCase()));
  const issuing = accept(fromPrincipalSaved(principalSaved, k.credentialFile));
  const ambiguous = accept(fromKeyInFlight(issuing, { kind: "ambiguous" }));
  if (ambiguous.step !== "key:ambiguous") throw new Error("ambiguity lost");
  const saved = accept(fromKeyInFlight(issuing, { kind: "saved", credentialFile: k.credentialFile }));
  if (saved.step !== "key:saved") throw new Error("saved key lost");
  const recovered = accept(fromKeyAmbiguous(ambiguous, "/private/recovered.json")), replaced = accept(fromKeySaved(saved, "/private/replaced.json"));
  const outcomes = [initial, enrollment, enrolled, workspace, workspaceSaved, principal, principalSaved, issuing, ambiguous, saved, recovered, replaced];
  for (const state of outcomes) {
    expect(Object.isFrozen(state)).toBe(true);
    expect(outcomes.filter(other => other === state)).toHaveLength(1);
    expect(parseCheckpoint(serializeCheckpoint(state))).toEqual(state);
  }
  expect(issuing).toEqual({ ...base, step: "key:in-flight", ...k });
  expect(ambiguous).toEqual({ ...issuing, step: "key:ambiguous" });
  expect(saved).toEqual({ ...issuing, step: "key:saved" });
  expect(recovered).toEqual({ ...saved, credentialFile: "/private/recovered.json" });
  expect(replaced).toEqual({ ...saved, credentialFile: "/private/replaced.json" });
  for (const reason of ["transport_unsent", "user_session_required", "unsafe_session_file"] as const) {
    const rollback = accept(fromKeyInFlight(issuing, { kind: "unsent", reason }));
    expect(rollback).toEqual(principalSaved);
    expect(rollback).not.toBe(principalSaved);
    expect(Object.isFrozen(rollback)).toBe(true);
    expect(rollback).not.toHaveProperty("credentialFile");
  }
  const transitions = [
    { source: initial, call: (s: unknown) => fromInitial(s as Parameters<typeof fromInitial>[0]) },
    { source: enrollment, call: (s: unknown) => fromEnrollmentInFlight(s as Parameters<typeof fromEnrollmentInFlight>[0], u.userId) },
    { source: enrolled, call: (s: unknown) => fromEnrollmentSaved(s as Parameters<typeof fromEnrollmentSaved>[0]) },
    { source: workspace, call: (s: unknown) => fromWorkspaceInFlight(s as Parameters<typeof fromWorkspaceInFlight>[0], w.workspaceId) },
    { source: workspaceSaved, call: (s: unknown) => fromWorkspaceSaved(s as Parameters<typeof fromWorkspaceSaved>[0]) },
    { source: principal, call: (s: unknown) => fromPrincipalInFlight(s as Parameters<typeof fromPrincipalInFlight>[0], p.principalId) },
    { source: principalSaved, call: (s: unknown) => fromPrincipalSaved(s as Parameters<typeof fromPrincipalSaved>[0], k.credentialFile) },
    { source: issuing, call: (s: unknown) => fromKeyInFlight(s as Parameters<typeof fromKeyInFlight>[0], { kind: "ambiguous" }) },
    { source: ambiguous, call: (s: unknown) => fromKeyAmbiguous(s as Parameters<typeof fromKeyAmbiguous>[0], k.credentialFile) },
    { source: saved, call: (s: unknown) => fromKeySaved(s as Parameters<typeof fromKeySaved>[0], k.credentialFile) },
  ];
  for (const { source, call } of transitions) {
    const missing = { ...source };
    Reflect.deleteProperty(missing, source.principalId ? "principalId" : source.workspaceId ? "workspaceId" : source.userId ? "userId" : "url");
    for (const wrong of [null, { ...source, step: "wrong" }, missing,
      { ...source, ...(source.credentialFile ? { recoveryFile: source.credentialFile } : { credentialFile: k.credentialFile }) },
      { ...source, key: undefined }]) expect(call(wrong)).toEqual({ error: "checkpoint_transition_invalid" });
  }
  const forbidden = [
    fromEnrollmentInFlight(enrollment, ""), fromWorkspaceInFlight(workspace, "invalid"), fromPrincipalInFlight(principal, ""),
    fromPrincipalSaved(principalSaved, "\0"), fromKeyInFlight(issuing, { kind: "saved", credentialFile: "" }),
    fromKeyAmbiguous(ambiguous, " "), fromKeySaved(saved, ""),
    fromKeyInFlight(issuing, { kind: "unsent", reason: "http_400" } as unknown as Parameters<typeof fromKeyInFlight>[1]),
  ];
  for (const result of forbidden) expect(result).toEqual({ error: "checkpoint_transition_invalid" });
  expect(issuing).toEqual({ ...base, step: "key:in-flight", ...k });
});
