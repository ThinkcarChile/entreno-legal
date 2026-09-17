import { Info } from "lucide-react";

export function AuthNotice() {
  return (
    <p className="flex gap-2.5 rounded-[var(--radius-control)] border border-brand-100 bg-brand-50/70 px-4 py-3 text-sm text-brand-800">
      <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        Estás viendo la aplicación en modo demostración. El formulario valida igual que en
        producción, pero las cuentas se crean cuando se configura Supabase.
      </span>
    </p>
  );
}
