import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttendanceStatus,
  CorrectionStatus,
  DeliverableStatus,
  DeliverableType,
  FlagAction,
  FlagSeverity,
  FlagStatus,
  LeaveBalance,
  LeaveDayType,
  LeaveStatus,
  ReimbursementCategory,
  ReimbursementStatus,
  TodayState,
} from '@managedops/shared';
import { api } from '../../lib/api';
import type { Page } from '../onboarding/api';

/** Queries and mutations for everything that happens on a live assignment. */

interface Named {
  id: string;
  name: string;
}

interface AssignmentRef {
  id: string;
  project: Named;
  trainer: { id: string; employeeCode: string; user: Named };
}

export interface AttendanceRow {
  id: string;
  workDate: string;
  status: AttendanceStatus;
  punchInAt: string | null;
  punchOutAt: string | null;
  locationStatus: 'captured' | 'unavailable';
  source: string;
  notes: string | null;
  assignment: AssignmentRef & {
    project: Named & { workStartTime: string; graceMinutes: number };
  };
}

export interface CalendarDay {
  workDate: string;
  status: string;
  record: AttendanceRow | null;
  /** True when the status was worked out from the calendar, not stored. */
  derived: boolean;
}

export interface CalendarResponse {
  month: string;
  assignment: { id: string; project: Named };
  days: CalendarDay[];
  summary: {
    present: number;
    late: number;
    absent: number;
    onLeave: number;
    nonWorking: number;
    openIssues: number;
  };
}

export interface CorrectionRow {
  id: string;
  requestedPunchIn: string | null;
  requestedPunchOut: string | null;
  reason: string;
  status: CorrectionStatus;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  requestedBy: Named;
  reviewedBy: Named | null;
  attendanceRecord: AttendanceRow;
}

export interface LeaveRow {
  id: string;
  startDate: string;
  endDate: string;
  dayType: LeaveDayType;
  daysCount: string;
  unpaidDays: string;
  reason: string;
  status: LeaveStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  escalatedAt: string | null;
  createdAt: string;
  approver: Named | null;
  assignment: AssignmentRef & { leaveAllowanceDays: string };
}

export interface DailyLogRow {
  id: string;
  workDate: string;
  sessionNo: number;
  topic: string;
  hours: string;
  notes: string | null;
  submittedAt: string | null;
  locked: boolean;
  assignment: AssignmentRef;
}

export interface DeliverableRow {
  id: string;
  type: DeliverableType;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: DeliverableStatus;
  fileId: string | null;
  completedAt: string | null;
  assignment: AssignmentRef;
}

export interface AssetIssueRow {
  id: string;
  issuedAt: string;
  issueSerial: string | null;
  issueNotes: string | null;
  returnedAt: string | null;
  returnSerial: string | null;
  returnNotes: string | null;
  status: 'issued' | 'returned' | 'lost' | 'damaged';
  asset: { id: string; name: string; category: string; serialNumber: string | null };
  issuedBy: Named;
  assignment: AssignmentRef;
}

export interface AssetRow {
  id: string;
  name: string;
  category: 'hardware' | 'accessory' | 'digital';
  serialNumber: string | null;
  status: string;
  notes: string | null;
  currentIssue: AssetIssueRow | null;
}

export interface ReimbursementRow {
  id: string;
  category: ReimbursementCategory;
  amount: string;
  description: string;
  proofFileId: string;
  status: ReimbursementStatus;
  reviewedAt: string | null;
  reviewNote: string | null;
  paidAt: string | null;
  paymentReference: string | null;
  createdAt: string;
  reviewedBy: Named | null;
  trainer: { id: string; employeeCode: string; user: Named };
  assignment: { id: string; project: Named } | null;
}

export interface FlagRow {
  id: string;
  severity: FlagSeverity;
  description: string;
  status: FlagStatus;
  actionTaken: FlagAction | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  raisedBy: Named;
  resolvedBy: Named | null;
  assignment: AssignmentRef;
}

export type LeaveBalanceResponse = LeaveBalance & { assignment: { id: string; project: Named } };

/* ----------------------------------------------------------------- queries */

export function useToday() {
  return useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: ({ signal }) => api.get<TodayState>('/attendance/today', signal),
    // The punch card is the first thing a trainer looks at; a stale one that
    // still offers "Punch in" after they already did is worse than a refetch.
    staleTime: 0,
  });
}

export function useAttendanceCalendar(month: string, assignmentId?: string) {
  const query = assignmentId ? `&assignmentId=${assignmentId}` : '';
  return useQuery({
    queryKey: ['attendance', 'calendar', month, assignmentId ?? 'me'],
    queryFn: ({ signal }) =>
      api.get<CalendarResponse>(`/attendance/calendar?month=${month}${query}`, signal),
  });
}

