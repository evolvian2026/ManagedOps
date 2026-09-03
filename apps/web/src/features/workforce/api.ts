import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignmentRole,
  DocumentProgress,
  DocumentStatus,
  DocumentValidity,
  TrainerDocumentType,
  TrainerStatus,
} from '@managedops/shared';
import { api } from '../../lib/api';
import type { Page } from '../onboarding/api';

/** Queries and mutations for projects, rosters, trainers and their documents. */

export interface ProjectRow {
  id: string;
  name: string;
  code: string;
  client: { id: string; name: string; code: string };
  location: string | null;
  startDate: string;
  endDate: string | null;
  status: 'planned' | 'active' | 'completed' | 'cancelled';
  manager: { id: string; name: string } | null;
  hr: { id: string; name: string } | null;
  leadTrainer: { id: string; name: string } | null;
  _count?: { positions: number; assignments: number };
}

export interface RosterRow {
  id: string;
  role: AssignmentRole;
  status: 'active' | 'ended';
  startDate: string;
  endDate: string | null;
  leaveAllowanceDays: string;
  /**
   * Present only for a caller holding `billing.read` — the API omits the field
   * rather than nulling it, so `undefined` means "not yours to see" while null
   * means "no rate agreed".
   */
  billRatePerDay?: string | null;
  project: { id: string; name: string; code: string; client: { id: string; name: string } };
  trainer: {
    id: string;
    employeeCode: string;
    phone: string;
    workEmail: string | null;
    status: TrainerStatus;
    user: { id: string; name: string; email: string };
  };
  /** Null when nobody has punched today — reported, never invented. */
  today: { status: string; punchInAt: string | null; punchOutAt: string | null } | null;
}

export interface RosterResponse {
  project: ProjectRow & { workStartTime: string; graceMinutes: number };
  workDate: string;
  data: RosterRow[];
}

export interface TrainerDocumentRow {
  id: string;
  docType: TrainerDocumentType;
  status: DocumentStatus;
  lastFour: string | null;
  /** Whether a document was uploaded — answered even when the id is withheld. */
  hasFile: boolean;
  /** Null when the caller may see the row but not open the document itself. */
  fileId: string | null;
  rejectReason: string | null;
  verifiedAt: string | null;
  verifiedBy: { id: string; name: string } | null;
  expiresOn: string | null;
  /** Derived on every read; a stored "valid" goes stale the moment time passes. */
  validity: DocumentValidity;
  mandatory?: boolean;
}

export interface ExpiringDocumentRow {
  id: string;
  docType: TrainerDocumentType;
  status: DocumentStatus;
  expiresOn: string | null;
  validity: DocumentValidity;
  hasFile: boolean;
  fileId: string | null;
  trainer: {
    id: string;
    employeeCode: string;
    status: string;
    name: string;
    projects: string[];
  };
}

export type ExpiryState = 'expiring_soon' | 'expired' | 'missing_date';

export function useExpiringDocuments(state: ExpiryState | '' = '') {
  const search = new URLSearchParams({ pageSize: '100', sort: 'expiresOn' });
  if (state) search.set('state', state);
  return useQuery({
    queryKey: ['expiring-documents', state],
    queryFn: ({ signal }) =>
      api.get<Page<ExpiringDocumentRow>>(`/trainers/documents/expiring?${search}`, signal),
  });
}

export interface TrainerDetail {
  id: string;
  employeeCode: string;
  personalEmail: string;
  workEmail: string | null;
  phone: string;
  joiningDate: string | null;
  status: TrainerStatus;
  rehireEligible: boolean;
  documentsCompletedAt: string | null;
  travelArrivalDate: string | null;
  travelMode: string | null;
  /** Present only when the caller may read pay; the read is audited. */
  salaryAnnual: string | null;
  user: { id: string; name: string; email: string; mustChangePassword: boolean };
  onboardingHr: { id: string; name: string } | null;
  assignments: {
    id: string;
    role: AssignmentRole;
    status: string;
    startDate: string;
    endDate: string | null;
    leaveAllowanceDays: string;
    project: { id: string; name: string; code: string; client: { id: string; name: string } };
  }[];
  documents: TrainerDocumentRow[];
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api.get<Page<ProjectRow>>('/projects?pageSize=100', signal),
  });
}

