import type { NextConfig } from "next";

/**
 * Origen de las imágenes subidas (fotos de perfil en Storage). Sin esto,
 * `next/image` rechaza toda foto subida por un usuario: la URL pública de
 * Supabase es de otro dominio y Next solo optimiza los que se declaran.
 */
function supabaseImagePatterns(): NonNullable<NextConfig["images"]>["remotePatterns"] {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return [];
  try {
    const { protocol, hostname } = new URL(url);
    return [
      {
        protocol: protocol.replace(":", "") as "https" | "http",
        hostname,
        pathname: "/storage/v1/object/public/**",
      },
    ];
  } catch {
    return [];
  }
}

/**
 * Cabeceras de seguridad para todas las rutas.
 *
 * La política de contenido es deliberadamente acotada: solo directivas que no
 * pueden romper scripts, estilos ni conexiones (Next hidrata con scripts en
 * línea, y Realtime abre WebSockets a Supabase). Lo que sí fija:
 *
 *  · `frame-ancestors 'none'`: nadie incrusta la aplicación en un iframe para
 *    engañar clics sobre «Aprobar» o «Pagar».
 *  · `form-action`: los formularios solo se envían a la propia aplicación y a
 *    Webpay. El paso a Transbank ES un formulario POST con el token: si esta
 *    lista no incluyera sus dos hosts, el pago dejaría de funcionar.
 *  · `object-src 'none'` y `base-uri 'self'`.
 *
 * Una política de scripts con nonces es el paso siguiente, y necesita probarse
 * en un navegador contra el proyecto alojado antes de activarse.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self' https://webpay3g.transbank.cl https://webpay3gint.transbank.cl",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // La ubicación la usa el check-in; la cámara, la evidencia. Nada más.
  {
    key: "Permissions-Policy",
    value: "geolocation=(self), camera=(self), microphone=(), payment=(), usb=()",
  },
  // Los navegadores la ignoran sobre http (localhost); en producción obliga HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns: supabaseImagePatterns(),
  },
  experimental: {
    serverActions: {
      // La evidencia y las pruebas de disputa admiten hasta 8 MB
      // (src/lib/storage/evidence.ts). El valor por omisión de Next es 1 MB, y
      // cortaba cualquier foto normal de un teléfono antes de llegar a validarla.
      // El margen cubre los encabezados del multipart.
      bodySizeLimit: "9mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
