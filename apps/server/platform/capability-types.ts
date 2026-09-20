import { t } from "elysia";

export const capabilityStates = ["healthy", "unavailable", "unknown", "disabled"] as const;
const observationSchema = t.Object({
  state: t.Union(capabilityStates.map(state => t.Literal(state))),
  observedAt: t.Nullable(t.String({ format: "date-time" })),
  backend: t.Nullable(t.Union([t.Literal("filesystem"), t.Literal("s3"), t.Literal("workerd")])),
});
export const capabilitiesSchema = t.Object({ files: observationSchema, functions: observationSchema });
export type CapabilityObservation = typeof observationSchema.static;
export type Capabilities = typeof capabilitiesSchema.static;
export type CapabilitySampler = () => Promise<Capabilities>;
export const unknownCapabilities = (): Capabilities => ({
  files: { state: "unknown", observedAt: null, backend: null },
  functions: { state: "unknown", observedAt: null, backend: null },
});
