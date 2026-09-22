import type { Metadata } from "next";
import Link from "next/link";

import { ArrowRight, Info } from "lucide-react";

import { AvatarUploader } from "@/components/account/avatar-uploader";
import { VerificationPanel } from "@/components/account/verification-panel";
import { WorkerProfileForm } from "@/components/account/worker-profile-form";
import { AccountModes } from "@/components/account/account-modes";
import { Card, CardContent } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireOnboardedUser } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { UserRole, VerificationStatus } from "@/lib/domain/enums";
import { workerProfileCompleteness } from "@/lib/domain/eligibility";

export const metadata: Metadata = {
  title: "Perfil de trabajador",
  robots: { index: false, follow: false },
};

export default async function WorkerAccountPage() {
  const session = await requireOnboardedUser("/cuenta/trabajador");
  const isWorker = session.modes.includes(UserRole.WORKER);

  if (!isWorker) {
    return (
      <div className="container-page max-w-2xl py-8 sm:py-12">
        <h1 className="text-h2 text-ink-950">
          Activa el modo trabajador
        </h1>
        <p className="mt-2 text-ink-600">
          Con la misma cuenta que usas para contratar. No necesitas registrarte otra vez ni
          pierdes lo que ya hiciste.
        </p>
        <Card className="mt-8">
          <CardContent>
            <AccountModes isClient={session.modes.includes(UserRole.CLIENT)} isWorker={false} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const worker = await getData().workers.getByUserId(session.id);
  const completeness = workerProfileCompleteness(worker);
  const status = worker?.verificationStatus ?? VerificationStatus.UNVERIFIED;

  return (
    <div className="container-page max-w-3xl py-8 sm:py-12">
      <h1 className="text-h2 text-ink-950 sm:text-h1">
        Perfil de trabajador
      </h1>
      <p className="mt-2 text-ink-600">
        Esto es lo que ve un cliente al recibir tu oferta. Mientras más claro, más te eligen.
      </p>

      <div className="mt-8 space-y-6">
        <VerificationPanel status={status} />

        {!completeness.complete && (
          <Alert tone="warning" title="Tu perfil está incompleto">
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {completeness.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Alert>
        )}

        <Card>
          <CardContent className="sm:p-8">
            <div className="border-b border-ink-100 pb-6">
              <AvatarUploader
                userId={session.id}
                displayName={session.profile.displayName}
                currentUrl={session.profile.avatarUrl}
              />
            </div>
            <div className="pt-6">
              <WorkerProfileForm worker={worker} />
            </div>
          </CardContent>
        </Card>

        <p className="flex items-start gap-2 text-small text-ink-600">
          <Info size={16} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
          <span>
            Tus datos personales (RUT, documento, teléfono y cuenta bancaria) nunca se muestran en
            tu perfil público.{" "}
            <Link
              href={`/trabajadores/${session.id}`}
              className="font-medium text-brand-700 hover:underline"
            >
              Ver mi perfil público
              <ArrowRight size={13} className="ml-0.5 inline" aria-hidden="true" />
            </Link>
          </span>
        </p>
      </div>
    </div>
  );
}
