import { blobUuid } from "../blobs/blob-store.ts";
import { bindingBytes, type Binding, type BindingStore } from "../blobs/storage-binding.ts";
import type { ComputeLauncher } from "../compute/compute-launcher.ts";
import type { CapabilityObservation, CapabilitySampler } from "./capability-types.ts";
import type { Pool } from "./pool.ts";
import { probeTransaction } from "./probe-transaction.ts";

const deadlineMs = 2000, cacheMs = 5000;
function boundedObservation(read: (signal: AbortSignal) => Promise<CapabilityObservation["backend"]>) {
  let cache: { started: number; value: CapabilityObservation } | undefined;
  let flight: Promise<CapabilityObservation> | undefined;
  return () => {
    if (flight) return flight;
    if (cache && performance.now() - cache.started < cacheMs) return Promise.resolve(cache.value);
    const started = performance.now(), observedAt = new Date().toISOString(), controller = new AbortController();
    const unavailable: CapabilityObservation = { state: "unavailable", observedAt, backend: null };
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<CapabilityObservation>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(unavailable); }, deadlineMs);
    });
    const work = Promise.resolve().then(() => read(controller.signal)).then(backend => ({
      state: backend === null ? "unavailable" : "healthy", observedAt, backend,
    }) satisfies CapabilityObservation).catch(() => unavailable);
    const response = Promise.race([work, deadline]).then(value => { cache = { started, value }; return value; });
    flight = response;
    // Keep the slot until underlying I/O settles, even after the caller's deadline.
    void work.then(async () => { await response; clearTimeout(timer); flight = undefined; });
    return response;
  };
}

export function capabilityProbe(pool: Pool, store?: Pick<BindingStore, "backend" | "markerOrAbsent">, launcher?: Pick<ComputeLauncher, "verify">): CapabilitySampler {
  const files = boundedObservation(async signal => {
    if (!store) return null;
    const binding = await probeTransaction(pool, deadlineMs, async tx => {
      const rows = await tx<Binding[]>`SELECT database_id,store_id,generation,backend,phase FROM control.blob_storage_binding LIMIT 2`;
      const row = rows[0];
      return rows.length === 1 && row?.phase === "ready" && row.backend === store.backend
        && [row.database_id, row.store_id, row.generation].every(value => blobUuid.test(value)) ? row : null;
    });
    signal.throwIfAborted();
    if (!binding) return null;
    const marker = await store.markerOrAbsent(signal);
    return marker && bindingBytes(binding).equals(marker) ? store.backend : null;
  });
  const functions = boundedObservation(async signal => await launcher?.verify(signal) ? "workerd" : null);
  return async () => {
    const [fileObservation, functionObservation] = await Promise.all([
      store ? files() : { state: "unknown", observedAt: null, backend: null } satisfies CapabilityObservation,
      launcher ? functions() : { state: "disabled", observedAt: null, backend: null } satisfies CapabilityObservation,
    ]);
    return { files: fileObservation, functions: functionObservation };
  };
}
