import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { destinoInterno } from "@/lib/auth/destino";
import { origenPublico } from "@/lib/auth/origen";
import { alLogin } from "@/lib/auth/avisos";
import { registrarError } from "@/lib/observabilidad";

export const dynamic = "force-dynamic";

/**
 * GET /auth/callback — la vuelta de los correos de Supabase.
 *
 * Confirmar la cuenta y recuperar la clave salen por correo, y el correo trae un
 * enlace que pasa por Supabase y VUELVE acá. Esta ruta canjea lo que trae el
 * enlace por una sesión, escribe las cookies y manda a la persona a donde iba.
 *
 * DOS FORMAS DE VOLVER, y las dos se aceptan:
 *
 *   - `?code=…` — flujo PKCE, el que produce la configuración por omisión de los
 *     correos de Supabase. Se canjea con `exchangeCodeForSession`. Necesita la
 *     cookie del verificador que dejó `signUp` o `resetPasswordForEmail`, o sea:
 *     funciona si el correo se abre en EL MISMO navegador que pidió la cosa.
 *   - `?token_hash=…&type=…` — el hash del token, que se canjea con `verifyOtp`
 *     y no depende de ninguna cookie previa: sirve aunque el correo se abra en
 *     el teléfono cuando el registro se hizo en el computador. Requiere que la
 *     plantilla del correo apunte acá con esos parámetros (ver
 *     `docs/deployment/auth-produccion.md`).
 *
 * Ninguna de las dos inventa un token propio: son los mecanismos de Supabase.
 *
 * LO QUE NO SE HACE. No se registra `code` ni `token_hash` en ningún log: son
 * credenciales de un solo uso, y un log se lee. No se acepta un `next` que no
 * pase por `destinoInterno`: una vuelta de correo que redirige a donde diga la
 * URL es phishing con nuestro dominio en la barra. Y ante cualquier error la
 * respuesta es la misma —"ese enlace no sirve"— sin decir por qué.
 */

const TIPOS: ReadonlySet<string> = new Set<EmailOtpType>([
  "signup",
  "email",
  "recovery",
  "invite",
  "magiclink",
  "email_change",
]);

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const origen = await origenPublico();
  const next = destinoInterno(url.searchParams.get("next"));
  const aLogin = (aviso: Parameters<typeof alLogin>[0]) =>
    NextResponse.redirect(new URL(alLogin(aviso), origen), 303);

  // Supabase reenvía sus propios fallos como parámetros (enlace vencido, ya
  // usado). Se registra el código y nada más.
  const errorDelProveedor = url.searchParams.get("error");
  if (errorDelProveedor !== null) {
    // El `error_code` lo elige quien arma la URL: se ACOTA a una forma corta
    // conocida antes de registrarlo, para que este log no sea un tablón donde
    // cualquiera escribe. Lo que no calce entra como "otro".
    const crudo = url.searchParams.get("error_code") ?? errorDelProveedor;
    const codigo = /^[a-z_]{1,40}$/.test(crudo) ? crudo : "otro";
    registrarError("auth.callback.proveedor", { ruta: "/auth/callback", codigo });
    return aLogin("enlace-invalido");
  }

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  const supabase = await createSupabaseServer();

  if (code !== null && code !== "") {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      registrarError("auth.callback.canje", { ruta: "/auth/callback", codigo: error.code ?? null });
      return aLogin("enlace-invalido");
    }
  } else if (tokenHash !== null && tokenHash !== "" && type !== null && TIPOS.has(type)) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (error) {
      registrarError("auth.callback.verificacion", {
        ruta: "/auth/callback",
        codigo: error.code ?? null,
      });
      return aLogin("enlace-invalido");
    }
  } else {
    // Sin código ni token no hay nada que canjear. Llegar acá a mano no es un
    // ataque, pero tampoco es una sesión.
    registrarError("auth.callback.sin_codigo", { ruta: "/auth/callback" });
    return aLogin("enlace-invalido");
  }

  return NextResponse.redirect(new URL(next, origen), 303);
}
