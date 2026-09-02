import { z } from "zod";
import {
  UNKNOWN_REASONS,
  known,
  money,
  parseMinor,
  unknown,
  type CurrencyCode,
  type MoneyOrUnknown,
} from "./money";

/**
 * EL BORDE DEL DINERO: lo que llega de la base entra como `bigint` o no entra.
 *
 * Vive en `domain/finance` y no junto a `lib/supabase/rows.ts` a propósito: los
 * helpers de allá (`nullableNumeric` = `z.coerce.number().nullable()`) son
 * correctos para cantidades y NO lo son para plata. Tenerlos en el mismo módulo
 * invita a autocompletar el equivocado justo en la pantalla donde más caro
 * sale. Acá no hay ningún `z.coerce.number()` y no puede haberlo: el guardián
 * `finanzas-invariantes.test.ts` lo prohíbe por regex en todo archivo que
 * mencione plata.
 *
 * Por qué no se usa `.transform(BigInt)` derecho, que es lo que pedía el
 * diseño: `BigInt("")` devuelve **0n**. Una celda vacía de PostgREST entraría
 * al panel como CERO PESOS sin que ninguna validación se queje, y
 * `BigInt("12.5")` lanza un `SyntaxError` crudo DENTRO del transform, que se
 * escapa del `safeParse`. Toda la validación pasa por `parseMinor`, que exige
 * `/^-?\d+$/` y rechaza el decimal en vez de truncarlo.
 */
export const moneyMinor = z
  .union([z.string(), z.number(), z.bigint()])
  .superRefine((valor, ctx) => {
    const leido = parseMinor(valor);
    if (!leido.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: leido.problema });
  })
  .transform((valor) => {
    const leido = parseMinor(valor);
    // Inalcanzable: el superRefine ya abortó. Si igual llegara, revienta acá y
    // no devuelve un cero de consuelo.
    if (!leido.ok) throw new Error(leido.problema);
    return leido.minor;
  });

/** `null` acá significa DESCONOCIDO, y viene siempre con su columna hermana de motivo. */
export const moneyMinorNullable = z.union([moneyMinor, z.null()]);

export const moneyStatus = z.enum(["KNOWN", "UNKNOWN"]);
export const unknownReason = z.enum(UNKNOWN_REASONS);
export const currencyCode = z.enum(["CLP", "USD", "EUR"]);

/**
 * Las tres columnas hermanas de la base (`*_minor`, `*_status`, `*_reason`)
 * leídas como UN valor.
 *
 * Es la única traducción legítima de la fila al dominio: separar las tres
 * columnas en tres campos sueltos es exactamente cómo un `?? 0` termina
 * mostrando "$0" donde la verdad era "no se sabe".
 */
export const moneyOrUnknownRow = z
  .object({
    minor: moneyMinorNullable,
    status: moneyStatus,
    reason: unknownReason.nullable(),
  })
  .superRefine((fila, ctx) => {
    const coherente =
      (fila.status === "KNOWN" && fila.minor !== null && fila.reason === null) ||
      (fila.status === "UNKNOWN" && fila.minor === null && fila.reason !== null);
    if (!coherente) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "monto incoherente: KNOWN exige monto sin motivo y UNKNOWN exige motivo sin monto",
      });
    }
  });

export function moneyOrUnknownDe(
  fila: z.infer<typeof moneyOrUnknownRow>,
  currency: CurrencyCode,
): MoneyOrUnknown {
  if (fila.status === "KNOWN" && fila.minor !== null) return known(money(currency, fila.minor));
  if (fila.reason === null) {
    // Inalcanzable con el schema puesto. Y si algún día se alcanza, revienta:
    // un desconocido SIN motivo es justo lo que el sprint no acepta.
    throw new Error("un monto desconocido llegó sin motivo");
  }
  return unknown(fila.reason);
}
