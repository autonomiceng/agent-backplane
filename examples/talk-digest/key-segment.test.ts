import { expect, test } from "bun:test";
import { keySegment } from "./key-segment.ts";

const acceptedSegment = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

test("File key segments remain valid at the API boundary with suffixes included", () => {
  const transcript = keySegment("source/".repeat(20), ".txt");
  const page = keySegment("x".repeat(100), ".html");
  expect(transcript).toHaveLength(64);
  expect(page).toHaveLength(64);
  expect(transcript.endsWith(".txt")).toBeTrue();
  expect(page.endsWith(".html")).toBeTrue();
  expect(acceptedSegment.test(transcript)).toBeTrue();
  expect(acceptedSegment.test(page)).toBeTrue();
});

test("File key segments repair leading dots and reject an absent safe prefix", () => {
  expect(acceptedSegment.test(keySegment("...hidden", ".json"))).toBeTrue();
  expect(keySegment("talk/source")).not.toBe(keySegment("talk_source"));
  expect(keySegment("x".repeat(100) + "a")).not.toBe(keySegment("x".repeat(100) + "b"));
  expect(keySegment("talk/source")).toBe(keySegment("talk/source"));
  expect(() => keySegment("", ".txt")).toThrow("key_segment_invalid");
  expect(() => keySegment("source", "/bad")).toThrow("key_segment_invalid");
});
