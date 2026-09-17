import { NextResponse, type NextRequest } from "next/server";

import { createServerClient } from "@supabase/ssr";

/**
 * Refresco de sesión en el borde.
 *
 * Sin esto, los Server Components pueden leer una sesión expirada. Se ejecuta en
 * cada petición que no sea de recursos estáticos.
 *
 * `setAll` recibe también las cabeceras de caché que la librería necesita
 * propagar: sin ellas, un CDN podría cachear una respuesta con la sesión de otra
 * persona.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
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

  // Verifica la firma del token y refresca la sesión si está por vencer.
  // No se usa `getSession()`: leería la cookie sin revalidarla.
  await supabase.auth.getClaims();

  return response;
}