export function useRoster(projectId: string) {
  return useQuery({
    queryKey: ['roster', projectId],
    queryFn: ({ signal }) => api.get<RosterResponse>(`/projects/${projectId}/roster`, signal),
    enabled: Boolean(projectId),
  });
}

export function useTrainer(trainerId: string | null) {
  return useQuery({
    queryKey: ['trainer', trainerId],
    queryFn: ({ signal }) => api.get<TrainerDetail>(`/trainers/${trainerId}`, signal),
    enabled: Boolean(trainerId),
  });
}

/** The signed-in trainer's own record, without needing to know their id. */
export function useMyProfile() {
  return useQuery({
    queryKey: ['trainer', 'me'],
    queryFn: ({ signal }) => api.get<TrainerDetail>('/trainers/me', signal),
  });
}

export function useTrainerDocuments(trainerId: string | null) {
  return useQuery({
    queryKey: ['trainer', trainerId, 'documents'],
    queryFn: ({ signal }) =>
      api.get<{ data: TrainerDocumentRow[]; progress: DocumentProgress }>(
        `/trainers/${trainerId}/documents`,
        signal,
      ),
    enabled: Boolean(trainerId),
  });
}

function useWorkforceMutation<TInput, TResult>(request: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      // Verifying the last document can activate a trainer, which changes the
      // roster and the profile as well as the document row that was clicked.
      await Promise.all(
        // A renewal changes the expiry queue as much as the checklist it was
        // uploaded from, and that queue is the one somebody is watching.
        ['trainer', 'roster', 'projects', 'assignments', 'expiring-documents'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
}

export function useVerifyDocument(trainerId: string) {
  return useWorkforceMutation(
    (input: { documentId: string; decision: 'verified' | 'rejected'; rejectReason?: string }) =>
      api.post(`/trainers/${trainerId}/documents/${input.documentId}/verify`, {
        decision: input.decision,
        ...(input.rejectReason ? { rejectReason: input.rejectReason } : {}),
      }),
  );
}

export function useUploadDocument(trainerId: string) {
  return useWorkforceMutation(
    (input: {
      docType: TrainerDocumentType;
      fileId: string;
      lastFour?: string;
      expiresOn?: string;
    }) => api.post(`/trainers/${trainerId}/documents`, input),
  );
}

export function useResendCredentials(trainerId: string) {
  return useWorkforceMutation(() =>
    api.post<{ message: string }>(`/trainers/${trainerId}/resend-credentials`),
  );
}

export function useConvertOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { offerId: string; workEmail?: string }) =>
      api.post(`/offers/${input.offerId}/convert-to-trainer`, {
        ...(input.workEmail ? { workEmail: input.workEmail } : {}),
      }),
    onSuccess: async () => {
      await Promise.all(
        ['offers', 'trainer', 'roster', 'projects', 'positions'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
}

/**
 * Uploads a file straight to object storage, then confirms it so the server can
 * verify its real size and type. Returns the file id to attach to a record.
 */
export type UploadPurpose =
  | 'identity_document'
  | 'certificate'
  | 'reimbursement_proof'
  | 'deliverable';

export async function uploadFile(file: File, purpose: UploadPurpose): Promise<string> {
  const ticket = await api.post<{ file: { id: string }; uploadUrl: string }>('/files/upload-url', {
    purpose,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  });

  const upload = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  if (!upload.ok) {
    throw new Error('The file could not be uploaded to storage. Try again.');
  }

  await api.post(`/files/${ticket.file.id}/confirm`, {});
  return ticket.file.id;
}
