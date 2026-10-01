import type { Metadata } from "next";
import Link from "next/link";

import { AlertTriangle, BadgeCheck, Banknote, MapPin, ShieldAlert, Timer } from "lucide-react";

import { AcknowledgeIntegrityAlerts } from "@/components/admin/acknowledge-integrity-alerts";
import { Card, CardContent, Stat } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData, isDemoMode, type IntegrityAlert } from "@/lib/data";
import { formatDateTime } from "@/lib/utils/datetime";
import { formatPercent, formatNumber } from "@/lib/utils/format";
import { formatMoney } from "@/lib/utils/money";

export const metadata: Metadata = {
  title: "Panel de administración",
  robots: { index: false, follow: false },
};

export default async function AdminDashboardPage() {
  // El panel exige rol de administrador. Esconder el enlace no es una medida de
  // seguridad; esto sí, y la base lo vuelve a comprobar en cada consulta.
  await requireAdmin("/admin");

  const data = getData();
  const [kpis, queues, alerts] = await Promise.all([
    data.admin.getKpis(),
    data.admin.getQueues(),
    // Si no se pueden leer, el resumen se muestra igual y lo dice: no saber
    // si algo está roto no es lo mismo que saber que no lo está.
    data.admin.listIntegrityAlerts().catch((error: unknown) => {
      console.error("[admin] no se pudieron leer las alertas de integridad", {
        code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
      });
      return null;
    }),
  ]);

  return (
    <div className="container-page py-8 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-h2 text-ink-950">Resumen</h1>
          <p className="mt-1 text-ink-600">Indicadores de los últimos 30 días.</p>
        </div>
        {isDemoMode() && (
          <p className="rounded-full bg-warning-50 px-3 py-1.5 text-caption font-medium text-warning-700 ring-1 ring-warning-100 ring-inset">
            Datos de demostración
          </p>
        )}
      </header>

      <IntegrityAlerts alerts={alerts} />

      <section className="mt-8">
        <h2 className="text-small font-semibold tracking-wide text-ink-500 uppercase">Negocio</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="GMV" value={formatMoney(kpis.gmv)} hint="Volumen bruto transado" />
          <Stat
            label="Ingresos plataforma"
            value={formatMoney(kpis.platformRevenue)}
            hint="Comisión neta de descuentos"
          />
          <Stat label="Ticket promedio" value={formatMoney(kpis.averageTicket)} />
          <Stat label="Tasa de éxito" value={formatPercent(kpis.successRate, 1)} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-small font-semibold tracking-wide text-ink-500 uppercase">Actividad</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Trabajos publicados" value={formatNumber(kpis.jobsPublished)} />
          <Stat label="Trabajos completados" value={formatNumber(kpis.jobsCompleted)} />
          <Stat label="Usuarios nuevos" value={formatNumber(kpis.newUsers30d)} />
          <Stat label="Trabajadores activos" value={formatNumber(kpis.activeWorkers)} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-small font-semibold tracking-wide text-ink-500 uppercase">
          Requiere atención
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <QueueCard
            href="/admin/verificaciones"
            icon={<BadgeCheck size={18} aria-hidden="true" />}
            label="Verificaciones pendientes"
            value={kpis.pendingVerifications}
            tone="text-brand-600"
          />
          <QueueCard
            href="/admin/check-ins"
            icon={<MapPin size={18} aria-hidden="true" />}
            label="Llegadas por revisar"
            value={queues.checkIns}
            tone="text-warning-600"
          />
          <QueueCard
            href="/admin/disputas"
            icon={<ShieldAlert size={18} aria-hidden="true" />}
            label="Disputas abiertas"
            value={queues.disputes}
            tone="text-danger-600"
          />
          <QueueCard
            href="/admin/payouts"
            icon={<Banknote size={18} aria-hidden="true" />}
            label="Pagos a trabajadores por resolver"
            value={queues.payouts}
            tone="text-success-600"
          />
          <QueueCard
            icon={<Timer size={18} aria-hidden="true" />}
            label="Extensiones esperando respuesta"
            value={queues.extensions}
            tone="text-brand-600"
          />
          <QueueCard
            href="/admin/pagos?filtro=review"
            icon={<AlertTriangle size={18} aria-hidden="true" />}
            label="Devoluciones por procesar"
            value={queues.refunds}
            tone="text-warning-600"
          />
        </div>
      </section>

      <Card className="mt-8">
        <CardContent>
          <h2 className="text-base font-semibold text-ink-950">Qué queda por hacer a mano</h2>
          <p className="mt-2 text-small text-ink-600">
            Las transferencias a los trabajadores se hacen fuera de la plataforma y se registran
            en{" "}
            <Link href="/admin/payouts" className="font-medium text-brand-700 hover:underline">
              Pagos a trabajadores
            </Link>{" "}
            con su referencia bancaria: ahí nada mueve dinero. Las devoluciones al cliente, en
            cambio, sí salen: se piden desde{" "}
            <Link href="/admin/pagos" className="font-medium text-brand-700 hover:underline">
              Pagos de clientes
            </Link>{" "}
            y las ejecuta el proveedor del pago (Webpay, en producción). Solo cuentan como hechas
            cuando el banco las confirma; una que queda «por confirmar» se concilia sola o se
            cierra a mano con lo que muestre el portal de Transbank. Toda acción administrativa
            queda registrada en{" "}
            <code className="rounded bg-ink-100 px-1.5 py-0.5 text-caption">audit_logs</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Lo que encontró la última pasada de los invariantes
 * (`app_private.check_invariants`, cada 10 minutos con las tareas
 * programadas). Roja mientras haya una regla rota que nadie marcó como vista;
 * ámbar si ya se vio y sigue rota; nada si no hay ninguna.
 */
function IntegrityAlerts({ alerts }: { alerts: readonly IntegrityAlert[] | null }) {
  if (alerts === null) {
    return (
      <Alert tone="warning" className="mt-6" title="No pudimos comprobar los invariantes">
        La lectura de las alertas de integridad falló. Eso no significa que esté todo bien: vuelve
        a cargar la página y, si sigue, revisa que la base tenga la migración 20260601001520.
      </Alert>
    );
  }
  if (alerts.length === 0) return null;

  const unseen = alerts.filter((alert) => alert.unacknowledged);
  const list = (
    <ul className="mt-2 space-y-1">
      {alerts.map((alert) => (
        <li key={alert.alertId}>
          <code>{alert.kind}</code> · {formatNumber(alert.violationCount)}{" "}
          {alert.violationCount === 1 ? "caso" : "casos"} · desde{" "}
          {formatDateTime(alert.firstSeenAt)}
          {alert.sampleIds.length > 0 && (
            <>
              {" "}
              · p. ej. <code>{alert.sampleIds[0]}</code>
            </>
          )}
          {!alert.unacknowledged && " · vista"}
        </li>
      ))}
    </ul>
  );

  if (unseen.length > 0) {
    return (
      <Alert tone="danger" className="mt-6" title="Hay datos que rompen una regla del dinero">
        Las tareas programadas encontraron {unseen.length === 1 ? "una regla" : `${unseen.length} reglas`}{" "}
        sin ver. No muevas dinero sobre esos registros hasta entender qué pasó; cada caso trae el
        identificador de la fila que la rompe.
        {list}
        <AcknowledgeIntegrityAlerts />
      </Alert>
    );
  }

  return (
    <Alert tone="warning" className="mt-6" title="Reglas rotas, ya vistas">
      Siguen rotas y el aviso diario sigue llegando hasta que se corrija el dato.
      {list}
    </Alert>
  );
}

function QueueCard({
  icon,
  label,
  value,
  tone,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: string;
  /** Si hay pantalla donde resolverlo, la tarjeta lleva a ella. */
  href?: string;
}) {
  const body = (
    <CardContent className="flex items-center gap-4">
      <span className={`shrink-0 ${tone}`}>{icon}</span>
      <div>
        <p className="text-small text-ink-500">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold text-ink-950 tabular-nums">{value}</p>
      </div>
    </CardContent>
  );

  if (!href) return <Card>{body}</Card>;

  return (
    <Link href={href} className="block rounded-[var(--radius-card)] hover:opacity-90">
      <Card>{body}</Card>
    </Link>
  );
}
