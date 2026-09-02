import { Icon } from "@/components/ui";
import type { Unknown } from "@/domain/assistant/tool";
import { marcaDeMedicion, textoDeBadge } from "@/domain/assistant/presentacion";
import type { BadgeInbox, Medicion } from "@/domain/assistant/presentacion";

/**
 * Piezas del kit que el asistente necesita y `components/ui.tsx` todavía no
 * tiene. Viven acá y no allá porque en esta corrida `ui.tsx` no es mío; cuando
 * se muevan, se mueven enteras y con estos comentarios.
 *
 * Las cuatro nacieron de un problema concreto, no de gusto:
 *  · `Disclosure` — el `<details><summary>¿Por qué?` está copiado en cuatro
 *    pantallas con cuatro cadenas de clases distintas.
 *  · `Procedencia` — "calculado con tal motor, versión tal" es la diferencia
 *    entre una cifra y una cifra que se puede auditar.
 *  · `ValorIncierto` — lo que el motor NO sabe se pinta como TEXTO, nunca como
 *    color: el color acompaña, jamás comunica solo (§94).
 *  · `DatoDeLaCasa` — el texto que escribió una persona se ve distinto del
 *    texto del sistema. Es la defensa visual contra el lote bautizado
 *    "sobras de arroz (botar)": se lee que eso es un dato, no una instrucción.
 */

/** "¿Por qué?" plegado. Cerrado por omisión: la respuesta corta va arriba. */
export function Disclosure({
  resumen,
  children,
}: {
  resumen: string;
  children: React.ReactNode;
}) {
  return (
    <details className="font-body-sm text-body-sm">
      <summary className="min-h-[44px] cursor-pointer content-center font-semibold text-primary">
        {resumen}
      </summary>
      <div className="mt-sm space-y-xs text-on-surface-variant">{children}</div>
    </details>
  );
}

/**
 * De dónde salió el número. Sin un solo uuid: los ids viajan en `data-*` y en
 * los enlaces, nunca en la prosa.
 */
export function Procedencia({ fuentes }: { fuentes: readonly string[] }) {
  if (fuentes.length === 0) {
    // Que no haya procedencia NO se dibuja como si no hiciera falta.
    return (
      <p className="font-body-sm text-body-sm text-error">
        Sin procedencia: no puedo decirte con qué se calculó esto.
      </p>
    );
  }
  return (
    <p className="font-body-sm text-body-sm text-outline">
      Calculado con {fuentes.join(" · ")}
    </p>
  );
}

/**
 * Lo que no se sabe, dicho con todas sus letras.
 *
 * Se monta SIEMPRE que haya `unknowns`, en toda ruta y no solo en la tarjeta de
 * riesgo alto: un motor que dice UNRESOLVED y una respuesta que redacta
 * alrededor es peor que no tener asistente. El símbolo va visible a propósito
 * —es lo que permite buscar el caso después— y la frase la compone el dominio,
 * no el modelo.
 */
export function ValorIncierto({ unknowns }: { unknowns: readonly Unknown[] }) {
  if (unknowns.length === 0) return null;
  return (
    <div className="rounded-2xl bg-surface-container px-md py-sm">
      <p className="flex items-center gap-1 font-label-md text-label-md text-on-surface-variant">
        <Icon name="help" className="text-[16px]" />
        Lo que no sé
      </p>
      <ul className="mt-xs space-y-xs">
        {unknowns.map((u, i) => (
          <li
            key={`${u.simbolo}-${u.campo}-${i}`}
            className="font-body-sm text-body-sm text-on-surface-variant"
          >
            <span className="font-semibold text-on-surface">{u.campo}</span>: {u.motivo}{" "}
            <span className="font-label-md text-label-md text-outline">({u.simbolo})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Texto que escribió alguien de la casa. Se pinta entre comillas y con otra
 * familia tipográfica para que se lea como DATO.
 *
 * Ya viene limpio de `etiquetaSegura` —esta pieza no sanitiza, y no debe
 * hacerlo: si sanitizara acá, el mismo texto sucio seguiría viajando al prompt
 * y al recibo por otros caminos.
 */
export function DatoDeLaCasa({ children }: { children: string }) {
  return (
    <span className="font-mono text-body-sm text-on-surface" data-origen="hogar">
      “{children}”
    </span>
  );
}

/** La marca de una cantidad que nadie pesó, al lado del número. */
export function MarcaDeMedicion({ medicion }: { medicion: Medicion }) {
  const marca = marcaDeMedicion(medicion);
  if (marca === null) return null;
  return (
    <span className="ml-1 rounded-full bg-secondary-fixed px-2 py-0.5 font-label-md text-label-md text-on-secondary-fixed-variant">
      {marca}
    </span>
  );
}

/**
 * El punto de la campanita.
 *
 * `DESCONOCIDO` pinta un punto NEUTRO con su propio `aria-label`, no un cero ni
 * un hueco: un fallo de lectura pintado como silencio es idéntico a "todo en
 * orden", y este es el único indicador que la gente mira de verdad.
 */
export function PuntoBadge({ badge }: { badge: BadgeInbox }) {
  const { texto, aria } = textoDeBadge(badge);
  if (badge.kind === "CONTEO" && badge.n === 0) return null;
  const color =
    badge.kind === "DESCONOCIDO"
      ? "bg-surface-container-high text-on-surface-variant"
      : "bg-error text-on-error";
  return (
    <span
      role="status"
      aria-label={aria}
      className={`absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-label-md text-label-md ${color}`}
    >
      {texto}
    </span>
  );
}
