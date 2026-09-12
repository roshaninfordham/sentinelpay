import { buildReceipt } from "@/lib/receipt";

export const dynamic = "force-dynamic";

// JSON incident receipt. The printable version lives at /incident/{id}.
export async function GET(_req: Request, ctx: RouteContext<"/api/incident/[id]">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await buildReceipt(id));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 404 });
  }
}
