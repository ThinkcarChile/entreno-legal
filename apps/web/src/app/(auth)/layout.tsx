import Link from "next/link";

import { Logo } from "@/components/layout/logo";
import { site } from "@/config/site";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="container-page flex h-16 items-center">
        <Link href="/" aria-label={site.name}>
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-5 py-8 sm:items-center sm:py-12">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
