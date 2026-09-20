import { t } from "elysia";

export const capabilityStates = ["healthy", "unavailable", "unknown", "disabled"] as const;
const observationSchema = <B extends string>(backends: readonly B[]) => t.Object({
  state: t.Union(capabilityStates.map(state => t.Literal(state))),
  observedAt: t.Nullable(t.String({ format: "date-time" })),
  backend: t.Nullable(t.Union(backends.map(backend => t.Literal(backend)))),
});
export const capabilitiesSchema = t.Object({ files: observationSchema(["filesystem", "s3"] as const), functions: observationSchema(["workerd"] as const) });
export type Capabilities = typeof capabilitiesSchema.static;
type CapabilityBackend = NonNullable<Capabilities[keyof Capabilities]["backend"]>;
export type CapabilityObservation<B extends CapabilityBackend = CapabilityBackend> = Omit<Capabilities["files"], "backend"> & { backend: B | null };
export type CapabilitySampler = () => Promise<Capabilities>;
export const unknownCapabilities = (): Capabilities => ({
  files: { state: "unknown", observedAt: null, backend: null },
  functions: { state: "unknown", observedAt: null, backend: null },
});
