import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, errorMessage } from '../../lib/api';
import { Button, Field } from '../../components/ui';
import { useAuth } from './auth-context';

/**
 * One sign-in page for everyone (spec 15.11). The API decides where an
 * authenticated user lands, so nobody has to know which URL their role uses and
 * the page does not advertise which one administrators sign in at.
 */
export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : '/'} replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setProblem(null);
    setFieldErrors({});

    try {
      const signedIn = await signIn(email, password);
      const intended = (location.state as { from?: string } | null)?.from;
      navigate(signedIn.mustChangePassword ? '/change-password' : (intended ?? '/'), {
        replace: true,
      });
    } catch (error) {
      // Show exactly what the server said — never a generic stand-in.
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-2xl font-semibold tracking-tight text-ink">
            Managed<span className="text-primary">Ops</span>
          </p>
          <p className="mt-1 text-sm text-ink-soft">Workforce operations for training delivery</p>
        </div>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-5 rounded-lg border border-line bg-surface p-6"
        >
          <div>
            <h1 className="text-base font-semibold text-ink">Sign in</h1>
            <p className="mt-0.5 text-sm text-ink-soft">
              Use the account your organisation issued.
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
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            error={fieldErrors.email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Field
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            error={fieldErrors.password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <Button type="submit" pending={pending} className="w-full">
            {pending ? 'Signing in' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