export function useCorrections(status?: CorrectionStatus) {
  return useQuery({
    queryKey: ['corrections', status ?? 'all'],
    queryFn: ({ signal }) =>
      api.get<Page<CorrectionRow>>(
        `/attendance/corrections?pageSize=50${status ? `&status=${status}` : ''}`,
        signal,
      ),
  });
}

/**
 * `mine` is what separates a Project Lead's own leave from their team's. Their
 * read capability is project-scoped, so without it the screen labelled "My
 * Leave" would list everyone they lead.
 */
export function useLeaveRequests(
  params: { pending?: boolean; trainerId?: string; mine?: boolean } = {},
) {
  const search = new URLSearchParams({ pageSize: '50' });
  if (params.pending) search.set('pending', 'true');
  if (params.mine) search.set('mine', 'true');
  if (params.trainerId) search.set('trainerId', params.trainerId);
  return useQuery({
    queryKey: ['leave', params],
    queryFn: ({ signal }) => api.get<Page<LeaveRow>>(`/leave-requests?${search}`, signal),
  });
}

export function useLeaveBalance(assignmentId?: string) {
  return useQuery({
    queryKey: ['leave', 'balance', assignmentId ?? 'me'],
    queryFn: ({ signal }) =>
      api.get<LeaveBalanceResponse>(
        `/leave-requests/balance${assignmentId ? `?assignmentId=${assignmentId}` : ''}`,
        signal,
      ),
  });
}

export function useDailyLogs(
  params: { assignmentId?: string; trainerId?: string; mine?: boolean } = {},
) {
  const search = new URLSearchParams({ pageSize: '50' });
  if (params.mine) search.set('mine', 'true');
  if (params.assignmentId) search.set('assignmentId', params.assignmentId);
  if (params.trainerId) search.set('trainerId', params.trainerId);
  return useQuery({
    queryKey: ['daily-logs', params],
    queryFn: ({ signal }) => api.get<Page<DailyLogRow>>(`/daily-logs?${search}`, signal),
  });
}

export function useDeliverables(
  params: { assignmentId?: string; trainerId?: string; mine?: boolean } = {},
) {
  const search = new URLSearchParams({ pageSize: '100' });
  if (params.mine) search.set('mine', 'true');
  if (params.assignmentId) search.set('assignmentId', params.assignmentId);
  if (params.trainerId) search.set('trainerId', params.trainerId);
  return useQuery({
    queryKey: ['deliverables', params],
    queryFn: ({ signal }) => api.get<Page<DeliverableRow>>(`/deliverables?${search}`, signal),
  });
}

export function useMyAssets(assignmentId?: string) {
  return useQuery({
    queryKey: ['assets', 'mine', assignmentId ?? 'me'],
    queryFn: ({ signal }) =>
      api.get<AssetIssueRow[]>(
        `/assets/mine${assignmentId ? `?assignmentId=${assignmentId}` : ''}`,
        signal,
      ),
  });
}

export function useReimbursements(params: { trainerId?: string; status?: string } = {}) {
  const search = new URLSearchParams({ pageSize: '50' });
  if (params.trainerId) search.set('trainerId', params.trainerId);
  if (params.status) search.set('status', params.status);
  return useQuery({
    queryKey: ['reimbursements', params],
    queryFn: ({ signal }) => api.get<Page<ReimbursementRow>>(`/reimbursements?${search}`, signal),
  });
}

export function useFlags(params: { open?: boolean; trainerId?: string } = {}) {
  const search = new URLSearchParams({ pageSize: '50' });
  if (params.open) search.set('open', 'true');
  if (params.trainerId) search.set('trainerId', params.trainerId);
  return useQuery({
    queryKey: ['flags', params],
    queryFn: ({ signal }) => api.get<Page<FlagRow>>(`/flags?${search}`, signal),
  });
}

/* --------------------------------------------------------------- mutations */

/**
 * Everything here can change something else on the screen: a punch changes
 * today's card and this month's calendar, an approved leave writes attendance
 * days, and a decided claim empties a queue. Invalidating the whole operations
 * surface is a few extra requests and no chance of a stale panel next to a
 * fresh one.
 */
const OPERATIONS_KEYS = [
  'attendance',
  'corrections',
  'leave',
  'daily-logs',
  'deliverables',
  'assets',
  'reimbursements',
  'flags',
  'roster',
  'dashboard',
];

function useOperationsMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await Promise.all(
        OPERATIONS_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );
    },
  });
}

export interface PunchInput {
  lat?: number;
  lng?: number;
  locationConsent?: boolean;
}

export function usePunch(direction: 'in' | 'out') {
  return useOperationsMutation((input: PunchInput) =>
    api.post<AttendanceRow>(`/attendance/punch-${direction}`, input),
  );
}

