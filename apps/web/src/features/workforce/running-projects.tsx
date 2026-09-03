import { useState } from 'react';
import { Badge, Button, PageHeader, Table, Td, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatDate, humanise } from '../onboarding/format';
import { TrainerProfile } from './trainer-profile';
import { toneFor } from '../operations/punch-card';
import { useProjects, useRoster, type ProjectRow, type RosterRow } from './api';
import { useAuth } from '../auth/auth-context';
import { BillRateCell } from '../commercial/bill-rate';

const PROJECT_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  planned: 'pending',
  active: 'positive',
  completed: 'neutral',
  cancelled: 'critical',
};

const TRAINER_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  pending_onboarding: 'pending',
  active: 'positive',
  deboarding: 'pending',
  deboarded: 'neutral',
  archived: 'neutral',
};

/**
 * Running Projects: project cards, then that project's roster, then one
 * trainer's profile. Three levels, each replacing the last, so the screen never
 * asks somebody to hold two contexts at once.
 */
export function RunningProjectsPage() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const projects = useProjects();

  if (trainerId) {
    return <TrainerProfile trainerId={trainerId} onBack={() => setTrainerId(null)} />;
  }

  if (projectId) {
    return (
      <ProjectRoster
        projectId={projectId}
        onBack={() => setProjectId(null)}
        onOpenTrainer={setTrainerId}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Running Projects"
        description="Every project and the trainers delivering it."
      />

      {projects.isPending ? (
        <LoadingState label="Loading projects" rows={3} />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
      ) : projects.data.data.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="A project is where trainers are assigned and positions are opened."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.data.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={() => setProjectId(project.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ProjectCard({ project, onOpen }: { project: ProjectRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-lg border border-line bg-surface p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary-wash/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">{project.name}</h3>
          <p className="truncate text-xs text-ink-faint">{project.client.name}</p>
        </div>
        <Badge tone={PROJECT_TONE[project.status] ?? 'neutral'}>{humanise(project.status)}</Badge>
      </div>

      <p className="mt-4 text-2xl font-semibold text-ink tabular-nums">
        {project._count?.assignments ?? 0}
        <span className="ml-1.5 text-sm font-normal text-ink-soft">
          {project._count?.assignments === 1 ? 'trainer' : 'trainers'}
        </span>
      </p>

      <dl className="mt-3 space-y-1 text-xs text-ink-soft">
        <div className="flex justify-between gap-3">
          <dt>Runs</dt>
          <dd className="tabular-nums">
            {formatDate(project.startDate)}
            {project.endDate ? ` – ${formatDate(project.endDate)}` : ' onwards'}
          </dd>
        </div>
        {project.location ? (
          <div className="flex justify-between gap-3">
            <dt>Location</dt>
            <dd>{project.location}</dd>
          </div>
        ) : null}
      </dl>
    </button>
  );
}

function ProjectRoster({
  projectId,
  onBack,
  onOpenTrainer,
}: {
  projectId: string;
  onBack: () => void;
  onOpenTrainer: (trainerId: string) => void;
}) {
  const roster = useRoster(projectId);
  // The API omits the rate entirely for anyone without `billing.read`, so the
  // column is only offered to somebody who would actually be sent one.
  const { can } = useAuth();
  const showsRates = can('billing.read');

  return (
    <>
      <Button variant="ghost" onClick={onBack} className="-ml-3 mb-1">
        ← All projects
      </Button>

      {roster.isPending ? (
        <LoadingState label="Loading the roster" rows={4} />
      ) : roster.isError ? (
        <ErrorState error={roster.error} onRetry={() => void roster.refetch()} />
      ) : (
        <>
          <PageHeader
            title={roster.data.project.name}
            description={`${roster.data.project.client.name} · attendance shown for ${formatDate(roster.data.workDate)}`}
          />

          {roster.data.data.length === 0 ? (
            <EmptyState
              title="Nobody is assigned yet"
              description="Trainers appear here once they are assigned to this project."
            />
          ) : (
            <Table
              caption={`Trainers on ${roster.data.project.name}`}
              head={
                <>
                  <Th>Trainer</Th>
                  <Th>Contact</Th>
                  <Th>Since</Th>
                  <Th>Today</Th>
                  <Th>Status</Th>
                  {showsRates ? <Th className="text-right">Day rate</Th> : null}
                  <Th className="text-right">Profile</Th>
                </>
              }
            >
              {roster.data.data.map((row) => (
                <RosterRowView
                  key={row.id}
                  row={row}
                  showsRates={showsRates}
                  onOpen={() => onOpenTrainer(row.trainer.id)}
                />
              ))}
            </Table>
          )}
        </>
      )}
    </>
  );
}

function RosterRowView({
  row,
  showsRates,
  onOpen,
}: {
  row: RosterRow;
  showsRates: boolean;
  onOpen: () => void;
}) {
  const { trainer } = row;

  return (
    <tr>
      <Td>
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink">{trainer.user.name}</span>
          {row.role === 'lead' ? <Badge tone="positive">Lead</Badge> : null}
        </div>
        <div className="mt-0.5 text-xs text-ink-soft tabular-nums">{trainer.employeeCode}</div>
      </Td>
      <Td className="text-ink-soft">
        <div>{trainer.workEmail ?? trainer.user.email}</div>
        <div className="text-xs tabular-nums">{trainer.phone}</div>
      </Td>
      <Td className="whitespace-nowrap text-ink-soft tabular-nums">{formatDate(row.startDate)}</Td>
      <Td>
        {row.today ? (
          <div className="text-sm">
            <Badge tone={toneFor(row.today.status)}>{humanise(row.today.status)}</Badge>
          </div>
        ) : (
          // Nobody has punched today. Saying so beats inventing a status.
          <span className="text-xs text-ink-faint">Not recorded</span>
        )}
      </Td>
      <Td>
        <Badge tone={TRAINER_TONE[trainer.status] ?? 'neutral'}>{humanise(trainer.status)}</Badge>
      </Td>
      {showsRates ? (
        <Td className="text-right whitespace-nowrap">
          <BillRateCell assignmentId={row.id} rate={row.billRatePerDay ?? null} />
        </Td>
      ) : null}
      <Td className="text-right whitespace-nowrap">
        <Button variant="secondary" onClick={onOpen}>
          Open
        </Button>
      </Td>
    </tr>
  );
}

export { PROJECT_TONE, TRAINER_TONE };
