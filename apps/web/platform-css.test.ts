// The vendored platform-ui kit must match its own header checksum and load before the local stylesheet.
import { expect, test } from "bun:test";

test("vendored platform.css matches its header checksum and precedes styles.css", async () => {
  const [header = "", ...rest] = (await Bun.file(new URL("platform.css", import.meta.url)).text()).split("\n");
  const match = /^\/\* vendored from platform-edge@[0-9a-f]{7,40} sha256:([0-9a-f]{64}) ; do not edit here \*\/$/.exec(header);
  expect(match?.[1]).toBe(new Bun.CryptoHasher("sha256").update(rest.join("\n")).digest("hex"));
  const index = await Bun.file(new URL("index.html", import.meta.url)).text();
  expect(index).toMatch(/href="\/platform\.css"[^]*href="\/styles\.css"/);
  expect(index).toContain('<body class="pk-page">');
});
