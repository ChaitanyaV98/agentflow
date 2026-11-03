"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { approveRun, createStoredRun, recentRunCounts, StaleRunError } from "@/runs/store";

// Public-demo limits: every run spends free-tier model quota.
const RUNS_PER_HOUR_PER_IP = Number(process.env.RUNS_PER_HOUR_PER_IP ?? 5);
const RUNS_PER_DAY = Number(process.env.RUNS_PER_DAY ?? 40);

export interface FormState {
  error?: string;
}

const Goal = z.string().trim().min(10, "Describe the goal in a sentence or two.").max(1000, "Keep the goal under 1,000 characters.");

export async function startRun(_: FormState, form: FormData): Promise<FormState> {
  const goal = Goal.safeParse(form.get("goal"));
  if (!goal.success) return { error: goal.error.issues[0].message };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "local";
  const { byIp, total } = await recentRunCounts(ip);
  if (byIp >= RUNS_PER_HOUR_PER_IP) return { error: `Demo limit: ${RUNS_PER_HOUR_PER_IP} runs per hour. Try again later.` };
  if (total >= RUNS_PER_DAY) return { error: "The demo has hit its daily limit. Try again tomorrow." };

  const { state } = await createStoredRun(goal.data, {}, ip);
  redirect(`/runs/${state.id}`);
}

export async function decide(runId: string, approved: boolean, reason?: string): Promise<FormState> {
  try {
    await approveRun(runId, approved, reason?.trim() || undefined);
    return {};
  } catch (e) {
    // Two tabs (or a double click) deciding at once: the versioned save lets exactly one win.
    if (e instanceof StaleRunError) return { error: "This approval was already answered." };
    if (e instanceof Error && /not awaiting approval/.test(e.message)) return { error: "This approval was already answered." };
    throw e;
  }
}
