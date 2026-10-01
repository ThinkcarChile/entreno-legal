import { NextResponse, type NextRequest } from "next/server";

import { authLinkErrorPath, classifyAuthLinkError } from "@/lib/auth/email-link";
import { hasSupabaseCredentials } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/utils/safe-redirect";

/**
 * Retorno del enlace de confirmación de Supabase Auth (flujo PKCE).
 * Intercambia el código por una sesión y redirige al destino solicitado.
 *
 * Solo funciona en el navegador donde se pidió el correo: el verificador del
 * código vive en una cookie de ese navegador. Los enlaces que se abren en otro
 * lado van por `/auth/confirm`; esta ruta queda para los correos que todavía
 * traen el enlace antiguo.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Solo rutas internas: el parámetro lo controla quien arma el enlace.
  const next = safeNextPath(searchParams.get("next"));
  // Un enlace de contraseña nueva que falla vuelve a donde se pide otro.
  const tipo = next.startsWith("/nueva-clave") ? "recovery" : null;

  if (!hasSupabaseCredentials) {
    return NextResponse.redirect(`${origin}${authLinkErrorPath(tipo, "auth")}`);
  }
  if (!code) {
    // Supabase devuelve aquí el motivo cuando el enlace ya no sirve
    // (`error_code=otp_expired`, por ejemplo).
    const motivo = classifyAuthLinkError(searchParams.get("error_code"));
    return NextResponse.redirect(`${origin}${authLinkErrorPath(tipo, motivo)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] no se pudo canjear el código", {
      code: error.code ?? null,
      status: error.status ?? null,
    });
    return NextResponse.redirect(
      `${origin}${authLinkErrorPath(tipo, classifyAuthLinkError(error.code))}`,
    );
  }
  return NextResponse.redirect(`${origin}${next}`);
}
