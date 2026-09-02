import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { passwordSchema } from '@managedops/shared';
import { ApiError, errorMessage } from '../../lib/api';
import { Button, Field } from '../../components/ui';
import { useAuth } from './auth-context';

/**
 * Shown when the account still carries a temporary password. The server blocks
 * every other route until this succeeds, so this screen is not merely a
 * suggestion the client could route around.
 */
export function ChangePasswordPage() {
  const { user, changePassword } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!user) return <Navigate to="/login" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setFieldErrors({});

    if (newPassword !== confirmation) {
      setFieldErrors({ confirmation: 'This does not match your new password' });
      return;
    }

    const policy = passwordSchema.safeParse(newPassword);
    if (!policy.success) {
      setFieldErrors({
        newPassword: policy.error.issues[0]?.message ?? 'Choose a stronger password',
      });
      return;
    }

    setPending(true);
    try {
      await changePassword(currentPassword, newPassword);
      navigate('/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <form
        onSubmit={handleSubmit}
        noValidate
        className="w-full max-w-sm space-y-5 rounded-lg border border-line bg-surface p-6"
      >
        <div>
          <h1 className="text-base font-semibold text-ink">Choose your own password</h1>
          <p className="mt-1 text-sm text-ink-soft">
            You are signed in with a temporary password. Replace it to continue.
          </p>
        </div>

        {problem ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
          >
            {problem}
          </div>
        ) : null}

        <Field
          label="Temporary password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={currentPassword}
          error={fieldErrors.currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 12 characters, with an uppercase letter, a lowercase letter and a number."
          value={newPassword}
          error={fieldErrors.newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          error={fieldErrors.confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />

        <Button type="submit" pending={pending} className="w-full">
          {pending ? 'Saving' : 'Save and continue'}
        </Button>
        <p className="text-xs text-ink-soft">
          Saving signs you out of every other device where this password was used.
        </p>
      </form>
    </main>
  );
}
