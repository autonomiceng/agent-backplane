const segmentPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

export function keySegment(value: string, suffix = "") {
  if (suffix.length >= 64 || !/^[A-Za-z0-9._-]*$/.test(suffix)) throw new Error("key_segment_invalid");
  const safe = value.replaceAll(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 64 - suffix.length);
  const segment = `${safe}${suffix}`;
  if (!segmentPattern.test(segment)) throw new Error("key_segment_invalid");
  return segment;
}
