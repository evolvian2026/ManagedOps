import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplicationStatus,
  DashboardSummary,
  DeboardingBlockers,
  PoolEntry,
  PoolSource,
} from '@managedops/shared';
import { api } from '../../lib/api';
import type { ReviewSummary } from '../reviews/api';
import type { Page } from '../onboarding/api';

/** Queries and mutations for exit, re-use and the dashboard. */

export interface DeboardingRow {
  id: string;
  lastWorkingDay: string;
  reason: string;
  status: 'initiated' | 'assets_pending' | 'fnf_pending' | 'completed';
  assetsReconciled: boolean;
  travelNotes: string | null;
  fnfStatus: 'pending' | 'settled' | 'waived';
  fnfAmount: string | null;
  fnfSettledAt: string | null;
  feedback: string | null;
  completedAt: string | null;
  createdAt: string;
  initiatedBy: { id: string; name: string };
  assignment: {
    id: string;
    role: string;
    startDate: string;
    endDate: string | null;
    status: string;
    project: { id: string; name: string; client: { id: string; name: string } };
    trainer: {
      id: string;
      employeeCode: string;
      status: string;
      rehireEligible: boolean;
      user: { id: string; name: string; email: string };
    };
  };
  /** Present on a single fetch, absent from a list row. */
  blockers?: DeboardingBlockers;
  /** How they were rated, beside the re-hire decision that rests on it. */
  quality?: ReviewSummary | null;
}

export function useDeboardings(params: { open?: boolean; projectId?: string } = {}) {
  const search = new URLSearchParams({ pageSize: '50' });
  if (params.open) search.set('open', 'true');
  if (params.projectId) search.set('projectId', params.projectId);
  return useQuery({
    queryKey: ['deboardings', params],
    queryFn: ({ signal }) => api.get<Page<DeboardingRow>>(`/deboardings?${search}`, signal),
  });
}

export function useDeboarding(id: string | null) {
  return useQuery({
    queryKey: ['deboardings', id],
    queryFn: ({ signal }) => api.get<DeboardingRow>(`/deboardings/${id}`, signal),
    enabled: Boolean(id),
  });
}

export function usePool(
  params: {
    q?: string;
    source?: PoolSource;
    workedBefore?: boolean;
    lastStatus?: ApplicationStatus;
    projectId?: string;
  } = {},
) {
  const search = new URLSearchParams({ pageSize: '50' });
  if (params.q) search.set('q', params.q);
  if (params.source) search.set('source', params.source);
  if (params.workedBefore !== undefined) search.set('workedBefore', String(params.workedBefore));
  if (params.lastStatus) search.set('lastStatus', params.lastStatus);
  if (params.projectId) search.set('projectId', params.projectId);
  return useQuery({
    queryKey: ['pool', params],
    queryFn: ({ signal }) => api.get<Page<PoolEntry>>(`/pool?${search}`, signal),
  });
}

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api.get<DashboardSummary>('/dashboard/summary', signal),
  });
}

/**
 * Completing a deboarding changes the roster, the pool, the trainer's status
 * and the dashboard's counts, so everything downstream of it is invalidated
 * rather than the one list that happened to be on screen.
 */
const EXIT_KEYS = ['deboardings', 'pool', 'dashboard', 'trainer', 'roster', 'assets', 'projects'];

function useExitMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await Promise.all(EXIT_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
}

export function useStartDeboarding() {
  return useExitMutation(
    (input: { assignmentId: string; lastWorkingDay: string; reason: string }) =>
      api.post<DeboardingRow>('/deboardings', input),
  );
}

export function useUpdateDeboarding() {
  return useExitMutation(
    (input: {
      id: string;
      lastWorkingDay?: string;
      travelNotes?: string;
      fnfStatus?: 'pending' | 'settled' | 'waived';
      fnfAmount?: number;
      feedback?: string;
      rehireEligible?: boolean;
    }) => {
      const { id, ...body } = input;
      return api.patch<DeboardingRow>(`/deboardings/${id}`, body);
    },
  );
}

export function useCompleteDeboarding() {
  return useExitMutation((id: string) => api.post<DeboardingRow>(`/deboardings/${id}/complete`));
}

export function useConsiderForPosition() {
  return useExitMutation((input: { entryId: string; positionId: string }) =>
    api.post(`/pool/${input.entryId}/create-application`, { positionId: input.positionId }),
  );
}

/**
 * Downloads a CSV through the authenticated client rather than a plain link.
 *
 * A bare `<a href>` carries no Authorization header — the access token lives in
 * memory, never in a cookie the browser would attach — so the link would
 * download a 401 page named `.csv`. Fetching and handing the browser a blob is
 * what makes the export actually work.
 */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
