import { Lock, MapPin } from "lucide-react";

import type { JobLocation } from "@/lib/domain/types";

/**
 * Ubicación de un trabajo.
 *
 * Antes de la asignación se muestra comuna, región y el nombre del lugar. La
 * dirección exacta solo llega desde la base cuando quien mira tiene derecho a
 * verla, así que aquí no hay nada que decidir: o viene o no viene.
 *
 * El motivo no es formal: en un trabajo de madrugada, publicar la dirección
 * exacta a cualquiera que abra la página es un riesgo para las dos partes.
 */
export function JobLocationBlock({ location }: { location: JobLocation }) {
  return (
    <div className="flex gap-3.5">
      <MapPin size={18} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">Dónde</p>
        <div className="mt-1 text-[0.9375rem] text-ink-700">
          {location.placeName && (
            <span className="block font-medium text-ink-900">{location.placeName}</span>
          )}

          {location.exact ? (
            <>
              <span className="block">{location.exact.addressLine}</span>
              {location.exact.addressNotes && (
                <span className="mt-1 block text-sm text-ink-500">
                  {location.exact.addressNotes}
                </span>
              )}
            </>
          ) : (
            <span className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-500">
              <Lock size={13} aria-hidden="true" />
              La dirección exacta se comparte al aceptar una oferta
            </span>
          )}

          <span className="mt-1 block text-ink-500">
            {location.communeName}, {location.regionName}
          </span>
        </div>
      </div>
    </div>
  );
}
