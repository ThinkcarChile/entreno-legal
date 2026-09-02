import Link from "next/link";
import { Card, Chip, EmptyState, ErrorNote, Icon, LinkButton } from "@/components/ui";
import type { Tono } from "@/components/ui";
import { Disclosure, Procedencia, ValorIncierto } from "./piezas";
import { enlaceDePregunta } from "@/app/inbox/vista";
import type { EstadoBandeja, InboxKind, ItemInbox } from "@/app/inbox/vista";

/**
 * La bandeja pintada.
 *
 * Recibe el estado ya decidido (`estadoDeBandeja`) en vez de una lista y un
 * booleano: así "no hay nada", "no hay nada para ti" y "no pude leer" son tres
 * ramas de un tipo y no tres formas de dibujar lo mismo. El día que alguien
 * agregue un cuarto caso, el switch no compila.
 */

const ETIQUETA: Record<InboxKind, string> = {
  SEGURIDAD_ALIMENTARIA: "Seguridad",
  CLINICO_BLOQUEANTE: "Clínico",
  FALTANTE_CONFIRMADO: "Faltó comida",
  VENCE_HOY: "Vence hoy",
  ACCION_PENDIENTE: "Te espera",
  PROPUESTA_VENCIDA: "Quedó vieja",
  REPOSICION: "Reponer",
  DATO_FALTANTE: "Falta un dato",
  SUGERENCIA: "Sugerencia",
};

/** El color acompaña; el texto del chip es el que comunica (§94). */
const TONO: Record<InboxKind, Tono> = {
  SEGURIDAD_ALIMENTARIA: "peligro",
  CLINICO_BLOQUEANTE: "peligro",
  FALTANTE_CONFIRMADO: "atencion",
  VENCE_HOY: "atencion",
  ACCION_PENDIENTE: "primario",
  PROPUESTA_VENCIDA: "neutro",
  REPOSICION: "info",
  DATO_FALTANTE: "info",
  SUGERENCIA: "neutro",
};

export function InboxList({ estado }: { estado: EstadoBandeja }) {
  switch (estado.k) {
    case "ERROR":
      return (
        <ErrorNote>
          No pude revisar tus pendientes
          {estado.fallo === "FORMA_INVALIDA"
            ? " (los datos no vinieron con la forma esperada)"
            : " (falló la consulta)"}
          . Esto NO significa que no haya nada: significa que no lo sé. Vuelve a
          intentarlo, y mientras tanto mira la despensa y el plan a mano.
        </ErrorNote>
      );

    case "SIN_NADA":
      return <EmptyState icon="task_alt">No hay nada pendiente en la casa.</EmptyState>;

    case "SIN_NADA_PARA_TI":
      // Distinto del anterior a propósito. La bandeja filtra por permiso: un
      // cocinero sin acceso clínico vería "no hay nada pendiente" mientras
      // existe un bloqueo sobre la cena que va a cocinar en dos horas. No se
      // puede afirmar la calma de toda la casa desde una lista recortada.
      return (
        <EmptyState icon="task_alt">
          No hay nada pendiente para ti. La bandeja muestra solo los avisos que
          te corresponden por tus permisos, así que puede haber otros que no ves.
        </EmptyState>
      );

    case "CON_ITEMS":
      return (
        <ul aria-live="polite" className="space-y-md">
          {estado.items.map((item) => (
            <li key={item.id}>
              <ItemCard item={item} />
            </li>
          ))}
        </ul>
      );
  }
}

function ItemCard({ item }: { item: ItemInbox }) {
  return (
    <Card as="article" className="p-md">
      <div className="flex flex-wrap items-center gap-xs">
        <Chip tono={TONO[item.kind]}>{ETIQUETA[item.kind]}</Chip>
        {item.ventana !== null && (
          <span className="font-label-md text-label-md text-on-surface-variant">
            <Icon name="schedule" className="mr-1 align-[-3px] text-[14px]" />
            hasta el {item.ventana}
          </span>
        )}
      </div>

      <p className="mt-sm font-body-md text-body-md text-on-surface">{item.titulo}</p>

      {item.unknowns.length > 0 && (
        <div className="mt-sm">
          <ValorIncierto unknowns={item.unknowns} />
        </div>
      )}

      {(item.detalle.length > 0 || item.procedencia.length > 0) && (
        <div className="mt-sm">
          <Disclosure resumen="¿Por qué?">
            {item.detalle.map((linea, i) => (
              <p key={`${i}-${linea.slice(0, 12)}`}>{linea}</p>
            ))}
            <Procedencia fuentes={item.procedencia} />
          </Disclosure>
        </div>
      )}

      <div className="mt-md flex flex-wrap items-center gap-sm">
        {item.proposalId !== null && (
          <LinkButton href={`/asistente/propuesta/${item.proposalId}`}>
            Ver y confirmar
          </LinkButton>
        )}
        {/*
          "Pregúntale al asistente" NO manda el texto del aviso: manda la
          referencia. El título lo compuso un motor con nombres que escribió
          alguien de la casa, y quien abre la bandeja puede tener más permisos
          que quien los escribió.
        */}
        <Link
          href={enlaceDePregunta(item)}
          className="inline-flex min-h-[44px] items-center gap-1 font-body-sm text-body-sm font-semibold text-primary"
        >
          <Icon name="chat" className="text-[18px]" />
          Pregúntale al asistente
        </Link>
      </div>
    </Card>
  );
}
