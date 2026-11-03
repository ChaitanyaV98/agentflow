"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { approveRun, createStoredRun, StaleRunError } from "@/runs/store";

export interface FormState {
  error?: string;
}

const Goal = z.string().trim().min(10, "Describe the goal in a sentence or two.").max(1000, "Keep the goal under 1,000 characters.");

export async function startRun(_: FormState, form: FormData): Promise<FormState> {
  const goal = Goal.safeParse(form.get("goal"));
  if (!goal.success) return { error: goal.error.issues[0].message };
  const { state } = await createStoredRun(goal.data);
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
