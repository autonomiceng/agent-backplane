// One app-wide gate reserves callback capacity; invocation abort releases only after terminal cleanup.
import { Elysia } from "elysia";
import { invocationScope, isInvocation } from "../auth/invocation-credential.ts";
export class PrincipalAdmission {
  private active = 0;
  private rejectionMinute = -1;
  private rejected = 0;
  snapshot() {
    const minute=Math.floor(performance.now()/60000);
    if (minute!==this.rejectionMinute) { this.rejectionMinute=minute; this.rejected=0; }
    return { inUse:this.active,waiters:this.waiting.size,limit:this.limit,rejectedLastMinute:this.rejected };
  }
  private nonCallbacks = 0;
  private waiting = new Set<() => void>();
  private releases = new WeakMap<Request, () => void>();
  private acquisitions = new WeakMap<Request, Promise<boolean>>();
  constructor(private readonly limit = 6, private readonly waitMs = 2000) {}
  acquire(request: Request): Promise<boolean> {
    const previous = this.acquisitions.get(request);
    if (previous) return previous;
    const callback = isInvocation(request);
    const invocation = /\/functions\/[^/]+\/invoke\/?$/.test(new URL(request.url).pathname);
    const pending = new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer); this.waiting.delete(enter); request.signal.removeEventListener("abort", abort);
        if (ok) {
          this.active++; if (!callback) this.nonCallbacks++;
          const release = () => {
            if (!this.releases.delete(request)) return;
            request.signal.removeEventListener("abort", release); this.active--;
            if (!callback) this.nonCallbacks--;
            for (const enter of this.waiting) enter();
          };
          this.releases.set(request, release);
          if (!invocation) request.signal.addEventListener("abort", release, { once: true });
        }
        if (!ok) { this.snapshot(); this.rejected++; }
        resolve(ok);
      };
      const enter = () => { if (this.active < this.limit && (callback || this.nonCallbacks < this.limit - 1)) finish(true); };
      const abort = () => finish(false);
      const timer = setTimeout(abort, this.waitMs);
      if (request.signal.aborted) return finish(false);
      request.signal.addEventListener("abort", abort, { once: true });
      this.waiting.add(enter); enter();
    });
    this.acquisitions.set(request, pending);
    return pending;
  }
  release(request: Request): void { this.releases.get(request)?.(); }
}
export function principalAdmission(admission = new PrincipalAdmission()) {
  return new Elysia({ name: "principal-admission" }).decorate("admission", admission)
    .onRequest(({ request, status }) => {
      // Compute routes preserve their disabled-before-authentication guard.
      if (/^\/api\/v1\/workspaces\/[^/]+\/functions(?:\/|$)/.test(new URL(request.url).pathname)) return;
      if (isInvocation(request) && !invocationScope(request)) return status(403, { error: "invocation_scope_forbidden" });
    }).onAfterResponse(({ request, admission }) => { admission.release(request); }).as("global");
}

export function admissionSnapshot(admission: PrincipalAdmission) { return admission.snapshot(); }
