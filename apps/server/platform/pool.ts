// One bounded Bun SQL pool. Reservations account for queries, transactions and explicit borrowers.
import { SQL, type ReservedSQL, type SQLQuery } from "bun";
export type Pool = SQL;
export const poolLimit = 10;
const observations = new WeakMap<Pool, { inUse: number; waiting: number }>();
export function poolSnapshot(pool: Pool) { return observations.get(pool) ?? null; }

export function createPool(databaseUrl: string): Pool {
  const sql = new SQL({ url: databaseUrl, max: poolLimit, connectionTimeout: 5, idleTimeout: 30 });
  const counts = { inUse: 0, waiting: 0 };
  const reserve = async (options?: { signal?: AbortSignal }) => {
    counts.waiting++;
    let connection: ReservedSQL;
    try { connection = await sql.reserve(options); } finally { counts.waiting--; }
    counts.inUse++;
    const release = connection.release.bind(connection);
    let released = false;
    connection.release = () => { if (!released) { released = true; counts.inUse--; release(); } };
    connection[Symbol.dispose] = connection.release;
    return connection;
  };
  const isQuery = (value: unknown): value is SQLQuery<unknown> => value instanceof Promise && "cancel" in value;
  const query = <T>(original: SQLQuery<T>, make: (connection: ReservedSQL) => SQLQuery<T>): SQLQuery<T> => {
    let result: Promise<T> | undefined, active: SQLQuery<T> | undefined;
    const abort = new AbortController();
    const start = () => result ??= (async () => {
      const connection = await reserve({ signal: abort.signal });
      try { abort.signal.throwIfAborted(); active = make(connection); return await active; }
      finally { connection.release(); }
    })();
    const wrapped = new Proxy(original, {
      get(target, key) {
        if (key === "then") return (...args: Parameters<Promise<T>["then"]>) => start().then(...args);
        if (key === "catch") return (...args: Parameters<Promise<T>["catch"]>) => start().catch(...args);
        if (key === "finally") return (...args: Parameters<Promise<T>["finally"]>) => start().finally(...args);
        if (key === "execute") return () => { void start().catch(() => {}); return wrapped; };
        if (key === "cancel") return () => { abort.abort(new Error("query_cancelled")); active?.cancel(); };
        if (key === "values" || key === "raw" || key === "simple") return (...args: unknown[]) =>
          query(Reflect.apply(Reflect.get(target, key), target, args), c => { const next = make(c); return Reflect.apply(Reflect.get(next, key), next, args); });
        return Reflect.get(target, key, target);
      },
    });
    return wrapped;
  };
  const pool = new Proxy(sql, {
    apply(target, _this, args) {
      const value = Reflect.apply(target, target, args);
      return isQuery(value) ? query(value, c => Reflect.apply(c, c, args)) : value;
    },
    get(target, key) {
      if (key === "reserve") return reserve;
      if (key === "begin" || key === "transaction") return async (...args: unknown[]) => {
        const connection = await reserve();
        try { return await Reflect.apply(connection.begin, connection, args); } finally { connection.release(); }
      };
      if (key === "unsafe" || key === "file") return (...args: unknown[]) =>
        query(Reflect.apply(Reflect.get(target, key), target, args), c => Reflect.apply(Reflect.get(c, key), c, args));
      return Reflect.get(target, key, target);
    },
  });
  observations.set(pool, counts);
  return pool;
}
