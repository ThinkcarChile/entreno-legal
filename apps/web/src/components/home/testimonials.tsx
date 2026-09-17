import { ReviewCard } from "@/components/profile/review-card";
import { Section } from "@/components/ui";

import type { Review } from "@/lib/domain/types";

export function Testimonials({ reviews }: { reviews: readonly Review[] }) {
  if (reviews.length === 0) return null;

  return (
    <Section
      eyebrow="Reseñas"
      title="Lo que dicen quienes ya delegaron"
      description="Solo pueden calificar quienes contrataron y completaron un trabajo."
      align="center"
    >
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {reviews.map((review) => (
          <li key={review.id}>
            <ReviewCard review={review} />
          </li>
        ))}
      </ul>
    </Section>
  );
}
