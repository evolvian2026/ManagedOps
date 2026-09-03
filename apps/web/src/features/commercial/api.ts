import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientStatus } from '@managedops/shared';
import { api } from '../../lib/api';
import type { Page } from '../onboarding/api';

/** Queries and mutations for the commercial screens. */

export interface ClientRow {
  id: string;
  name: string;
  code: string;
  status: ClientStatus;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  billingAddress: string | null;
  gstin: string | null;
  notes: string | null;
  createdAt: string;
  /**
   * Present only for a caller who holds `billing.read` — the API omits the
   * field entirely rather than nulling it, so `undefined` here means "not
   * yours to see" and null means "no rate agreed".
   */
  defaultDayRate?: string | null;
  _count: { projects: number };
}

export interface ClientDetail extends Omit<ClientRow, '_count'> {
  projects: {
    id: string;
    name: string;
    code: string;
    status: string;
    startDate: string;
    endDate: string | null;
    _count: { assignments: number };
  }[];
}

export function useClients(query: { q?: string; status?: ClientStatus | '' } = {}) {
  const search = new URLSearchParams({ pageSize: '100' });
  if (query.q) search.set('q', query.q);
  if (query.status) search.set('status', query.status);
  return useQuery({
    queryKey: ['clients', query],
    queryFn: ({ signal }) => api.get<Page<ClientRow>>(`/clients?${search}`, signal),
  });
}

export function useClient(id: string | null) {
  return useQuery({
    queryKey: ['client', id],
    queryFn: ({ signal }) => api.get<ClientDetail>(`/clients/${id}`, signal),
    enabled: id !== null,
  });
}

export interface ClientInput {
  name: string;
  code: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  billingAddress?: string;
  gstin?: string;
  defaultDayRate?: number;
  notes?: string;
}

function useCommercialMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      // A rate change moves the margin, and a new client changes the directory.
      // `roster` matters most and is the easiest to forget: it is the screen the
      // rate is edited on, so leaving it out means the one view the user is
      // looking at is the one that does not update.
      await Promise.all(
        ['clients', 'client', 'margin', 'roster', 'assignments', 'trainer', 'projects'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
}

export function useCreateClient() {
  return useCommercialMutation((input: ClientInput) => api.post<ClientRow>('/clients', input));
}

export function useUpdateClient() {
  return useCommercialMutation(
    (input: { id: string } & Partial<ClientInput> & { status?: ClientStatus }) => {
      const { id, ...body } = input;
      return api.patch<ClientRow>(`/clients/${id}`, body);
    },
  );
}

export function useSetBillRate() {
  return useCommercialMutation((input: { assignmentId: string; billRatePerDay: number | null }) =>
    api.patch(`/assignments/${input.assignmentId}/bill-rate`, {
      billRatePerDay: input.billRatePerDay,
    }),
  );
}

/* ----------------------------------------------------------------- margins */

export type GroupBy = 'project' | 'trainer' | 'client';

export interface MarginRow {
  key: string;
  label: string;
  sublabel: string | null;
  revenue: number;
  salaryCost: number;
  reimbursements: number;
  cost: number;
  margin: number;
  marginPercent: number | null;
  unbilled: boolean;
  billableDays: number;
  payableDays: number;
  unbilledAssignments: number;
}

export interface MarginReport {
  from: string;
  to: string;
  groupBy: GroupBy;
  rows: MarginRow[];
  totals: Omit<MarginRow, 'key' | 'label' | 'sublabel' | 'payableDays'>;
}

export interface MarginFilters {
  from?: string;
  to?: string;
  groupBy: GroupBy;
  clientId?: string;
}

export function marginQuery(filters: MarginFilters): string {
  const search = new URLSearchParams({ groupBy: filters.groupBy });
  if (filters.from) search.set('from', filters.from);
  if (filters.to) search.set('to', filters.to);
  if (filters.clientId) search.set('clientId', filters.clientId);
  return search.toString();
}

export function useMargin(filters: MarginFilters) {
  return useQuery({
    queryKey: ['margin', filters],
    queryFn: ({ signal }) =>
      api.get<MarginReport>(`/billing/margin?${marginQuery(filters)}`, signal),
  });
}

/** The calendar month containing today, as the two dates the API expects. */
export function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const last = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}