export function useRequestCorrection() {
  return useOperationsMutation(
    (input: {
      recordId: string;
      requestedPunchIn?: string;
      requestedPunchOut?: string;
      reason: string;
    }) => {
      const { recordId, ...body } = input;
      return api.post<CorrectionRow>(`/attendance/${recordId}/corrections`, body);
    },
  );
}

export function useDecideCorrection() {
  return useOperationsMutation(
    (input: { correctionId: string; decision: 'approved' | 'rejected'; reviewNote?: string }) =>
      api.post<CorrectionRow>(`/attendance/corrections/${input.correctionId}/decide`, {
        decision: input.decision,
        ...(input.reviewNote ? { reviewNote: input.reviewNote } : {}),
      }),
  );
}

export function useRequestLeave() {
  return useOperationsMutation(
    (input: { startDate: string; endDate: string; dayType: LeaveDayType; reason: string }) =>
      api.post<LeaveRow>('/leave-requests', input),
  );
}

export function useDecideLeave() {
  return useOperationsMutation(
    (input: { leaveId: string; decision: 'approved' | 'rejected'; decisionNote?: string }) =>
      api.post<LeaveRow>(`/leave-requests/${input.leaveId}/decide`, {
        decision: input.decision,
        ...(input.decisionNote ? { decisionNote: input.decisionNote } : {}),
      }),
  );
}

export function useCancelLeave() {
  return useOperationsMutation((leaveId: string) =>
    api.post<LeaveRow>(`/leave-requests/${leaveId}/cancel`),
  );
}

export function useAddDailyLog() {
  return useOperationsMutation(
    (input: { workDate: string; topic: string; hours: number; notes?: string }) =>
      api.post<DailyLogRow>('/daily-logs', input),
  );
}

export function useUnlockDailyLog() {
  return useOperationsMutation((input: { logId: string; reason: string }) =>
    api.post<DailyLogRow>(`/daily-logs/${input.logId}/unlock`, { reason: input.reason }),
  );
}

export function useUpdateDeliverable() {
  return useOperationsMutation(
    (input: { id: string; status?: DeliverableStatus; fileId?: string }) => {
      const { id, ...body } = input;
      return api.patch<DeliverableRow>(`/deliverables/${id}`, body);
    },
  );
}

export function useSubmitClaim() {
  return useOperationsMutation(
    (input: {
      category: ReimbursementCategory;
      amount: number;
      description: string;
      proofFileId: string;
    }) => api.post<ReimbursementRow>('/reimbursements', input),
  );
}

export function useDecideClaim() {
  return useOperationsMutation(
    (input: { claimId: string; decision: 'approved' | 'rejected'; reviewNote?: string }) =>
      api.post<ReimbursementRow>(`/reimbursements/${input.claimId}/decide`, {
        decision: input.decision,
        ...(input.reviewNote ? { reviewNote: input.reviewNote } : {}),
      }),
  );
}

export function useMarkClaimPaid() {
  return useOperationsMutation((input: { claimId: string; reference?: string }) =>
    api.post<ReimbursementRow>(`/reimbursements/${input.claimId}/mark-paid`, {
      ...(input.reference ? { reference: input.reference } : {}),
    }),
  );
}

export function useRaiseFlag() {
  return useOperationsMutation(
    (input: { assignmentId: string; severity: FlagSeverity; description: string }) =>
      api.post<FlagRow>('/flags', input),
  );
}

export function useResolveFlag() {
  return useOperationsMutation(
    (input: { flagId: string; actionTaken: FlagAction; resolutionNote: string }) =>
      api.post<FlagRow>(`/flags/${input.flagId}/resolve`, {
        actionTaken: input.actionTaken,
        resolutionNote: input.resolutionNote,
      }),
  );
}

/** How long a punch will wait for a location before going ahead without one. */
const LOCATION_TIMEOUT_MS = 5000;

/**
 * Asks the browser where it is, and gives up quietly.
 *
 * There is no geofence: a denied permission, a timeout or a device with no
 * receiver all resolve to "no location", and the punch goes through recorded as
 * `unavailable`. Refusing to record someone's attendance over a browser setting
 * would punish the wrong person.
 *
 * The deadline is ours, not the Geolocation API's. Its own `timeout` only starts
 * once the permission has been resolved, so a browser that never answers the
 * prompt — a headless one, or a user who walks away from the dialog — calls
 * neither callback and leaves the punch hanging with no feedback at all. Racing
 * a timer means the worst case is a punch without coordinates, which is a case
 * the product already handles.
 */
export async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { lat: number; lng: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const deadline = setTimeout(() => finish(null), LOCATION_TIMEOUT_MS);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(deadline);
        finish({ lat: position.coords.latitude, lng: position.coords.longitude });
      },
      () => {
        clearTimeout(deadline);
        finish(null);
      },
      { timeout: LOCATION_TIMEOUT_MS, maximumAge: 60_000 },
    );
  });
}
