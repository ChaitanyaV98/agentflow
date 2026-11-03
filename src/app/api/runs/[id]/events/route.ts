import { getSql } from "@/db";
import { eventsAfter, loadRun } from "@/runs/store";
import { isFinished, summarize } from "@/runs/view";

/**
 * Live run updates over Server-Sent Events.
 *
 *   event: trace   — one trace event (id = run_events.id, so the browser can resume)
 *   event: status  — the run's current summary (status, usage, pending approval, answer)
 *
 * How updates arrive: the worker saves events and runs `pg_notify('run_events', runId)` in the same
 * transaction. This handler LISTENs on that channel and sends whatever is new. A slow poll runs too,
 * as a safety net (e.g. behind a connection pooler that doesn't support LISTEN).
 *
 * Reconnects: EventSource sends `Last-Event-ID` automatically, and we resume from that event, so a
 * dropped connection never loses or repeats a step.
 */
// Serverless functions have a time limit; when it cuts the stream, EventSource reconnects with
// Last-Event-ID and carries on, so nothing is lost.
export const maxDuration = 300;

const POLL_MS = 3000;
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request, ctx: RouteContext<"/api/runs/[id]/events">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !(await loadRun(id))) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  let lastId = Number(req.headers.get("last-event-id") ?? 0) || 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown, eventId?: number) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`${eventId ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // Flushes are chained so two notifications arriving together can't send an event twice.
      let chain = Promise.resolve();
      const flush = () =>
        (chain = chain.then(async () => {
          if (closed) return;
          for (const row of await eventsAfter(id, lastId)) {
            send("trace", row.event, row.id);
            lastId = row.id;
          }
          const run = await loadRun(id);
          if (!run) return close();
          send("status", summarize(run.state));
          if (isFinished(run.state.status)) close();
        }).catch((e) => {
          send("stream_error", { message: e instanceof Error ? e.message : "stream error" });
          close();
        }));

      const listener = await getSql().listen("run_events", (payload) => {
        if (payload === id) void flush();
      });
      const poll = setInterval(() => void flush(), POLL_MS);
      const heartbeat = setInterval(() => !closed && controller.enqueue(encoder.encode(": ping\n\n")), HEARTBEAT_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        void listener.unlisten().catch(() => {});
        controller.close();
      }
      req.signal.addEventListener("abort", close);

      await flush();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
    },
  });
}
