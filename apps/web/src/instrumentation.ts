import type { Instrumentation } from "next";

/**
 * Registro de errores del servidor.
 *
 * Sin proveedor externo (elegir uno es una decisión pendiente): una línea en el
 * registro del servidor por cada error que Next captura al renderizar, en una
 * ruta o en una acción. Next ya imprime el error completo; esta línea agrega lo
 * que permite encontrarlo cuando alguien escribe a soporte con la referencia
 * que le mostró la pantalla de error: el `digest`, la ruta y el tipo.
 *
 * Solo la ruta, sin la consulta: la URL puede llevar un `token_hash` de
 * Supabase o un `token_ws` de Webpay, y un registro no es lugar para eso.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest: unknown }).digest)
      : null;
  const name = error instanceof Error ? error.name : typeof error;

  console.error("[error] petición con error no controlado", {
    digest,
    tipo: name,
    metodo: request.method,
    ruta: request.path.split("?")[0],
    archivo: context.routePath,
    origen: context.routeType,
  });
};
