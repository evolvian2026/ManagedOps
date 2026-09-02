import { Card, PageHeader } from '../../components/ui';
import { ErrorState, LoadingState } from '../../components/states';
import { formatDate, formatInr, humanise } from '../onboarding/format';
import { DocumentChecklist } from './document-checklist';
import { useMyProfile, useTrainerDocuments } from './api';

/**
 * A trainer's own record. Same checklist component as the administrator's view,
 * with upload enabled and verification not — a trainer supplies documents, HR
 * decides whether they are acceptable.
 */
export function MyProfilePage() {
  const profile = useMyProfile();
  const documents = useTrainerDocuments(profile.data?.id ?? null);

  if (profile.isPending) return <LoadingState label="Loading your profile" rows={4} />;
  if (profile.isError) {
    return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  }

  const trainer = profile.data;

  return (
    <>
      <PageHeader
        title="My profile"
        description={`${trainer.employeeCode} · ${humanise(trainer.status)}`}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card title="Your details" description="Ask HR if anything here needs correcting.">
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={trainer.user.name} />
            <Row label="Employee code" value={trainer.employeeCode} />
            <Row label="Joining date" value={formatDate(trainer.joiningDate)} />
            <Row label="Work email" value={trainer.workEmail ?? 'Not assigned yet'} />
            <Row label="Phone" value={trainer.phone} />
            {trainer.salaryAnnual ? (
              <Row label="Annual salary" value={formatInr(trainer.salaryAnnual)} />
            ) : null}
          </dl>

          {trainer.assignments.length > 0 ? (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="text-xs font-semibold tracking-wide text-ink-soft uppercase">
                Your projects
              </h3>
              <ul className="mt-2 space-y-2">
                {trainer.assignments
                  .filter((assignment) => assignment.status === 'active')
                  .map((assignment) => (
                    <li key={assignment.id} className="text-sm">
                      <span className="font-medium text-ink">{assignment.project.name}</span>
                      <span className="block text-xs text-ink-soft">
                        {assignment.project.clientName} · since {formatDate(assignment.startDate)}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card
          title="Your documents"
          description="Upload each one; HR checks them and lets you know."
        >
          {documents.isPending ? (
            <LoadingState label="Loading your documents" rows={3} />
          ) : documents.isError ? (
            <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
          ) : (
            <DocumentChecklist
              trainerId={trainer.id}
              documents={documents.data.data}
              progress={documents.data.progress}
              canVerify={false}
              canUpload
            />
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-right font-medium break-all text-ink">{value}</dd>
    </div>
  );
}
