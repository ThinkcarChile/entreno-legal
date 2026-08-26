import { redirect } from "next/navigation";

/**
 * La portada NO dibuja nada: manda directo a Familia.
 *
 * Se revisó en la migración al kit de Stitch y quedó tal cual a propósito. No
 * hay una sola clase ni un solo color que migrar acá — la maqueta "home
 * cocinero" (tarjeta de la comida de hoy, accesos rápidos, resumen nutricional,
 * integrantes del hogar) es una pantalla NUEVA: necesita consultas que hoy no
 * existen, y armarla sería cambiar el producto, no la presentación.
 *
 * Mientras siga siendo un redirect, el destino "Inicio" del menú (`active:
 * "home"` en AppShell) nunca se va a ver encendido: la persona toca Inicio y
 * aterriza en Familia, que se pinta a sí misma como Familia.
 */
export default function Home() {
  redirect("/family");
}
