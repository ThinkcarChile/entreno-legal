import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Proxy (antes "middleware").
 *
 * Su única responsabilidad es refrescar la sesión de Supabase. La autorización real
 * vive en las políticas RLS de la base de datos: esto no es una barrera de
 * seguridad, es una mejora de experiencia.
 */
export default async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Todas las rutas excepto recursos estáticos y archivos con extensión.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest)$).*)",
  ],
};
