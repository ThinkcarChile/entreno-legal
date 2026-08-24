import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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
    <main className="pt-2">
      <AppNav active="catalog" />
      <h1 className="text-2xl font-bold">Agregar producto</h1>
      <p className="mt-1 text-sm opacity-70">
        Producto privado de tu hogar. Copia los datos de la etiqueta; revisarás un resumen antes de
        guardar.
      </p>
      <div className="mt-4">
        <ProductForm initialBarcode={barcode ?? ""} />
      </div>
    </main>
  );
}
