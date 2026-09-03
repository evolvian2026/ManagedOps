import { useState } from 'react';
import { Badge, Button, Card, PageHeader, Tabs } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { formatDate, formatInr, humanise } from '../onboarding/format';
import { DocumentChecklist } from './document-checklist';
import { useResendCredentials, useTrainer, useTrainerDocuments, type TrainerDetail } from './api';
import { TRAINER_TONE } from './running-projects';
import { StartDeboardingDialog } from '../exit/deboarding';
import {
  AttendanceTab,
  ClaimsTab,
  DailyLogTab,
  DeliverablesTab,
  FlagsTab,
  LeaveTab,
  ResourcesTab,
} from './trainer-operations';
import { TrainerSkillsTab } from '../skills/trainer-skills';
import { useTrainerSkills } from '../skills/api';

type Tab =
  | 'overview'
  | 'skills'
  | 'documents'
  | 'assignments'
  | 'attendance'
  | 'log'
  | 'deliverables'
  | 'leave'
  | 'resources'
  | 'claims'
  | 'flags';

/**
 * One trainer, as an administrator sees them. Salary and identity documents are
 * only requested when the caller holds the capability for them, so a project
 * lead opening a colleague's profile simply does not see those tabs.
 */
export function TrainerProfile({ trainerId, onBack }: { trainerId: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [deboarding, setDeboarding] = useState(false);
  const { can } = useAuth();
  const trainer = useTrainer(trainerId);
  const documents = useTrainerDocuments(can('trainers.read_documents') ? trainerId : null);
  const skills = useTrainerSkills(can('skills.read') ? trainerId : null);

  if (trainer.isPending) return <LoadingState label="Loading the profile" rows={4} />;
  if (trainer.isError) {
    return <ErrorState error={trainer.error} onRetry={() => void trainer.refetch()} />;
  }

  const canSeeDocuments = can('trainers.read_documents');
  // Attendance, leave and assets all hang off an assignment. A trainer between
  // projects has none, and the tabs say so rather than showing an empty table.
  const activeAssignmentId =
    trainer.data.assignments.find((assignment) => assignment.status === 'active')?.id ?? null;

  return (
    <>
      <Button variant="ghost" onClick={onBack} className="-ml-3 mb-1">
        ← Back
      </Button>

      <PageHeader
        title={trainer.data.user.name}
        description={`${trainer.data.employeeCode} · ${humanise(trainer.data.status)}`}
        actions={
          <div className="flex items-center gap-3">
            <Badge tone={TRAINER_TONE[trainer.data.status] ?? 'neutral'}>
              {humanise(trainer.data.status)}
            </Badge>
            {can('deboarding.manage') && activeAssignmentId && trainer.data.status === 'active' ? (
              <Button variant="secondary" onClick={() => setDeboarding(true)}>
                Start deboarding
              </Button>
            ) : null}
          </div>
        }
      />

      {activeAssignmentId ? (
        <StartDeboardingDialog
          assignmentId={activeAssignmentId}
          trainerName={trainer.data.user.name}
          open={deboarding}
          onClose={() => setDeboarding(false)}
        />
      ) : null}

      <div className="mb-5">
        <Tabs
          label="Trainer sections"
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            // Before Documents: what somebody can teach is the first thing
            // asked about them, and the tab order should say so.
            ...(can('skills.read')
              ? [{ id: 'skills' as const, label: 'Skills', count: skills.data?.length }]
              : []),
            ...(canSeeDocuments
              ? [
                  {
                    id: 'documents' as const,
                    label: 'Documents',
                    count: documents.data?.progress.verified,
                  },
                ]
              : []),
            { id: 'assignments', label: 'Assignments', count: trainer.data.assignments.length },
            // Each operational tab appears only for a caller who can read it —
            // a lead sees their team's attendance, never their colleague's pay.
            ...(can('attendance.read') ? [{ id: 'attendance' as const, label: 'Attendance' }] : []),
            ...(can('dailylogs.read') ? [{ id: 'log' as const, label: 'Daily Log' }] : []),
            ...(can('deliverables.read')
              ? [{ id: 'deliverables' as const, label: 'Deliverables' }]
              : []),
            ...(can('leave.approve') ? [{ id: 'leave' as const, label: 'Leave' }] : []),
            ...(can('assets.read') ? [{ id: 'resources' as const, label: 'Resources' }] : []),
            ...(can('reimbursements.approve') ? [{ id: 'claims' as const, label: 'Claims' }] : []),
            ...(can('flags.raise') ? [{ id: 'flags' as const, label: 'Flags' }] : []),
          ]}
        />
      </div>

      {tab === 'overview' ? (
        <Overview trainer={trainer.data} />
      ) : tab === 'skills' ? (
        <TrainerSkillsTab trainerId={trainerId} />
      ) : tab === 'documents' ? (
        documents.isPending ? (
          <LoadingState label="Loading documents" rows={3} />
        ) : documents.isError ? (
          <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
        ) : (
          <DocumentChecklist
            trainerId={trainerId}
            documents={documents.data.data}
            progress={documents.data.progress}
            canVerify={can('trainers.verify_documents')}
            canUpload={can('trainers.verify_documents')}
          />
        )
      ) : tab === 'assignments' ? (
        <Assignments trainer={trainer.data} />
      ) : tab === 'attendance' ? (
        <AttendanceTab assignmentId={activeAssignmentId} />
      ) : tab === 'log' ? (
        <DailyLogTab trainerId={trainerId} />
      ) : tab === 'deliverables' ? (
        <DeliverablesTab trainerId={trainerId} />
      ) : tab === 'leave' ? (
        <LeaveTab trainerId={trainerId} />
      ) : tab === 'resources' ? (
        <ResourcesTab assignmentId={activeAssignmentId} />
      ) : tab === 'claims' ? (
        <ClaimsTab trainerId={trainerId} />
      ) : (
        <FlagsTab
          trainerId={trainerId}
          assignmentId={activeAssignmentId}
          trainerName={trainer.data.user.name}
        />
      )}
    </>
  );
}

