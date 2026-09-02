import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@managedops/shared';
import { api } from '../../lib/api';
import type { Page } from '../onboarding/api';

/** Queries and mutations for the two administration screens. */

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
  actor: { id: string; name: string; email: string; role: Role } | null;
}

export interface AuditFilters {
  entityType?: string;
  action?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
}

export function useAuditLog(filters: AuditFilters, page: number) {
  const search = new URLSearchParams({ page: String(page), pageSize: '25' });
  for (const [key, value] of Object.entries(filters)) {
    if (value) search.set(key, value);
  }
  return useQuery({
    queryKey: ['audit', filters, page],
    queryFn: ({ signal }) => api.get<Page<AuditEntry>>(`/audit-logs?${search}`, signal),
  });
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export function useUsers(query: { q?: string; role?: Role; status?: string } = {}) {
  const search = new URLSearchParams({ pageSize: '100' });
  if (query.q) search.set('q', query.q);
  if (query.role) search.set('role', query.role);
  if (query.status) search.set('status', query.status);
  return useQuery({
    queryKey: ['users', query],
    queryFn: ({ signal }) => api.get<Page<UserRow>>(`/users?${search}`, signal),
  });
}

function useUsersMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      // Disabling an account changes the audit trail as well as the list.
      await Promise.all(
        ['users', 'audit'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );
    },
  });
}

export function useCreateUser() {
  return useUsersMutation((input: { name: string; email: string; phone?: string; role: Role }) =>
    api.post<UserRow>('/users', input),
  );
}

export function useSetUserStatus() {
  return useUsersMutation((input: { id: string; enabled: boolean }) =>
    api.post<UserRow>(`/users/${input.id}/${input.enabled ? 'enable' : 'disable'}`),
  );
}

export function useResetUserPassword() {
  return useUsersMutation((id: string) =>
    api.post<{ message: string }>(`/users/${id}/reset-password`),
  );
}
