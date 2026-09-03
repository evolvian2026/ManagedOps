import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplicationStatus,
  InterviewStatus,
  OfferStatus,
  ScreeningOutcome,
} from '@managedops/shared';
import { api } from '../../lib/api';

/**
 * The recruitment queries and mutations the Onboarding screens use.
 *
 * Response shapes are declared here once so the screens stay about layout, and
 * every mutation names exactly which caches it invalidates — a screening
 * decision changes the position's stage counts and the interview board, not
 * just the row that was clicked.
 */

export interface Page<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface StageCounts {
  total: number;
  applied: number;
  interviewing: number;
  offer: number;
  hired: number;
  closed: number;
}

export interface PositionRow {
  id: string;
  title: string;
  headcount: number;
  filledCount: number;
  description: string | null;
  status: 'open' | 'filled' | 'closed';
  project: { id: string; name: string; code: string; client: { id: string; name: string } };
  applicants: StageCounts;
}

export interface ApplicationRow {
  id: string;
  status: ApplicationStatus;
  screeningOutcome: ScreeningOutcome | null;
  screeningNotes: string | null;
  rejectionReason: string | null;
  createdAt: string;
  candidate: {
    id: string;
    name: string;
    email: string;
    phone: string;
    linkedinUrl: string | null;
    resumeFileId: string | null;
    workedBefore: boolean;
  };
  position: { id: string; title: string; project: { id: string; name: string; code: string } };
  screenedBy: { id: string; name: string } | null;
}

export interface InterviewRow {
  id: string;
  round: number;
  scheduledAt: string;
  durationMinutes: number;
  meetingUrl: string | null;
  recordingUrl: string | null;
  status: InterviewStatus;
  outcome: 'pending' | 'selected' | 'rejected';
  feedback: string | null;
  previousInterviewId: string | null;
  interviewer: { id: string; name: string; email: string } | null;
  application: {
    id: string;
    status: ApplicationStatus;
    candidate: { id: string; name: string; email: string; phone: string };
    position: { id: string; title: string; project: { id: string; name: string; code: string } };
  };
}

export interface PipelineCard {
  position: { id: string; title: string; status: string; project: { id: string; name: string } };
  toBeScheduled: number;
  scheduled: number;
  conducted: number;
  missed: number;
  selected: number;
  rejected: number;
}

export interface OfferRow {
  id: string;
  version: number;
  salaryAnnual: string;
  joiningDate: string;
  status: OfferStatus;
  sentAt: string | null;
  respondedAt: string | null;
  notes: string | null;
  application: {
    id: string;
    candidate: { id: string; name: string; email: string; phone: string };
    position: { id: string; title: string; project: { id: string; name: string; code: string } };
  };
}

const keys = {
  positions: (filters?: string) => ['positions', filters ?? ''] as const,
  applications: (positionId: string) => ['applications', positionId] as const,
  pipeline: () => ['interviews', 'pipeline'] as const,
  interviews: (positionId: string) => ['interviews', positionId] as const,
  offers: (status?: string) => ['offers', status ?? 'all'] as const,
};

/* -------------------------------------------------------------- positions */

export function usePositions(status?: string) {
  const query = status ? `&status=${status}` : '';
  return useQuery({
    queryKey: keys.positions(status),
    queryFn: ({ signal }) => api.get<Page<PositionRow>>(`/positions?pageSize=100${query}`, signal),
  });
}

export function useApplications(positionId: string) {
  return useQuery({
    queryKey: keys.applications(positionId),
    queryFn: ({ signal }) =>
      api.get<Page<ApplicationRow>>(`/applications?positionId=${positionId}&pageSize=100`, signal),
    enabled: Boolean(positionId),
  });
}

/* ------------------------------------------------------------- interviews */

export function usePipeline() {
  return useQuery({
    queryKey: keys.pipeline(),
    queryFn: ({ signal }) => api.get<{ data: PipelineCard[] }>('/interviews/pipeline', signal),
  });
}

export function useInterviews(positionId: string) {
  return useQuery({
    queryKey: keys.interviews(positionId),
    queryFn: ({ signal }) =>
      api.get<Page<InterviewRow>>(`/interviews?positionId=${positionId}&pageSize=100`, signal),
    enabled: Boolean(positionId),
  });
}

