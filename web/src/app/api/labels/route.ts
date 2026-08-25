import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { generateLabelsPdf, labelSnapshotSchema } from "@/lib/labels/pdf";

export const dynamic = "force-dynamic";

/**
 * GET /api/labels?jobs=id1,id2 → PDF real (§66) desde los SNAPSHOTS de los
 * print jobs (§40): lo impreso es lo congelado, no el estado vivo. RLS decide
 * qué jobs puede ver quien pide; un id ajeno simplemente no aparece.
 */
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "no autorizado" }, { status: 401 });

  const jobsParam = request.nextUrl.searchParams.get("jobs") ?? "";
  const ids = jobsParam.split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  if (ids.length === 0 || ids.length > 50) {
    return NextResponse.json({ error: "pide entre 1 y 50 etiquetas" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("label_print_jobs")
    .select("id, snapshot")
    .in("id", ids);
  if (error) return NextResponse.json({ error: "no se pudieron leer las etiquetas" }, { status: 500 });

  const filas = z
    .array(z.object({ id: z.string(), snapshot: z.unknown() }))
    .parse(data ?? []);
  if (filas.length === 0) return NextResponse.json({ error: "no autorizado" }, { status: 404 });

  // Zod en el borde (§65): un snapshot corrupto es un error dicho, no un PDF roto.
  const snapshots = [];
  for (const fila of filas) {
    const parsed = labelSnapshotSchema.safeParse(fila.snapshot);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `la etiqueta ${fila.id} tiene un snapshot ilegible` },
        { status: 422 },
      );
    }
    snapshots.push(parsed.data);
  }

  const origin = request.nextUrl.origin;
  const pdf = await generateLabelsPdf(snapshots, origin);

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="etiquetas-${snapshots.length}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
