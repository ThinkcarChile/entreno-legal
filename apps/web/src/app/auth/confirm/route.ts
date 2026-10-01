import { NextResponse, type NextRequest } from "next/server";

import {
  authLinkErrorPath,
  classifyAuthLinkError,
  parseConfirmLink,
} from "@/lib/auth/email-link";
import { hasSupabaseCredentials } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * Enlaces de correo con `token_hash`: confirmar la cuenta, crear una
 * contraseña nueva, confirmar un cambio de correo.
 *
 * A diferencia de `/auth/callback`, no depende de nada guardado en el
 * navegador que pidió el correo: funciona abierto desde otro navegador, desde
 * la app de correo o desde otro dispositivo. Ver `lib/auth/email-link.ts`.
 *
 * Para que los correos traigan este enlace hay que cambiar las plantillas en el
 * panel de Supabase (`docs/DESPLIEGUE-SUPABASE.md` §4.1.c).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const link = parseConfirmLink(searchParams);

  if (!link.ok) {
    return NextResponse.redirect(`${origin}${authLinkErrorPath(link.type, "enlace-invalido")}`);
  }
  if (!hasSupabaseCredentials) {
    return NextResponse.redirect(`${origin}${authLinkErrorPath(link.type, "auth")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type: link.type, token_hash: link.tokenHash });

  if (error) {
    // Ni el token ni el texto de Supabase: el código basta para diagnosticar.
    console.error("[auth/confirm] Supabase rechazó el enlace", {
      type: link.type,
      code: error.code ?? null,
      status: error.status ?? null,
    });
    return NextResponse.redirect(
      `${origin}${authLinkErrorPath(link.type, classifyAuthLinkError(error.code))}`,
    );
  }

  // La sesión ya quedó en las cookies de esta respuesta.
  return NextResponse.redirect(`${origin}${link.next}`);
}

/**
 * Un `HEAD` no consume el enlace.
 *
 * Sin esto Next responde un `HEAD` ejecutando `GET`, y el enlace es de un solo
 * uso: un filtro de correo que «revisa» los enlaces con `HEAD` antes de
 * entregarlos lo dejaría gastado antes de que la persona lo abra.
 */
export function HEAD() {
  return new Response(null, { status: 204 });
}
