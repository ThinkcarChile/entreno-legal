"use client";

/**
 * §51 — LA ÚLTIMA RED. Se muestra cuando revienta el propio armazón: el layout
 * raíz, un provider, o el `error.tsx` que debería haber atajado el problema.
 *
 * Next NO renderiza el layout raíz para esta pantalla, así que este archivo trae
 * su propio `<html>` y su propio `<body>`. Por lo mismo NO usa el kit de
 * componentes ni las clases de `globals.css`: si la hoja de estilos es
 * justamente lo que no cargó, una pantalla de error sin estilos es texto blanco
 * sobre blanco y la persona ve una página en blanco — que es exactamente el modo
 * de falla que esto existe para evitar. Todo va en `style`, sin depender de nada.
 *
 * QUÉ NO HACE: no vuelca el error. `error.message` puede traer la fila que
 * PostgreSQL estaba rechazando (§50), y esta pantalla la puede estar mirando
 * alguien que no es dueño de ese dato. Sale el `digest` —el identificador que
 * Next le pone al error en el log del servidor— y nada más: con eso se busca en
 * el log, y el log ya está filtrado por `lib/observabilidad.ts`.
 *
 * En castellano y con salida: "Application error: a client-side exception has
 * occurred" es lo que veía la familia antes de que existiera esta pantalla.
 */
export default function ErrorDelArmazon({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es-CL">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          backgroundColor: "#f6f8f6",
          color: "#1a1c1a",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <main
          style={{
            width: "100%",
            maxWidth: "28rem",
            backgroundColor: "#ffffff",
            border: "1px solid #d5dbd5",
            borderRadius: "16px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "22px", lineHeight: 1.3, margin: "0 0 12px" }}>
            La aplicación no pudo cargar
          </h1>
          <p style={{ fontSize: "15px", lineHeight: 1.5, margin: "0 0 8px", color: "#42493f" }}>
            Falló algo del armazón, no tus datos. Nada de lo que tienes guardado se
            tocó: esto es un error al MOSTRAR, no un estado real de tu casa.
          </p>
          <p style={{ fontSize: "15px", lineHeight: 1.5, margin: "0 0 20px", color: "#42493f" }}>
            Reintenta. Si vuelve a pasar, cierra la aplicación y ábrela de nuevo.
          </p>

          {error.digest !== undefined && (
            <p style={{ fontSize: "13px", margin: "0 0 20px", color: "#72796f" }}>
              Código: {error.digest}
            </p>
          )}

          <button
            type="button"
            onClick={reset}
            style={{
              width: "100%",
              minHeight: "56px",
              border: "none",
              borderRadius: "28px",
              backgroundColor: "#3a684d",
              color: "#ffffff",
              fontSize: "16px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reintentar
          </button>
        </main>
      </body>
    </html>
  );
}
