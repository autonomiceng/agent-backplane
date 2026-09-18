// Stdio entrypoint snapshots configuration and owns process shutdown.
import { credentialEnvironment } from "../../cli/runtime/credential-file.ts";
import { server } from "./server.ts";
export async function main(argv: string[] = []): Promise<void> {
  if (argv.length) { process.stderr.write('{"error":"invalid_arguments"}\n'); process.exitCode = 2; return; }
  let env;
  try { env = await credentialEnvironment({ ...process.env, BP_SESSION: process.env.BP_SESSION ?? String(process.pid) }); }
  catch { process.stderr.write('{"error":"credential_file_invalid"}\n'); process.exitCode = 1; return; }
  let stopped = false;
  const stop = () => { stopped = true; process.stdin.destroy(); };
  const failed = () => { process.exitCode = 1; stop(); };
  process.stdout.on("error", failed);
  const runtime = server({ env }, (text) => new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => { if (error) { failed(); reject(error); } else resolve(); });
  }));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { for await (const chunk of process.stdin) runtime.feed(chunk); }
  catch { if (!stopped) failed(); }
  finally {
    try { await runtime.close(); } catch { process.exitCode = 1; }
    process.off("SIGINT", stop); process.off("SIGTERM", stop); process.stdout.off("error", failed);
  }
}
if (import.meta.main) await main(process.argv.slice(2));
