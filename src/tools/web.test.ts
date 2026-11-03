import { describe, expect, it } from "vitest";
import { fetchUrl, htmlToText, isPrivateAddress } from "./web";

describe("SSRF guard", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata endpoint
    ["100.64.0.1", true],
    ["::1", true],
    ["fd00::1", true],
    ["::ffff:127.0.0.1", true],
    ["8.8.8.8", false],
    ["140.82.112.3", false],
  ])("%s private=%s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it("refuses localhost and non-http URLs without making a request", async () => {
    await expect(fetchUrl.execute({ url: "http://127.0.0.1:5435/" })).rejects.toThrow(/private or local/);
    await expect(fetchUrl.execute({ url: "http://localhost/" })).rejects.toThrow(/private or local/);
    await expect(fetchUrl.execute({ url: "file:///etc/passwd" })).rejects.toThrow(/Only http/);
  });
});

describe("htmlToText", () => {
  it("drops scripts and markup and keeps readable text", () => {
    const html = `<html><head><title>T</title><style>.a{}</style></head><body>
      <script>alert(1)</script><h1>Hello &amp; welcome</h1><p>First<br>line</p><!-- c --></body></html>`;
    expect(htmlToText(html)).toBe("Hello & welcome\n First\nline");
  });
});
