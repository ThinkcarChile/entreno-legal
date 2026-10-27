/**
 * Qué decirle a la persona cuando Storage rechaza una subida hecha desde el
 * navegador. Storage contesta en inglés y con detalles internos; aquí se
 * traducen los casos que de verdad ocurren y el resto queda en un mensaje
 * general, sin datos técnicos.
 */
export function uploadErrorMessage(error: unknown): string {
  const record = (error ?? {}) as { message?: unknown; statusCode?: unknown; status?: unknown };
  const message = String(record.message ?? "").toLowerCase();
  const status = String(record.statusCode ?? record.status ?? "");

  if (status === "413" || message.includes("maximum allowed size") || message.includes("too large")) {
    return "El archivo supera los 8 MB.";
  }
  if (message.includes("mime type") || status === "415") {
    return "Solo aceptamos imágenes JPG, PNG, WebP o un PDF.";
  }
  if (status === "403" || message.includes("row-level security") || message.includes("unauthorized")) {
    return "No pudimos guardar el archivo: puede que el trabajo ya no admita archivos o que llegaste al máximo permitido.";
  }
  if (message.includes("fetch") || message.includes("network")) {
    return "No pudimos subir el archivo. Revisa tu conexión e inténtalo de nuevo.";
  }
  return "No pudimos subir el archivo. Inténtalo de nuevo.";
}
