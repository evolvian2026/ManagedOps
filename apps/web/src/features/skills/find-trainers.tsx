import { useState } from 'react';
import { Badge, Button, Card, Field, PageHeader, Select } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatDate, humanise } from '../onboarding/format';
import { downloadCsv } from '../exit/api';
import { usePositions } from '../onboarding/api';
import { matchSearch, useMatches, useSkills, type Candidate, type MatchFilters } from './api';

/**
 * Who could do this work, and when.
 *
 * Fit and availability are shown side by side rather than folded into one
 * ranking, because the trade between them is the decision: the best-matched
 * person is often the busiest, and whether to pull them off something else is
 * not a judgement this screen should be making on somebody's behalf.
 */
export function FindTrainersPage() {
  const [positionId, setPositionId] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [eligibleOnly, setEligibleOnly] = useState(true);

  const positions = usePositions();
  const skills = useSkills({ status: 'active' });

  const filters: MatchFilters = {
    ...(positionId ? { positionId } : {}),
    skillIds: positionId ? [] : skillIds,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    availableOnly,
    eligibleOnly,
  };
  const matches = useMatches(filters);
  const asked = Boolean(positionId) || skillIds.length > 0;

  function toggleSkill(id: string) {
    setSkillIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  return (
    <>
      <PageHeader
        title="Find Trainers"
        description="Who fits the work, and who is free to do it."
        actions={
          asked ? (
            <Button
              variant="secondary"
              onClick={() =>
                void downloadCsv(
                  `/matching/trainers/export.csv?${matchSearch(filters)}`,
                  'managedops-shortlist.csv',
                )
              }
            >
              Export CSV
            </Button>
          ) : undefined
        }
      />

      <Card title="What are you staffing?">
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="An open position"
            hint="Its requirements are read from the position itself."
            value={positionId}
            onChange={(event) => setPositionId(event.target.value)}
          >
            <option value="">Choose skills instead</option>
            {(positions.data?.data ?? []).map((position) => (
              <option key={position.id} value={position.id}>
                {position.title} · {position.project.name}
              </option>
            ))}
          </Select>
          <Field
            label="Needed from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <Field
            label="Until"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>

        {positionId ? null : (
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium text-ink">Or pick the skills the work needs</p>
            <p className="mb-3 text-xs text-ink-soft">
              Everything chosen here is treated as essential — somebody missing one cannot do the
              job, so they are not offered as a near miss.
            </p>
            {skills.isPending ? (
              <LoadingState label="Loading skills" rows={1} />
            ) : (
              <div className="flex flex-wrap gap-2">
                {(skills.data?.data ?? []).map((skill) => {
                  const chosen = skillIds.includes(skill.id);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => toggleSkill(skill.id)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        chosen
                          ? 'border-primary bg-primary-wash font-medium text-primary'
                          : 'border-line text-ink-soft hover:border-primary/40'
                      }`}
                    >
                      {skill.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-5 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={eligibleOnly}
              onChange={(event) => setEligibleOnly(event.target.checked)}
              className="size-4 rounded border-line"
            />
            <span className="text-ink">Only people who meet every essential skill</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={availableOnly}
              onChange={(event) => setAvailableOnly(event.target.checked)}
              className="size-4 rounded border-line"
            />
            <span className="text-ink">Only people with capacity in that window</span>
          </label>
        </div>
      </Card>

      <div className="mt-5">
        {!asked ? (
          <EmptyState
            title="Say what you are staffing"
            description="Choose an open position, or pick the skills the work needs."
          />
        ) : matches.isPending ? (
          <LoadingState label="Working out who fits" rows={4} />
        ) : matches.isError ? (
          <ErrorState error={matches.error} onRetry={() => void matches.refetch()} />
        ) : matches.data.candidates.length === 0 ? (
          <EmptyState
            title="Nobody matches"
            description={`${matches.data.consideredCount} trainers were considered. Loosen a filter, or widen the dates.`}
          />
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-soft">
              {matches.data.candidates.length} of {matches.data.consideredCount} considered, for{' '}
              {formatDate(matches.data.from)} to {formatDate(matches.data.to)}.
            </p>
            <div className="space-y-3">
              {matches.data.candidates.map((candidate) => (
                <CandidateCard key={candidate.trainerId} candidate={candidate} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function CandidateCard({ candidate }: { candidate: Candidate }) {
  const { availability: free } = candidate;

  return (
    <section aria-label={candidate.name} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{candidate.name}</h3>
            <span className="font-mono text-xs text-ink-soft">{candidate.employeeCode}</span>
            {candidate.eligible ? null : <Badge tone="critical">Cannot do the job</Badge>}
          </div>

          <ul className="mt-2 space-y-0.5 text-xs text-ink-soft">
            {candidate.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {candidate.matches.map((match) => (
              <Badge
                key={match.skillId}
                tone={
                  match.held
                    ? 'positive'
                    : match.requirement === 'essential'
                      ? 'critical'
                      : 'neutral'
                }
              >
                {match.name}
                {match.proficiency ? ` · ${humanise(match.proficiency)}` : ''}
                {match.belowRequestedLevel ? ' · too junior' : ''}
              </Badge>
            ))}
          </div>
        </div>

        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums text-ink">{candidate.score}</p>
          <p className="text-xs text-ink-soft">fit</p>
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-3 text-xs">
        {free.onBench ? (
          <p className="font-medium text-primary">On the bench — free for the whole window.</p>
        ) : free.availablePercent > 0 ? (
          <p className="text-ink">
            <span className="font-medium text-primary">{free.availablePercent}% free</span> in that
            window, alongside {free.committedPercent}% already committed.
          </p>
        ) : free.availableFrom ? (
          <p className="text-ink">
            Fully booked until <span className="font-medium">{formatDate(free.availableFrom)}</span>
            .
          </p>
        ) : (
          // Not "never": an open-ended posting has no known end, and inventing
          // one would put somebody on a shortlist they cannot actually be on.
          <p className="text-ink-soft">
            Fully booked, with no agreed end date on their current work.
          </p>
        )}

        {candidate.commitments.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5 text-ink-soft">
            {candidate.commitments.map((commitment) => (
              <li key={commitment.projectId}>
                {commitment.projectName} · {commitment.allocationPercent}%
                {commitment.endDate ? ` until ${formatDate(commitment.endDate)}` : ' · no end date'}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
