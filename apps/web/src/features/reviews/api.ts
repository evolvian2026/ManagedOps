import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewSource } from '@managedops/shared';
import { api } from '../../lib/api';

/** Feedback about a trainer, and what it adds up to. */

export interface SourceSummary {
  source: ReviewSource;
  reviews: number;
  respondents: number;
  average: number;
}

export interface ReviewSummary {
  overall: number | null;
  recent: number | null;
  trend: 'improving' | 'declining' | 'steady' | null;
  bySource: SourceSummary[];
  dimensions: {
    knowledge: number | null;
    delivery: number | null;
    professionalism: number | null;
  };
  reviewCount: number;
  respondentCount: number;
  retractedCount: number;
  confident: boolean;
  caveat: string | null;
}

export interface Review {
  id: string;
  source: ReviewSource;
  rating: number;
  knowledge: number | null;
  delivery: number | null;
  professionalism: number | null;
  respondents: number | null;
  /** Absent for a trainer reading their own: withheld by the API, not hidden here. */
  comment?: string | null;
  observedOn: string;
  createdAt: string;
  retractedAt: string | null;
  retractedReason: string | null;
  submittedBy?: { id: string; name: string; role: string };
  retractedBy: { id: string; name: string } | null;
  assignment: {
    id: string;
    project: { id: string; name: string };
    trainer: { id: string; employeeCode: string; user: { name: string } };
  };
}

export interface TrainerReviews {
  summary: ReviewSummary;
  data: Review[];
  viewer: { mayWrite: boolean; mayRetract: boolean; readsComments: boolean };
}

export function useTrainerReviews(trainerId: string | null) {
  return useQuery({
    queryKey: ['reviews', trainerId],
    queryFn: ({ signal }) => api.get<TrainerReviews>(`/trainers/${trainerId}/reviews`, signal),
    enabled: trainerId !== null,
  });
}

function useReviewsMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      // Feedback changes the re-hire evidence, so the pool and the deboarding
      // queue are stale the moment a review lands.
      await Promise.all(
        ['reviews', 'pool', 'deboardings', 'deboarding'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
}

export interface CreateReview {
  assignmentId: string;
  source: ReviewSource;
  rating: number;
  knowledge?: number;
  delivery?: number;
  professionalism?: number;
  respondents?: number;
  comment?: string;
  observedOn: string;
}

export function useCreateReview() {
  return useReviewsMutation((input: CreateReview) => api.post<Review>('/reviews', input));
}

// No update: a review cannot be edited, only withdrawn with a reason.
export function useRetractReview() {
  return useReviewsMutation((input: { id: string; reason: string }) =>
    api.post<Review>(`/reviews/${input.id}/retract`, { reason: input.reason }),
  );
}
