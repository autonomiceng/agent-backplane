import { expect, test } from "bun:test";
import { handoffEvidence, handoffKeys, metadata, preparedMetadataMatches } from "./collector.ts";

const source = { sourceId: "talk", demoRun: "demo", title: "Original", speakers: ["Speaker"], talkDate: "2025-06-04", videoUrl: "https://example.com/video", transcriptUrl: "https://example.com/transcript", mediaType: "text/plain", transcriptAccess: { status: 200 }, license: { status: "unknown" } };
const prepared = { ...source, transcriptFile: { mediaType: "text/plain" }, collector: { runId: "12345678-1234-1234-1234-123456789abc" }, provenance: { eventCursor: "500", fileUploadedInRun: true } };

test("prepared reuse rejects changed source metadata while retaining file evidence", () => {
  expect(preparedMetadataMatches(prepared, source)).toBeTrue();
  for (const change of [{ title: "Changed" }, { speakers: ["Other"] }, { talkDate: null }, { videoUrl: null }, { transcriptUrl: null }, { transcriptAccess: { status: 404 } }, { license: { status: "open" } }]) {
    expect(preparedMetadataMatches(prepared, { ...source, ...change })).toBeFalse();
  }
});

test("handoff rejects malformed attribution and file facts before submission", () => {
  expect(handoffEvidence(prepared).runId).toBe(prepared.collector.runId);
  for (const change of [
    { collector: { runId: "bad" } },
    { provenance: { eventCursor: "bad", fileUploadedInRun: true } },
    { provenance: { eventCursor: "0", fileUploadedInRun: "true" } },
    { transcriptFile: { mediaType: "" } },
    { transcriptFile: { mediaType: "text/html" } },
  ]) expect(() => handoffEvidence({ ...prepared, ...change })).toThrow();
});

test("source metadata requires access and license facts before upload or handoff", () => {
  const valid = { ...source, schemaVersion: 1, fictional: true, topicTags: [] };
  expect(() => metadata(valid)).not.toThrow();
  expect(() => metadata({ ...valid, transcriptAccess: { status: "synthetic" } })).not.toThrow();
  for (const value of [{}, { status: null }, { status: true }, { status: [] }, { status: "" }, { status: " " }]) {
    expect(() => metadata({ ...valid, transcriptAccess: value })).toThrow();
    expect(() => metadata({ ...valid, license: value })).toThrow();
  }
  expect(() => metadata({ ...valid, transcriptAccess: { status: 999 } })).toThrow();
  expect(() => metadata({ ...valid, license: { status: 200 } })).toThrow();
});

test("handoff identities distinguish tuple boundaries and stay stable on retry", () => {
  const first = handoffKeys("a:b", "c"), second = handoffKeys("a", "b:c");
  expect(first.handoffKey).not.toBe(second.handoffKey);
  expect(first.messageKey).not.toBe(second.messageKey);
  expect(first).toEqual(handoffKeys("a:b", "c"));
  expect(first.handoffKey).not.toBe(first.messageKey);
});
