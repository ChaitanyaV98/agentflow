import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { loadRun } from "@/runs/store";
import { summarize } from "@/runs/view";
import { RunView } from "./run-view";

export default function RunPage({ params }: PageProps<"/runs/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading run…</p>}>
      <RunLoader params={params} />
    </Suspense>
  );
}

async function RunLoader({ params }: { params: PageProps<"/runs/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const run = /^[0-9a-f-]{36}$/i.test(id) ? await loadRun(id) : null;
  if (!run) notFound();
  // Only the summary goes to the browser; the trace streams in over SSE.
  return <RunView initial={summarize(run.state)} />;
}
