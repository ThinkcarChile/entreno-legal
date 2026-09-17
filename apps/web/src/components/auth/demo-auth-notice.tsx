import { Alert } from "@/components/ui/feedback";
import { isDemoMode } from "@/lib/data";

/**
 * En modo demostración no hay base de datos, así que no hay cuentas.
 * Se dice antes de que la persona llene el formulario, no después.
 */
export function DemoAuthNotice() {
  if (!isDemoMode()) return null;

  return (
    <Alert tone="info" title="Modo demostración">
      Los formularios validan igual que en producción, pero las cuentas se crean cuando se
      configura Supabase. Revisa <code className="font-mono text-xs">.env.example</code>.
    </Alert>
  );
}
