import { Alert } from "@/components/ui/feedback";
import { extensionReturnNotice } from "@/lib/payments/return-target";

/**
 * El aviso del cobro del tiempo adicional al volver de Webpay.
 *
 * Vive en la página de la asignación porque es ahí adonde vuelve ese cobro: la
 * pantalla de pago es la del trabajo, que ya está pagado, y mandarlo allí era
 * lo que terminaba en «Pago confirmado» con el cobro rechazado.
 */
export function ExtensionReturnNotice({
  pago,
  className,
}: {
  pago: string | undefined;
  className?: string;
}) {
  const notice = extensionReturnNotice(pago);
  if (!notice) return null;
  return (
    <Alert tone={notice.tone} className={className} title={notice.title}>
      {notice.body}
    </Alert>
  );
}
