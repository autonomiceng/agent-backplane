// Stdio entrypoint snapshots configuration and owns process shutdown.
import { credentialEnvironment } from "../../cli/runtime/credential-file.ts";
import { server } from "./server.ts";
export async function main(argv: string[] = []): Promise<void> {
  if (argv.length) { process.stderr.write('{"error":"invalid_arguments"}\n'); process.exitCode = 2; return; }
  let env;
  try { env = await credentialEnvironment({ ...process.env, BP_SESSION: process.env.BP_SESSION ?? String(process.pid) }); }
  catch { process.stderr.write('{"error":"credential_file_invalid"}\n'); process.exitCode = 1; return; }
  const runtime = server({ env }, (text) => new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => error ? reject(error) : resolve());
  }));
  const stop = () => { process.stdin.destroy(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { for await (const chunk of process.stdin) runtime.feed(chunk); }
  finally { await runtime.close(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (import.meta.main) await main(process.argv.slice(2));
