import type { Metadata } from "next";

import { WorkerCard } from "@/components/profile/worker-card";
import { getData } from "@/lib/data";

export const metadata: Metadata = {
  title: "Trabajadores verificados",
  description:
    "Conoce a las personas verificadas que hacen filas, trámites y gestiones en todo Chile.",
  alternates: { canonical: "/trabajadores" },
};

export default async function WorkersPage() {
  const workers = await getData().workers.listFeatured(24);

  return (
    <div className="container-page py-8 sm:py-12">
      <header className="max-w-2xl">
        <h1 className="text-h2 text-ink-950 sm:text-h1">
          Trabajadores verificados
        </h1>
        <p className="mt-2 text-ink-600">
          Cada perfil muestra identidad verificada, reputación, puntualidad y trabajos
          completados. Nadie puede aceptar trabajos sin estar verificado.
        </p>
      </header>

      <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {workers.map((worker) => (
          <li key={worker.userId} className="flex">
            <WorkerCard worker={worker} />
          </li>
        ))}
      </ul>
    </div>
  );
}
