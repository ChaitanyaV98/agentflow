import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { NonRetryableError } from "@/agent/retry";
import type { AgentTool } from "@/agent/types";

/**
 * Web tools.
 *  - web_search: Tavily (free tier, 1,000 searches/month; built for agents, returns clean snippets).
 *  - fetch_url: read one page as plain text. No API key.
 */

const MAX_PAGE_CHARS = 5000;

export const webSearch: AgentTool<{ query: string; maxResults: number }> = {
  name: "web_search",
  description: "Search the web. Returns titles, URLs and short content snippets.",
  inputSchema: z.object({
    query: z.string().min(2).describe("What to search for"),
    maxResults: z.number().int().min(1).max(8).default(5),
  }),
  async execute({ query, maxResults }) {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new NonRetryableError("TAVILY_API_KEY is not set, so web search is unavailable.");
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
    });
    if (!res.ok) {
      const msg = `Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new NonRetryableError(msg);
      throw new Error(msg);
    }
    const data = (await res.json()) as { results: { title: string; url: string; content: string }[] };
    return data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content.slice(0, 500) }));
  },
};

export const fetchUrl: AgentTool<{ url: string }> = {
  name: "fetch_url",
  description: "Read a public web page and return its text (scripts and markup removed, truncated).",
  inputSchema: z.object({ url: z.string().url().describe("http(s) URL of the page") }),
  async execute({ url }) {
    // Follow redirects ourselves (max 3) so every hop goes through the private-address check;
    // otherwise a public URL could redirect the agent to an internal one.
    let target = new URL(url);
    let res: Response;
    for (let hop = 0; ; hop++) {
      await assertPublicHost(target);
      res = await fetch(target, {
        headers: { "User-Agent": "agentflow/0.1 (+https://github.com/ChaitanyaV98/agentflow)" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      if (hop === 3) throw new NonRetryableError("Too many redirects.");
      target = new URL(location, target);
    }
    if (!res.ok) {
      const msg = `HTTP ${res.status} from ${target.host}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new NonRetryableError(msg);
      throw new Error(msg);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml/.test(type)) throw new NonRetryableError(`Not a text page (${type || "unknown type"}).`);
    const raw = await res.text();
    const text = type.includes("html") ? htmlToText(raw) : raw;
    return {
      url: target.toString(),
      title: /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim() ?? null,
      text: text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}… [truncated]` : text,
    };
  },
};

/**
 * SSRF guard. The agent decides which URLs to fetch, and its input can come from untrusted pages
 * and issues — so it must not be tricked into reading internal services (cloud metadata at
 * 169.254.169.254, a database on localhost, …). We resolve the hostname and refuse private ranges.
 */
async function assertPublicHost(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NonRetryableError(`Only http(s) URLs are allowed, not ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw new NonRetryableError(`Refusing to fetch ${url.hostname}: it resolves to a private or local address.`);
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7)); // IPv4-mapped IPv6
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export const webTools = [webSearch, fetchUrl] as AgentTool[];
