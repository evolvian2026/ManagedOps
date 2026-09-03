import { useState } from 'react';
import { PROFICIENCIES, type Proficiency } from '@managedops/shared';
import { Badge, Button, Field, Modal, Select } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { formatDate, humanise } from '../onboarding/format';
import { useAuth } from '../auth/auth-context';
import {
  useRemoveTrainerSkill,
  useSetTrainerSkill,
  useSkills,
  useTrainerSkills,
  type TrainerSkill,
} from './api';

const PROFICIENCY_TONE: Record<Proficiency, 'neutral' | 'positive' | 'pending'> = {
  beginner: 'neutral',
  intermediate: 'neutral',
  advanced: 'pending',
  expert: 'positive',
};

/**
 * What a trainer can teach.
 *
 * Editable by the trainer themselves as well as by HR: nobody knows what
 * somebody can teach better than they do, and a catalogue that only HR can
 * update is one that goes stale and stops being worth matching against.
 */
export function TrainerSkillsTab({
  trainerId,
  /** Off when the surrounding card already says what this is. */
  showIntro = true,
}: {
  trainerId: string;
  showIntro?: boolean;
}) {
  const { can } = useAuth();
  const skills = useTrainerSkills(trainerId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TrainerSkill | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = useRemoveTrainerSkill();

  const mayEdit = can('skills.manage');

  async function drop(skillId: string) {
    setProblem(null);
    try {
      await remove.mutateAsync({ trainerId, skillId });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        {showIntro ? (
          <p className="text-sm text-ink-soft">
            What this trainer can teach. Matching ranks against exactly this.
          </p>
        ) : (
          <span />
        )}
        {mayEdit ? <Button onClick={() => setAdding(true)}>Add a skill</Button> : null}
      </div>

      {problem ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
        >
          {problem}
        </div>
      ) : null}

      {skills.isPending ? (
        <LoadingState label="Loading skills" rows={3} />
      ) : skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
      ) : skills.data.length === 0 ? (
        <EmptyState
          title="No skills recorded"
          description="Until something is here, this trainer will not appear in any search."
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {skills.data.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{entry.skill.name}</span>
                  <Badge tone={PROFICIENCY_TONE[entry.proficiency]}>
                    {humanise(entry.proficiency)}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-ink-soft">
                  {entry.years ? `${Number(entry.years)} years` : 'Years not recorded'}
                  {' · '}
                  {entry.lastUsedOn
                    ? `last used ${formatDate(entry.lastUsedOn)}`
                    : 'never said when it was last used'}
                </div>
              </div>
              {mayEdit ? (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setEditing(entry)}>
                    Edit
                  </Button>
                  <Button variant="secondary" onClick={() => void drop(entry.skill.id)}>
                    Remove
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <SkillDialog
        open={adding || editing !== null}
        trainerId={trainerId}
        existing={editing}
        held={(skills.data ?? []).map((entry) => entry.skill.id)}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function SkillDialog({
  open,
  trainerId,
  existing,
  held,
  onClose,
}: {
  open: boolean;
  trainerId: string;
  existing: TrainerSkill | null;
  held: string[];
  onClose: () => void;
}) {
  const catalogue = useSkills({ status: 'active' });
  const save = useSetTrainerSkill();

  const [skillId, setSkillId] = useState('');
  const [proficiency, setProficiency] = useState<Proficiency>('intermediate');
  const [years, setYears] = useState('');
  const [lastUsedOn, setLastUsedOn] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seed the form from the row being edited, once per opening.
  if (open && existing && seeded !== existing.id) {
    setSeeded(existing.id);
    setSkillId(existing.skill.id);
    setProficiency(existing.proficiency);
    setYears(existing.years ? String(Number(existing.years)) : '');
    setLastUsedOn(existing.lastUsedOn ? existing.lastUsedOn.slice(0, 10) : '');
  }

  function close() {
    setSkillId('');
    setProficiency('intermediate');
    setYears('');
    setLastUsedOn('');
    setProblem(null);
    setSeeded(null);
    onClose();
  }

  async function submit() {
    setProblem(null);
    try {
      await save.mutateAsync({
        trainerId,
        skillId,
        proficiency,
        ...(years.trim() ? { years: Number(years) } : {}),
        ...(lastUsedOn ? { lastUsedOn } : {}),
      });
      close();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  const available = (catalogue.data?.data ?? []).filter(
    (skill) => skill.id === skillId || !held.includes(skill.id),
  );

  return (
    <Modal
      open={open}
      title={existing ? `Edit ${existing.skill.name}` : 'Add a skill'}
      description="Proficiency and recency both change where this trainer ranks in a search."
      onClose={close}
    >
      <div className="space-y-5">
        {problem ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
          >
            {problem}
          </div>
        ) : null}

        <Select
          label="Skill"
          required
          value={skillId}
          disabled={existing !== null}
          hint={existing ? 'Remove and re-add to change which skill this is.' : undefined}
          onChange={(event) => setSkillId(event.target.value)}
        >
          <option value="">Choose a skill</option>
          {available.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.category ? `${skill.category} · ${skill.name}` : skill.name}
            </option>
          ))}
        </Select>

        <Select
          label="Proficiency"
          value={proficiency}
          onChange={(event) => setProficiency(event.target.value as Proficiency)}
        >
          {PROFICIENCIES.map((level) => (
            <option key={level} value={level}>
              {humanise(level)}
            </option>
          ))}
        </Select>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Years of experience"
            type="number"
            min={0}
            step="0.5"
            value={years}
            onChange={(event) => setYears(event.target.value)}
          />
          <Field
            label="Last used"
            type="date"
            hint="A skill unused for years ranks below the same skill used last month."
            value={lastUsedOn}
            onChange={(event) => setLastUsedOn(event.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={save.isPending} disabled={!skillId}>
            {existing ? 'Save' : 'Add skill'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
