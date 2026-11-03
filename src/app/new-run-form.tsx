"use client";

import { useActionState, useState } from "react";
import { startRun, type FormState } from "./actions";

const EXAMPLES = [
  "Using the shop database: which product category earned the most revenue from paid orders in the last 30 days, and how does that compare with the 30 days before?",
  "Look at the 5 newest open issues in vercel/swr, read the two that look most like real bugs, and tell me which one to fix first and why.",
  "Read the 3 newest open issues in vercel/swr and email a short summary of them to team@example.com.",
];

export function NewRunForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(startRun, {});
  const [goal, setGoal] = useState("");

  return (
    <form action={action} className="space-y-3">
      <textarea
        name="goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={3}
        placeholder="Describe a goal…"
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setGoal(e)}
              className="max-w-xs truncate rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 hover:border-indigo-400 hover:text-indigo-700 dark:border-zinc-700 dark:text-zinc-400"
              title={e}
            >
              {e}
            </button>
          ))}
        </div>
        <button
          disabled={pending || goal.trim().length < 10}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Starting…" : "Run agents"}
        </button>
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
