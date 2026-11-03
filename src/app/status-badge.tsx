import type { RunStatus } from "@/agent/types";

const STYLES: Record<RunStatus, { label: string; className: string }> = {
  planning: { label: "Planning", className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  executing: { label: "Working", className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  reviewing: { label: "Reviewing", className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  summarizing: { label: "Writing answer", className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  awaiting_approval: { label: "Needs approval", className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" },
  done: { label: "Done", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STYLES[status];
  const live = status !== "done" && status !== "failed" && status !== "awaiting_approval";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.className}`}>
      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </span>
  );
}
