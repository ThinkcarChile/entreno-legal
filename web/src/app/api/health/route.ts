import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { registrarError } from "@/lib/observabilidad";

export const dynamic = "force-dynamic";

/**
 * GET /api/health (§51) — ¿está viva la app Y le contesta la base?
 *
 * SIN SESIÓN A PROPÓSITO, y por eso lo que devuelve está contado con los dedos:
 *
 *   { ok: boolean, version: string | null, schema: string | null }
 *
 * Nada más. Ni el mensaje del error, ni la URL de Supabase, ni conteos, ni la
 * versión de Postgres. Un endpoint de salud es lo primero que mira quien está
 * tanteando un sitio ajeno: todo lo que diga de más es reconocimiento gratis.
 * El motivo real de una caída va al log del servidor con `registrarError`, que
 * es donde lo puede leer quien opera y no quien pasa.
 *
 * POR QUÉ TOCA LA BASE. "El proceso de Node responde" no es "la app funciona":
 * la familia se queda sin nada si Supabase está caído y el proceso sigue vivo.
 * La sonda es una lectura como `anon` sobre una tabla con RLS: devuelve CERO
 * filas siempre —anon no tiene ninguna política a su favor en las 59
 * migraciones— así que prueba que PostgREST contesta sin exponer ni una fila.
 *
 * POR QUÉ `version` Y `schema` PUEDEN SER null. Las declara el despliegue en
 * `APP_VERSION` y `SCHEMA_VERSION` (ver `docs/deployment/entornos.md`). Si no
 * están, la respuesta es `null` y no un "0.0.0" inventado: UNKNOWN != ZERO. Un
 * número inventado acá es peor que ninguno, porque el día del incidente alguien
 * va a creer que sabe qué versión está corriendo.
 */
export async function GET() {
  const version = process.env.APP_VERSION ?? null;
  const schema = process.env.SCHEMA_VERSION ?? null;

  if (!hasSupabaseEnv()) {
    // Sin configuración no hay a quién preguntarle. Decirlo es lo honesto;
    // responder ok:true porque el proceso está vivo, no.
    registrarError("health.sin_configuracion", { ruta: "/api/health" });
    return NextResponse.json({ ok: false, version, schema }, { status: 503 });
  }

  try {
    const supabase = await createSupabaseServer();
    // SE CUENTA, NO SE LEE UNA FILA. Antes esto era `.select("id").limit(1)`, y
    // el guardián de hogar-determinista lo cachó con razón: una lectura de UNA
    // fila de `households` sin orden ni ancla devuelve el hogar que el
    // planificador quiera, y eso en esta app es cómo alguien termina viendo la
    // casa de otro. Acá ni siquiera hace falta: lo que se comprueba es que la
    // base CONTESTE, no qué contesta, así que un conteo con cabecera responde lo
    // mismo sin traer una sola fila de nadie.
    const { error } = await supabase
      .from("households")
      .select("id", { count: "exact", head: true });
    if (error) {
      registrarError("health.base_no_responde", { ruta: "/api/health", codigo: error.code });
      return NextResponse.json({ ok: false, version, schema }, { status: 503 });
    }
  } catch {
    // Una excepción acá (DNS, TLS, red) no puede convertirse en un 200: eso es
    // exactamente el falso verde que un endpoint de salud existe para no dar.
    registrarError("health.excepcion", { ruta: "/api/health" });
    return NextResponse.json({ ok: false, version, schema }, { status: 503 });
  }

  return NextResponse.json({ ok: true, version, schema });
}
