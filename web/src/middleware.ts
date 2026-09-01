import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { hasSupabaseEnv, getSupabaseEnv } from "@/lib/supabase/env";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/** Refresca la sesión de Supabase en cada request (patrón @supabase/ssr). */
export async function middleware(request: NextRequest) {
  if (!hasSupabaseEnv()) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}

/**
 * Todo lo que se excluye acá son archivos servidos desde public/ o generados
 * por Next: no tienen sesión que refrescar, y hacerlos pasar por el middleware
 * les cuelga un supabase.auth.getUser() a cada pedido.
 *
 * Con el service worker eso deja de ser solo desperdicio y se vuelve un modo de
 * falla: al instalarse, el worker baja /sin-conexion.html, el manifiesto y los
 * iconos, y el navegador baja /sw.js. Si Supabase está caído y el middleware
 * contesta 500 en /sin-conexion.html, el worker no se instala. Fuera del
 * matcher, esos archivos salen del disco pase lo que pase con la base.
 * Lo vigila pwa-coherencia.test.ts.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|apple-touch-icon.png|sin-conexion.html|sw.js|icons/).*)",
  ],
};
