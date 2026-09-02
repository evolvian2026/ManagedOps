import { useState } from 'react';
import { ROLES, type Role } from '@managedops/shared';
import {
  Badge,
  Button,
  Field,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { formatIst, humanise } from '../onboarding/format';
import {
  useCreateUser,
  useResetUserPassword,
  useSetUserStatus,
  useUsers,
  type UserRow,
} from './api';

/**
 * Administrative accounts.
 *
 * Only staff roles are created here. A trainer's login is not an account
 * somebody types in — it is produced by converting an accepted offer, which is
 * what guarantees every trainer login has a hiring decision behind it. Offering
 * "create a trainer" on this screen would be a second, unaudited way in.
 */
const STAFF_ROLES: Role[] = ROLES.filter(
  (role) => !['trainer', 'project_lead'].includes(role),
) as Role[];

const ROLE_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  super_admin: 'critical',
  manager: 'positive',
  hr: 'positive',
  interviewer: 'pending',
  project_lead: 'neutral',
  trainer: 'neutral',
};

export function UsersPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const users = useUsers({
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(role ? { role } : {}),
  });
  const setStatus = useSetUserStatus();
  const resetPassword = useResetUserPassword();
  const [reset, setReset] = useState<string | null>(null);

  async function toggle(row: UserRow) {
    setProblem(null);
    try {
      await setStatus.mutateAsync({ id: row.id, enabled: row.status !== 'active' });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  async function sendReset(row: UserRow) {
    setProblem(null);
    setReset(null);
    try {
      await resetPassword.mutateAsync(row.id);
      setReset(row.email);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Administrative accounts. Trainer logins come from converting an accepted offer."
        actions={<Button onClick={() => setCreating(true)}>Add an account</Button>}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Field
          label="Search"
          placeholder="Name or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          label="Role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role | '')}
        >
          <option value="">Every role</option>
          {ROLES.map((option) => (
            <option key={option} value={option}>
              {humanise(option)}
            </option>
          ))}
        </Select>
      </div>

      {problem ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
        >
          {problem}
        </div>
      ) : null}

      {reset ? (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary-wash px-3 py-2 text-sm">
          <p className="font-medium text-primary">A temporary password has been emailed.</p>
          <p className="mt-0.5 text-ink">
            {reset} must change it at their next sign-in before anything else works.
          </p>
        </div>
      ) : null}

      {users.isPending ? (
        <LoadingState label="Loading accounts" rows={5} />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.data.length === 0 ? (
        <EmptyState title="No accounts match" description="Widen the filters, or add an account." />
      ) : (
        <Table
          caption="Accounts"
          head={
            <>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Last signed in</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </>
          }
        >
          {users.data.data.map((row) => (
            <tr key={row.id}>
              <Td>
                <div className="font-medium text-ink">{row.name}</div>
                <div className="text-xs text-ink-soft">{row.email}</div>
              </Td>
              <Td>
                <Badge tone={ROLE_TONE[row.role] ?? 'neutral'}>{humanise(row.role)}</Badge>
              </Td>
              <Td className="whitespace-nowrap text-ink-soft tabular-nums">
                {row.lastLoginAt ? formatIst(row.lastLoginAt, 'short') : 'Never'}
              </Td>
              <Td>
                <Badge tone={row.status === 'active' ? 'positive' : 'neutral'}>
                  {humanise(row.status)}
                </Badge>
                {row.mustChangePassword ? (
                  <div className="mt-0.5 text-xs text-accent">Must change password</div>
                ) : null}
              </Td>
              <Td className="text-right whitespace-nowrap">
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => void sendReset(row)}>
                    Reset password
                  </Button>
                  {/* Disabling your own account would sign you out mid-click. */}
                  {row.id === user?.id ? (
                    <span className="self-center text-xs text-ink-faint">You</span>
                  ) : (
                    <Button variant="secondary" onClick={() => void toggle(row)}>
                      {row.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('hr');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<string | null>(null);
  const create = useCreateUser();

  function close() {
    setName('');
    setEmail('');
    setPhone('');
    setProblem(null);
    setFieldErrors({});
    setCreated(null);
    onClose();
  }

  async function submit() {
    setProblem(null);
    setFieldErrors({});
    try {
      const user = await create.mutateAsync({
        name: name.trim(),
        email: email.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        role,
      });
      setCreated(user.email);
      setName('');
      setEmail('');
      setPhone('');
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={open}
      title="Add an administrative account"
      description="They receive a temporary password and must change it before anything works."
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

        {created ? (
          <div className="rounded-md border border-primary/30 bg-primary-wash px-3 py-2 text-sm">
            <p className="font-medium text-primary">Account created for {created}.</p>
          </div>
        ) : null}

        <Field
          label="Name"
          required
          value={name}
          error={fieldErrors.name}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label="Email"
          type="email"
          required
          value={email}
          error={fieldErrors.email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Phone"
          value={phone}
          error={fieldErrors.phone}
          hint="Optional. A 10-digit Indian mobile number."
          onChange={(event) => setPhone(event.target.value)}
        />
        <Select
          label="Role"
          value={role}
          error={fieldErrors.role}
          hint="Trainer and project lead logins come from converting an accepted offer."
          onChange={(event) => setRole(event.target.value as Role)}
        >
          {STAFF_ROLES.map((option) => (
            <option key={option} value={option}>
              {humanise(option)}
            </option>
          ))}
        </Select>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
          <Button
            onClick={() => void submit()}
            pending={create.isPending}
            disabled={name.trim().length < 2 || !email.trim()}
          >
            Create account
          </Button>
        </div>
      </div>
    </Modal>
  );
}
