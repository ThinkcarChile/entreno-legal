import type { JobDraft } from "@/lib/validation/job";

export interface StepProps {
  draft: JobDraft;
  errors: Readonly<Record<string, string>>;
  update: (patch: Partial<JobDraft>) => void;
}
