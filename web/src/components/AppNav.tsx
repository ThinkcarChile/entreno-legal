import Link from "next/link";

export function AppNav({ active }: { active: "family" | "catalog" | "recipes" }) {
  const base = "rounded-full px-4 py-1.5 text-sm font-medium";
  const on = "bg-[var(--accent)] text-white";
  const off = "text-[var(--accent)] border border-[var(--accent)]";
  return (
    <nav className="sticky top-0 z-10 -mx-4 mb-2 flex gap-2 bg-[var(--paper)] px-4 py-3">
      <Link href="/family" className={`${base} ${active === "family" ? on : off}`}>
        Familia
      </Link>
      <Link href="/catalog" className={`${base} ${active === "catalog" ? on : off}`}>
        Catálogo
      </Link>
      <Link href="/recipes" className={`${base} ${active === "recipes" ? on : off}`}>
        Recetas
      </Link>
    </nav>
  );
}
