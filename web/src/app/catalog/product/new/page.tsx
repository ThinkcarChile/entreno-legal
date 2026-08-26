import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Icon, LinkButton, Notice } from "@/components/ui";
import { ProductForm } from "./ProductForm";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ barcode?: string }>;
}

export default async function NewProductPage({ searchParams }: Props) {
  const { barcode } = await searchParams;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/catalog/product/new");

  return (
    <AppShell
      active="catalog"
      title="Agregar producto"
      subtitle="Producto privado de tu hogar: nadie más lo ve."
      action={
        <LinkButton href="/catalog" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Catálogo
        </LinkButton>
      }
    >
      <div className="mt-md">
        <Notice icon="edit_note">
          Copia los datos tal como vienen en la etiqueta. Antes de guardar te mostramos un resumen
          de cómo los interpretamos, y ahí recién confirmas.
        </Notice>
      </div>

      {barcode ? (
        <div className="mt-sm">
          <Notice icon="barcode_scanner" tono="info">
            Partimos del código <strong className="tabular-nums">{barcode}</strong> que escaneaste.
          </Notice>
        </div>
      ) : null}

      <div className="mt-lg">
        <ProductForm initialBarcode={barcode ?? ""} />
      </div>
    </AppShell>
  );
}
