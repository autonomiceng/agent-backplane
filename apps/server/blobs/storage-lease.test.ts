import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { storageLease } from "./storage-lease.ts";
test("a second start is excluded and an explicitly released lock triggers the ownership watchdog", async () => {
  const url = await migratedDatabase(), pool = createPool(url), admin = createPool(adminUrl(url));
  const lease = await storageLease(pool);
  try {
    await expect(storageLease(admin)).rejects.toThrow("blob_binding_busy");
    const lost = Promise.withResolvers<void>(); lease.watch(() => lost.resolve());
    await lease.session`SELECT pg_advisory_unlock(112933,32)`;
    await lost.promise;
    await expect(lease.assertOwned()).rejects.toThrow("blob_binding_lease_lost");
  } finally { await lease.release(); await pool.close(); await admin.close(); }
});
