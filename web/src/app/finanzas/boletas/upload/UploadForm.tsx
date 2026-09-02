"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runReceiptExtraction, setReceiptConsent, uploadReceipt } from "../actions";
import { Button, Card, ErrorNote, Icon, Notice } from "@/components/ui";

/**
 * Subir boleta: destino → archivo → consentimiento → subir → (si consintió)
 * leer → derechito a la revisión.
 *
 * Cada error se muestra tal cual; jamás un éxito falso. Y el destino se elige
 * ACÁ y no después ([H37]): una boleta que va a adjuntarse a una compra que ya
 * existe no puede recorrer también el camino que crea lotes, porque la
 * mercadería entraría dos veces.
 *
 * Campos de 48 px de alto: en 320 px, parado en la cocina, el pulgar necesita
 * blanco y no elegancia.
 */
const CAMPO =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 " +
  "font-body-md text-body-md text-on-surface min-h-[48px]";

export function UploadForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [paso, setPaso] = useState<string | null>(null);
  const [consiente, setConsiente] = useState(false);
  const [intent, setIntent] = useState("NEW_PURCHASE");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const data = new FormData(e.currentTarget);
    startTransition(async () => {
      setPaso("Subiendo la boleta…");
      const subida = await uploadReceipt(data);
      if (!subida.ok || subida.id === undefined) {
        setPaso(null);
        setError(subida.error ?? "No se pudo subir.");
        return;
      }
      const receiptId = subida.id;

      // [H35] La misma foto de nuevo no crea otra boleta: se va a la que existe.
      if (subida.duplicated === true) {
        router.push(`/finanzas/boletas/${receiptId}/review?ya=1`);
        return;
      }

      const consintio = data.get("consent") === "on";
      if (consintio) {
        setPaso("Registrando el consentimiento…");
        const consentimiento = await setReceiptConsent(receiptId, true, "AMBOS");
        if (!consentimiento.ok) {
          // Puede fallar legítimamente: autorizar el envío a un modelo externo
          // exige más permiso que subir la foto. Se dice y se sigue a mano.
          router.push(`/finanzas/boletas/${receiptId}/review?consentimiento=denegado`);
          return;
        }
        setPaso("Leyendo las líneas de la boleta…");
        const lectura = await runReceiptExtraction(receiptId);
        if (!lectura.ok) {
          router.push(`/finanzas/boletas/${receiptId}/review?lectura=fallida`);
          return;
        }
      }
      router.push(`/finanzas/boletas/${receiptId}/review`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-md">
      <Card className="space-y-md p-md">
        <fieldset>
          <legend className="mb-sm font-body-sm text-body-sm font-semibold text-on-surface">
            ¿Qué hacemos con esta boleta?
          </legend>
          <div className="space-y-sm">
            <label className="flex items-start gap-md">
              <input
                type="radio"
                name="intent"
                value="NEW_PURCHASE"
                checked={intent === "NEW_PURCHASE"}
                onChange={() => setIntent("NEW_PURCHASE")}
                className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-primary)]"
              />
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                <strong className="text-on-surface">Es una compra nueva.</strong> Al confirmarla,
                lo comprado entra a la despensa con su valor.
              </span>
            </label>
            <label className="flex items-start gap-md">
              <input
                type="radio"
                name="intent"
                value="ATTACH_TO_EXISTING"
                checked={intent === "ATTACH_TO_EXISTING"}
                onChange={() => setIntent("ATTACH_TO_EXISTING")}
                className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-primary)]"
              />
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                <strong className="text-on-surface">La mercadería ya llegó.</strong> Recibiste con
                la lista de compras y ahora aparece la boleta: acá solo se le pone precio a lo que
                ya está guardado, sin volver a meterlo.
              </span>
            </label>
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
            La boleta
          </span>
          <span className="mb-2 block font-body-sm text-body-sm text-on-surface-variant">
            Foto, PDF o texto · máximo 8 MB
          </span>
          <input
            type="file"
            name="file"
            required
            accept=".jpg,.jpeg,.png,.webp,.pdf,.txt,image/jpeg,image/png,image/webp,application/pdf,text/plain"
            className={`${CAMPO} file:mr-md file:rounded-full file:border-0 file:bg-primary-fixed file:px-md file:py-2 file:font-body-sm file:text-body-sm file:font-semibold file:text-on-primary-fixed`}
          />
        </label>
      </Card>

      <Card className="p-md">
        <label className="flex items-start gap-md">
          <input
            type="checkbox"
            name="consent"
            checked={consiente}
            onChange={(ev) => setConsiente(ev.target.checked)}
            className="mt-1 h-6 w-6 shrink-0 accent-[var(--color-primary)]"
          />
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            <strong className="text-on-surface">Consiento</strong> que esta boleta se lea
            automáticamente para <em>proponer</em> sus líneas. Una boleta lleva el nombre del
            comercio, la fecha, el medio de pago y lo que come esta casa: es información de todos
            los que viven acá, no solo tuya. Sin este consentimiento la boleta se guarda igual y se
            revisa a mano.
          </span>
        </label>
      </Card>

      {paso !== null && (
        <p className="flex items-center gap-sm font-body-sm text-body-sm text-on-surface-variant">
          <Icon name="progress_activity" className="animate-spin text-[18px]" />
          {paso}
        </p>
      )}
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <Notice icon="lock" tono="info">
        Nada de lo que se lea toca la despensa, los precios ni el gasto. Todo queda como propuesta
        hasta que confirmes línea por línea.
      </Notice>

      <Button type="submit" disabled={pending} full>
        {pending ? "Procesando…" : "Subir boleta"}
      </Button>
    </form>
  );
}
