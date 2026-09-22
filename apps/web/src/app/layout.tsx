import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import { ServiceWorkerSetup } from "@/components/layout/service-worker";
import { brand } from "@/config/brand";
import { seoKeywords, site } from "@/config/site";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name} — ${site.claim}`,
    template: `%s · ${site.shortName}`,
  },
  description: site.description,
  keywords: [...seoKeywords],
  applicationName: site.name,
  authors: [{ name: site.name, url: site.url }],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "es_CL",
    url: site.url,
    siteName: site.name,
    title: `${site.name} — ${site.claim}`,
    description: site.description,
  },
  twitter: {
    card: "summary_large_image",
    title: `${site.name} — ${site.claim}`,
    description: site.description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  formatDetection: { telephone: false },
  // La aplicación instalada usa su propia barra de estado, sin la del navegador.
  appleWebApp: {
    capable: true,
    title: site.shortName,
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: brand.canvas,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-CL" data-scroll-behavior="smooth" className={inter.variable}>
      <body className="min-h-dvh antialiased">
        {children}
        <ServiceWorkerSetup />
      </body>
    </html>
  );
}
