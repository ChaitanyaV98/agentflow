import { z } from "zod";
import { NonRetryableError } from "@/agent/retry";
import type { AgentTool } from "@/agent/types";

/**
 * GitHub tools over the REST API. Reads work without a token on public repos (60 requests/hour);
 * set GITHUB_TOKEN for 5,000/hour and to post comments.
 *
 * In milestone 2 these move behind an MCP server; the agent code won't change.
 */
const API = "https://api.github.com";
const MAX_BODY = 3000; // keep tool output small: free-tier models have tight token-per-minute limits

async function gh(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agentflow",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(15_000), // a hung connection fails fast and gets retried
  });
  if (!res.ok) {
    const msg = `GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`;
    // 4xx (except 429 rate limit) means the request itself is wrong — retrying won't help.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new NonRetryableError(msg);
    throw new Error(msg);
  }
  return res.json();
}

const truncate = (s: string | null | undefined, n = MAX_BODY) =>
  !s ? "" : s.length > n ? `${s.slice(0, n)}… [truncated]` : s;

const repoRef = {
  owner: z.string().describe("Repository owner, e.g. 'vercel'"),
  repo: z.string().describe("Repository name, e.g. 'next.js'"),
};

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  comments: number;
  created_at: string;
  user: { login: string } | null;
  labels: { name: string }[];
  pull_request?: unknown;
}

export const listIssues: AgentTool<{ owner: string; repo: string; state: "open" | "closed" | "all"; limit: number }> = {
  name: "github_list_issues",
  description: "List issues in a GitHub repository (pull requests excluded), newest first.",
  inputSchema: z.object({
    ...repoRef,
    state: z.enum(["open", "closed", "all"]).default("open"),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  async execute({ owner, repo, state, limit }) {
    // The issues endpoint also returns PRs, which we filter out — so fetch a full page (100),
    // not just `limit`. (Fetching limit×2 returned only 4 of 5 issues on a PR-heavy repo.)
    const items = (await gh(`/repos/${owner}/${repo}/issues?state=${state}&per_page=100`)) as GhIssue[];
    return items
      .filter((i) => !i.pull_request)
      .slice(0, limit)
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.map((l) => l.name),
        comments: i.comments,
        createdAt: i.created_at,
        url: i.html_url,
      }));
  },
};

export const getIssue: AgentTool<{ owner: string; repo: string; number: number }> = {
  name: "github_get_issue",
  description: "Read one GitHub issue: its body and up to 10 comments.",
  inputSchema: z.object({ ...repoRef, number: z.number().int().positive() }),
  async execute({ owner, repo, number }) {
    const issue = (await gh(`/repos/${owner}/${repo}/issues/${number}`)) as GhIssue;
    const comments = (await gh(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`)) as {
      user: { login: string } | null;
      body: string;
    }[];
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login,
      labels: issue.labels.map((l) => l.name),
      url: issue.html_url,
      body: truncate(issue.body),
      comments: comments.map((c) => ({ author: c.user?.login, body: truncate(c.body, 800) })),
    };
  },
};

export const commentOnIssue: AgentTool<{ owner: string; repo: string; number: number; body: string }> = {
  name: "github_comment_issue",
  description: "Post a comment on a GitHub issue. Visible to everyone, so it requires human approval.",
  inputSchema: z.object({ ...repoRef, number: z.number().int().positive(), body: z.string().min(1).max(5000) }),
  risky: true,
  async execute({ owner, repo, number, body }) {
    if (!process.env.GITHUB_TOKEN) throw new NonRetryableError("GITHUB_TOKEN is not set, so comments can't be posted.");
    const c = (await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    })) as { html_url: string };
    return { posted: true, url: c.html_url };
  },
};

export const githubTools = [listIssues, getIssue, commentOnIssue] as AgentTool[];
