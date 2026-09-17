import { NextResponse, type NextRequest } from "next/server";

import { hasSupabaseCredentials } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * Retorno del enlace de confirmación de Supabase Auth.
 * Intercambia el código por una sesión y redirige al destino solicitado.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/trabajos";

  if (!code || !hasSupabaseCredentials) {
    return NextResponse.redirect(`${origin}/entrar?error=auth`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) return NextResponse.redirect(`${origin}/entrar?error=auth`);
  return NextResponse.redirect(`${origin}${next}`);
}
