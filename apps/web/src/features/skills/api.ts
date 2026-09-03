import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Proficiency, SkillRequirement, SkillStatus } from '@managedops/shared';
import { api } from '../../lib/api';
import type { Page } from '../onboarding/api';

/** Queries and mutations for the catalogue, profiles and the search. */

export interface Skill {
  id: string;
  name: string;
  category: string | null;
  status: SkillStatus;
  createdAt: string;
  _count?: { trainers: number };
}

export interface TrainerSkill {
  id: string;
  proficiency: Proficiency;
  years: string | null;
  lastUsedOn: string | null;
  notes: string | null;
  skill: Skill;
}

export interface PositionSkill {
  id: string;
  requirement: SkillRequirement;
  minProficiency: Proficiency | null;
  skill: Skill;
}

export function useSkills(query: { q?: string; status?: SkillStatus } = {}) {
  const search = new URLSearchParams({ pageSize: '100', sort: 'name' });
  if (query.q) search.set('q', query.q);
  if (query.status) search.set('status', query.status);
  return useQuery({
    queryKey: ['skills', query],
    queryFn: ({ signal }) => api.get<Page<Skill>>(`/skills?${search}`, signal),
  });
}

export function useTrainerSkills(trainerId: string | null) {
  return useQuery({
    queryKey: ['trainer-skills', trainerId],
    queryFn: ({ signal }) => api.get<TrainerSkill[]>(`/trainers/${trainerId}/skills`, signal),
    enabled: trainerId !== null,
  });
}

export function usePositionSkills(positionId: string | null) {
  return useQuery({
    queryKey: ['position-skills', positionId],
    queryFn: ({ signal }) => api.get<PositionSkill[]>(`/positions/${positionId}/skills`, signal),
    enabled: positionId !== null,
  });
}

function useSkillsMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      // A changed profile changes who matches, so the shortlist is stale too.
      await Promise.all(
        ['skills', 'trainer-skills', 'position-skills', 'matching'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
}

export function useCreateSkill() {
  return useSkillsMutation((input: { name: string; category?: string }) =>
    api.post<Skill>('/skills', input),
  );
}

export interface SetTrainerSkill {
  trainerId: string;
  skillId: string;
  proficiency: Proficiency;
  years?: number;
  lastUsedOn?: string;
}

export function useSetTrainerSkill() {
  return useSkillsMutation(({ trainerId, ...body }: SetTrainerSkill) =>
    api.put<TrainerSkill>(`/trainers/${trainerId}/skills`, body),
  );
}

export function useRemoveTrainerSkill() {
  return useSkillsMutation((input: { trainerId: string; skillId: string }) =>
    api.delete(`/trainers/${input.trainerId}/skills/${input.skillId}`),
  );
}

export function useSetPositionSkill() {
  return useSkillsMutation(
    ({
      positionId,
      ...body
    }: {
      positionId: string;
      skillId: string;
      requirement: SkillRequirement;
      minProficiency?: Proficiency;
    }) => api.put<PositionSkill>(`/positions/${positionId}/skills`, body),
  );
}

export function useRemovePositionSkill() {
  return useSkillsMutation((input: { positionId: string; skillId: string }) =>
    api.delete(`/positions/${input.positionId}/skills/${input.skillId}`),
  );
}

/* ------------------------------------------------------------- the search */

export interface SkillMatch {
  skillId: string;
  name: string;
  requirement: SkillRequirement;
  held: boolean;
  proficiency: Proficiency | null;
  belowRequestedLevel: boolean;
}

export interface Availability {
  committedPercent: number;
  availablePercent: number;
  /** Null means an open-ended commitment: not "never", but not a date either. */
  availableFrom: string | null;
  onBench: boolean;
}

export interface Candidate {
  trainerId: string;
  name: string;
  employeeCode: string;
  status: string;
  score: number;
  eligible: boolean;
  reasons: string[];
  matches: SkillMatch[];
  availability: Availability;
  commitments: {
    projectId: string;
    projectName: string;
    allocationPercent: number;
    endDate: string | null;
  }[];
}

export interface MatchReport {
  from: string;
  to: string;
  required: { skillId: string; name: string; requirement: SkillRequirement }[];
  position: { id: string; title: string; projectName: string } | null;
  candidates: Candidate[];
  consideredCount: number;
}

export interface MatchFilters {
  positionId?: string;
  skillIds: string[];
  from?: string;
  to?: string;
  availableOnly: boolean;
  eligibleOnly: boolean;
}

export function matchSearch(filters: MatchFilters): string {
  const search = new URLSearchParams();
  if (filters.positionId) search.set('positionId', filters.positionId);
  if (filters.skillIds.length > 0) search.set('skillIds', filters.skillIds.join(','));
  if (filters.from) search.set('from', filters.from);
  if (filters.to) search.set('to', filters.to);
  search.set('availableOnly', String(filters.availableOnly));
  search.set('eligibleOnly', String(filters.eligibleOnly));
  return search.toString();
}

export function useMatches(filters: MatchFilters) {
  // Asking with neither a position nor a skill is not a search; the API would
  // rightly refuse it, so the query simply does not run until there is one.
  const ready = Boolean(filters.positionId) || filters.skillIds.length > 0;
  return useQuery({
    queryKey: ['matching', filters],
    queryFn: ({ signal }) =>
      api.get<MatchReport>(`/matching/trainers?${matchSearch(filters)}`, signal),
    enabled: ready,
  });
}
