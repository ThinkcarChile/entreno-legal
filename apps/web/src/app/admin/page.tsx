import type { Metadata } from "next";

import { AlertTriangle, BadgeCheck, Banknote, ShieldAlert } from "lucide-react";

import { Card, CardContent, Stat } from "@/components/ui";
import { getData, isDemoMode } from "@/lib/data";
import { formatPercent, formatNumber } from "@/lib/utils/format";
import { formatMoney } from "@/lib/utils/money";

export const metadata: Metadata = {
  title: "Panel de administración",
  robots: { index: false, follow: false },
};

export default async function AdminDashboardPage() {
  const kpis = await getData().admin.getKpis();

  return (
    <div className="container-page py-8 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Resumen</h1>
          <p className="mt-1 text-ink-600">Indicadores de los últimos 30 días.</p>
        </div>
        {isDemoMode() && (
          <p className="rounded-full bg-warning-50 px-3 py-1.5 text-xs font-medium text-warning-700 ring-1 ring-warning-100 ring-inset">
            Datos de demostración
          </p>
        )}
      </header>

      <section className="mt-8">
        <h2 className="text-sm font-semibold tracking-wide text-ink-500 uppercase">Negocio</h2>
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
        <h2 className="text-sm font-semibold tracking-wide text-ink-500 uppercase">Actividad</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Trabajos publicados" value={formatNumber(kpis.jobsPublished)} />
          <Stat label="Trabajos completados" value={formatNumber(kpis.jobsCompleted)} />
          <Stat label="Usuarios nuevos" value={formatNumber(kpis.newUsers30d)} />
          <Stat label="Trabajadores activos" value={formatNumber(kpis.activeWorkers)} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold tracking-wide text-ink-500 uppercase">
          Requiere atención
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <QueueCard
            icon={<BadgeCheck size={18} aria-hidden="true" />}
            label="Verificaciones pendientes"
            value={kpis.pendingVerifications}
            tone="text-brand-600"
          />
          <QueueCard
            icon={<Banknote size={18} aria-hidden="true" />}
            label="Payouts por aprobar"
            value={kpis.pendingPayouts}
            tone="text-success-600"
          />
          <QueueCard
            icon={<ShieldAlert size={18} aria-hidden="true" />}
            label="Disputas abiertas"
            value={kpis.openDisputes}
            tone="text-danger-600"
          />
          <QueueCard
            icon={<AlertTriangle size={18} aria-hidden="true" />}
            label="Cancelaciones"
            value={kpis.cancellations}
            tone="text-warning-600"
          />
        </div>
      </section>

      <Card className="mt-8">
        <CardContent>
          <h2 className="text-base font-semibold text-ink-900">Siguiente etapa del panel</h2>
          <p className="mt-2 text-sm text-ink-600">
            Las secciones de listado y resolución se construyen sobre los mismos repositorios:
            cola de verificaciones con aprobación y rechazo, conciliación de pagos con Transbank,
            aprobación de payouts con referencia bancaria y resolución de disputas con historial
            de evidencia. Toda acción administrativa queda registrada en{" "}
            <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">audit_logs</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function QueueCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4">
        <span className={`shrink-0 ${tone}`}>{icon}</span>
        <div>
          <p className="text-sm text-ink-500">{label}</p>
          <p className="mt-0.5 text-2xl font-semibold text-ink-900 tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
