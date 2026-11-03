import { after } from "next/server";
import { driveRun } from "@/runs/drive";

// The work continues after the response (see `after` below) for up to this long.
export const maxDuration = 300;

/**
 * "Please make progress on this run." Called by the run page; returns at once and does the work in
 * the background. Idempotent: if another request already holds the run's lease, this is a no-op.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/runs/[id]/drive">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Bad run id" }, { status: 400 });

  after(async () => {
    try {
      await driveRun(id);
    } catch (e) {
      console.error(`[drive ${id}]`, e);
    }
  });
  return Response.json({ accepted: true }, { status: 202 });
}
