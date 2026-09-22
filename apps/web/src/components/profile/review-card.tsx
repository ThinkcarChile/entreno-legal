import { Avatar, Card, CardContent, Rating } from "@/components/ui";
import { formatRelative } from "@/lib/utils/datetime";

import type { Review } from "@/lib/domain/types";

export function ReviewCard({ review }: { review: Review }) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-3">
          <Avatar src={review.authorAvatarUrl} name={review.authorName} />
          <div className="min-w-0">
            <p className="truncate text-small font-medium text-ink-950">{review.authorName}</p>
            <p className="text-caption text-ink-500">{formatRelative(review.createdAt)}</p>
          </div>
          <Rating value={review.overall} showCount={false} className="ml-auto" />
        </div>
        {review.comment && (
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-700">
            &ldquo;{review.comment}&rdquo;
          </p>
        )}
      </CardContent>
    </Card>
  );
}