/** Applications waiting for a first booking — the "to be scheduled" column. */
export function useAwaitingSchedule(positionId: string) {
  return useQuery({
    queryKey: ['applications', positionId, 'interviewing'],
    queryFn: ({ signal }) =>
      api.get<Page<ApplicationRow>>(
        `/applications?positionId=${positionId}&status=interviewing&pageSize=100`,
        signal,
      ),
    enabled: Boolean(positionId),
  });
}

/* ----------------------------------------------------------------- offers */

export function useOffers(status?: OfferStatus) {
  return useQuery({
    queryKey: keys.offers(status),
    queryFn: ({ signal }) =>
      api.get<Page<OfferRow>>(`/offers?pageSize=100${status ? `&status=${status}` : ''}`, signal),
  });
}

/* -------------------------------------------------------------- mutations */

/**
 * Recruitment actions ripple: screening a candidate changes the position's
 * counts, the interview board and the offer list. Invalidating the whole
 * recruitment surface after any of them is cheap at this data volume, and it
 * removes a whole class of "the number in the corner is stale" bugs.
 */
function useRecruitmentMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await Promise.all(
        ['positions', 'applications', 'interviews', 'offers'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
}

export function useScreenApplication() {
  return useRecruitmentMutation(
    (input: { id: string; outcome: ScreeningOutcome; notes?: string; reason?: string }) =>
      api.post<ApplicationRow>(`/applications/${input.id}/screen`, {
        outcome: input.outcome,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      }),
  );
}

export function useScheduleInterview() {
  return useRecruitmentMutation(
    (input: {
      applicationId: string;
      scheduledAt: string;
      durationMinutes?: number;
      meetingUrl?: string;
    }) =>
      api.post<InterviewRow>('/interviews', {
        applicationId: input.applicationId,
        scheduledAt: input.scheduledAt,
        ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.meetingUrl ? { meetingUrl: input.meetingUrl } : {}),
      }),
  );
}

export function useRecordOutcome() {
  return useRecruitmentMutation(
    (input: {
      id: string;
      outcome: 'selected' | 'rejected';
      feedback: string;
      recordingUrl?: string;
    }) =>
      api.post<InterviewRow>(`/interviews/${input.id}/outcome`, {
        outcome: input.outcome,
        feedback: input.feedback,
        ...(input.recordingUrl ? { recordingUrl: input.recordingUrl } : {}),
      }),
  );
}

export function useRescheduleInterview() {
  return useRecruitmentMutation((input: { id: string; scheduledAt: string; meetingUrl?: string }) =>
    api.post<InterviewRow>(`/interviews/${input.id}/reschedule`, {
      scheduledAt: input.scheduledAt,
      ...(input.meetingUrl ? { meetingUrl: input.meetingUrl } : {}),
    }),
  );
}

export function useMarkMissed() {
  return useRecruitmentMutation((input: { id: string }) =>
    api.post<InterviewRow>(`/interviews/${input.id}/missed`),
  );
}

export function useCreateOffer() {
  return useRecruitmentMutation(
    (input: { applicationId: string; salaryAnnual: number; joiningDate: string; notes?: string }) =>
      api.post<OfferRow>('/offers', input),
  );
}

export function useSendOffer() {
  return useRecruitmentMutation((input: { id: string }) =>
    api.post<OfferRow>(`/offers/${input.id}/send`, {}),
  );
}

export function useRespondToOffer() {
  return useRecruitmentMutation(
    (input: {
      id: string;
      response: 'accepted' | 'declined' | 'revision_requested';
      notes?: string;
    }) =>
      api.post<OfferRow>(`/offers/${input.id}/respond`, {
        response: input.response,
        ...(input.notes ? { notes: input.notes } : {}),
      }),
  );
}

/** Opens a short-lived, audited download link for a stored resume. */
export async function openResume(fileId: string): Promise<void> {
  const { downloadUrl } = await api.get<{ downloadUrl: string }>(`/files/${fileId}/download-url`);
  window.open(downloadUrl, '_blank', 'noopener,noreferrer');
}
