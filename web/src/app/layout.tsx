import type { Metadata, Viewport } from "next";
import { RegistroServiceWorker } from "@/components/RegistroServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "NutriFamilia",
  description: "Plataforma familiar inteligente de alimentación",
  applicationName: "NutriFamilia",
  manifest: "/manifest.webmanifest",
  icons: {
    // El SVG es el original y sirve para las pestañas; los PNG existen porque
    // Android pide 192/512 para instalar y iOS ignora el manifiesto entero y
    // solo mira apple-touch-icon.
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "NutriFamilia",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#3a684d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CL" className="h-full">
      <head>
        {/* Manrope (titulares) + Inter (cuerpo) + iconos Material Symbols. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@600;700&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className="min-h-dvh antialiased">
        {children}
        <RegistroServiceWorker />
      </body>
    </html>
  );
}
