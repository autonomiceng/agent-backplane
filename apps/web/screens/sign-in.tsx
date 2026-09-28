// Signs Users in through Better Auth and returns only to same-origin dashboard paths.
import { useState, type ReactNode } from "react";
import { DashboardShell } from "../components/dashboard-shell.tsx";

export function SignIn({ returnTo }: { returnTo: string | null }): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return <DashboardShell><div className="sign-in"><section className="pk-card"><div className="stack"><h1>Sign in</h1><form onSubmit={async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    let destination = "/dashboard/";
    try {
      const target = new URL(returnTo ?? destination, window.location.origin);
      if (target.origin === window.location.origin && target.pathname.startsWith("/dashboard/")) destination = target.href;
    } catch { destination = "/dashboard/"; }
    setPending(true); setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/email", { method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
      if (!response.ok) { setError("Sign-in failed. Check your email and password."); return; }
      window.location.assign(destination);
    } catch { setError("Sign-in unavailable. Try again."); }
    finally {
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      setPending(false);
    }
  }}>
    <label>Email<input className="pk-input" name="email" type="email" autoComplete="username" required /></label>
    <label>Password<input className="pk-input" name="password" type="password" autoComplete="current-password" required /></label>
    <div className="actions"><button className="pk-button" disabled={pending}>{pending ? "Signing in" : "Sign in"}</button></div>
    {error && <p className="pk-notice" data-state="danger" role="alert">{error}</p>}
  </form></div></section></div></DashboardShell>;
}
