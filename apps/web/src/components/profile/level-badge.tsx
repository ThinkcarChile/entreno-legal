import { Award, BadgeCheck, Medal, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui";
import { WorkerLevel } from "@/lib/domain/enums";
import { workerLevelLabels } from "@/lib/domain/labels";

import type { ToneName } from "@/lib/domain/labels";

const config: Record<WorkerLevel, { tone: ToneName; icon: typeof Award }> = {
  NUEVO: { tone: "neutral", icon: Sparkles },
  VERIFICADO: { tone: "info", icon: BadgeCheck },
  PRO: { tone: "info", icon: Medal },
  EXPERTO: { tone: "success", icon: Award },
};

export function LevelBadge({ level }: { level: WorkerLevel }) {
  const { tone, icon: Icon } = config[level];

  return (
    <Badge tone={tone} icon={<Icon size={13} aria-hidden="true" />}>
      {workerLevelLabels[level].label}
    </Badge>
  );
}
