/**
 * Barril del sistema de componentes.
 *
 * Todo lo que la aplicación usa sale de aquí. Antes faltaban `Alert`,
 * `PendingButton` y los esqueletos, así que la mitad de las pantallas importaba
 * por ruta directa y la otra mitad por el barril: dos formas de hacer lo mismo
 * es una de más.
 */

/* Acción */
export { Button, ButtonLink } from "./button";

/* Superficies */
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
export { Section } from "./section";

/* Identidad y estado */
export { Avatar } from "./avatar";
export { Badge } from "./badge";
export { StatusChip } from "./status-chip";
export { Rating, StarRow } from "./rating";

/* Formularios */
export { Field, Input, Select, Textarea } from "./field";
export { Checkbox, Radio, Switch } from "./toggle";

/* Dinero */
export { Amount, AmountRange, HourlyRate } from "./money";
export { PriceBreakdown, type PriceLine } from "./price-breakdown";
export { Stat } from "./stat";

/* Navegación */
export { SegmentedControl, Tabs, type TabItem } from "./tabs";

/* Estados de una sección */
export { EmptyState } from "./empty-state";
export { ErrorState, TrustItem } from "./states";
export { JobCardSkeleton, JobListSkeleton, ListSkeleton, Skeleton } from "./skeleton";

/* Capas y avisos */
export { Alert, PendingButton } from "./feedback";
export { Overlay } from "./overlay";