function Overview({ trainer }: { trainer: TrainerDetail }) {
  const { can } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const resend = useResendCredentials(trainer.id);

  async function resendCredentials() {
    setMessage(null);
    setProblem(null);
    try {
      const result = await resend.mutateAsync(undefined);
      setMessage((result as { message: string }).message);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card title="Details">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Detail label="Employee code" value={trainer.employeeCode} mono />
          <Detail label="Joining date" value={formatDate(trainer.joiningDate)} />
          <Detail label="Personal email" value={trainer.personalEmail} wrap />
          <Detail label="Work email" value={trainer.workEmail ?? 'Not assigned yet'} wrap />
          <Detail label="Phone" value={trainer.phone} mono />
          <Detail label="Onboarded by" value={trainer.onboardingHr?.name ?? '—'} />
          {trainer.salaryAnnual ? (
            <Detail label="Annual salary" value={formatInr(trainer.salaryAnnual)} mono />
          ) : null}
          <Detail label="Re-hire eligible" value={trainer.rehireEligible ? 'Yes' : 'No'} />
        </dl>
      </Card>

      <div className="space-y-5">
        <Card title="Onboarding">
          <dl className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-soft">Documents</dt>
              <dd className="font-medium text-ink">
                {trainer.documentsCompletedAt ? 'Complete' : 'Outstanding'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-soft">First sign-in</dt>
              <dd className="font-medium text-ink">
                {trainer.user.mustChangePassword ? 'Not yet' : 'Done'}
              </dd>
            </div>
          </dl>

          {can('trainers.manage') && trainer.user.mustChangePassword ? (
            <div className="mt-4 border-t border-line pt-4">
              <Button
                variant="secondary"
                pending={resend.isPending}
                onClick={() => void resendCredentials()}
              >
                Resend credentials
              </Button>
              <p className="mt-2 text-xs text-ink-soft">
                Emails a fresh temporary password to {trainer.personalEmail}.
              </p>
              {message ? <p className="mt-2 text-xs font-medium text-primary">{message}</p> : null}
              {problem ? (
                <p role="alert" className="mt-2 text-xs font-medium text-danger">
                  {problem}
                </p>
              ) : null}
            </div>
          ) : null}
        </Card>

        {trainer.travelArrivalDate || trainer.travelMode ? (
          <Card title="Travel">
            <dl className="space-y-3 text-sm">
              <Detail label="Arrives" value={formatDate(trainer.travelArrivalDate)} />
              <Detail label="Mode" value={trainer.travelMode ?? '—'} />
            </dl>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
  wrap = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd
        className={`mt-0.5 font-medium text-ink ${mono ? 'tabular-nums' : ''} ${wrap ? 'break-all' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Assignments({ trainer }: { trainer: TrainerDetail }) {
  if (trainer.assignments.length === 0) {
    return (
      <EmptyState
        title="No assignments yet"
        description="A trainer becomes active once they have documents verified and a project to work on."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {trainer.assignments.map((assignment) => (
        <li
          key={assignment.id}
          className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-line bg-surface p-4"
        >
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-ink">{assignment.project.name}</span>
              {assignment.role === 'lead' ? <Badge tone="positive">Lead</Badge> : null}
            </div>
            <p className="mt-0.5 text-xs text-ink-soft">
              {assignment.project.client.name} · {formatDate(assignment.startDate)}
              {assignment.endDate ? ` – ${formatDate(assignment.endDate)}` : ' onwards'}
            </p>
          </div>
          <div className="text-right">
            <Badge tone={assignment.status === 'active' ? 'positive' : 'neutral'}>
              {humanise(assignment.status)}
            </Badge>
            <p className="mt-1 text-xs text-ink-soft tabular-nums">
              {assignment.leaveAllowanceDays} days leave
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
