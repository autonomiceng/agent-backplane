import { createHash } from "node:crypto";

const segmentPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

export function keySegment(value: string, suffix = "") {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const budget = 64 - suffix.length - hash.length - 1;
  if (budget < 1 || !/^[A-Za-z0-9._-]*$/.test(suffix)) throw new Error("key_segment_invalid");
  const safe = value.replaceAll(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, budget);
  if (!safe) throw new Error("key_segment_invalid");
  const segment = `${safe}-${hash}${suffix}`;
  if (!segmentPattern.test(segment)) throw new Error("key_segment_invalid");
  return segment;
}
