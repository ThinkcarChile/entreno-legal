"use client";

import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui";

/** Reintentar es recargar. Se aísla aquí para que la página siga siendo de servidor. */
export function ReloadButton() {
  return (
    <Button onClick={() => window.location.reload()}>
      <RotateCw size={16} aria-hidden="true" />
      Reintentar
    </Button>
  );
}
