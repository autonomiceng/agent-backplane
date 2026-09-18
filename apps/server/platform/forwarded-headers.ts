// The app's first request hook removes proxy claims in place, preserving the body and abort signal.
export function stripForwardedHeaders(headers: Headers): void {
  const names = [...headers.keys()];
  for (const name of names) {
    if (name === "forwarded" || name.startsWith("x-forwarded-")
      || ["x-real-ip", "cf-connecting-ip", "true-client-ip"].includes(name)) headers.delete(name);
  }
}
