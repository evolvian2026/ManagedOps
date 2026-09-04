import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth, type MfaChallenge } from './auth-context';

interface EnrolmentOffer {
  secret: string;
  otpauthUri: string;
  qrDataUri: string;
}

/**
 * The second half of a privileged sign-in.
 *
 * Two shapes behind one component, because to the person at the keyboard it is
 * one step: either they already have an authenticator and type a code, or they
 * have not and set one up first. The password is behind them either way, and
 * neither path hands out a session until a code has been proved.
 */
export function MfaStep({
  challenge,
  onSignedIn,
  onCancel,
}: {
  challenge: MfaChallenge;
  onSignedIn: (mustChangePassword: boolean) => void;
  onCancel: () => void;
}) {
  const { completeMfa, completeMfaEnrolment } = useAuth();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [offer, setOffer] = useState<EnrolmentOffer | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const enrolling = challenge.mfa === 'enrolment';

  // Ask for the secret as soon as the step opens, so the QR code is on screen
  // by the time somebody has their phone out.
  useEffect(() => {
    if (!enrolling) return;
    let cancelled = false;
    api
      .post<EnrolmentOffer>('/auth/login/mfa/enrol', { challengeToken: challenge.challengeToken })
      .then((result) => {
        if (!cancelled) setOffer(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [enrolling, challenge.challengeToken]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setProblem(null);

    try {
      if (enrolling) {
        // The codes are shown once. Signing straight through to the app would
        // put them behind a page nobody can get back to.
        setRecoveryCodes(await completeMfaEnrolment(challenge.challengeToken, code));
      } else {
        const user = await completeMfa(challenge.challengeToken, code);
        onSignedIn(user.mustChangePassword);
      }
    } catch (error) {
      setProblem(errorMessage(error));
      setCode('');
    } finally {
      setPending(false);
    }
  }

  if (recoveryCodes) {
    return <RecoveryCodes codes={recoveryCodes} onContinue={() => onSignedIn(false)} />;
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="space-y-5 rounded-lg border border-line bg-surface p-6"
    >
      <div>
        <h1 className="text-base font-semibold text-ink">
          {enrolling ? 'Set up your authenticator' : 'Enter your code'}
        </h1>
        <p className="mt-0.5 text-sm text-ink-soft">
          {enrolling
            ? 'Your role can see identity documents and pay, so it needs a second factor.'
            : 'Open your authenticator app and enter the six-digit code.'}
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

      {enrolling ? (
        offer ? (
          <div className="space-y-3">
            <img
              src={offer.qrDataUri}
              alt="Scan this with your authenticator app"
              className="mx-auto size-44 rounded border border-line bg-white"
            />
            <div>
              <p className="text-xs font-semibold tracking-wide text-ink-soft uppercase">
                Or type this in
              </p>
              {/* Not everybody has a camera to hand, and a laptop scanning its
                  own screen is not a thing. */}
              <code className="mt-1 block break-all rounded bg-surface-sunk px-2 py-1.5 text-xs text-ink">
                {offer.secret}
              </code>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Preparing your authenticator…</p>
        )
      ) : null}

      <Field
        label={enrolling ? 'Code from the app' : 'Six-digit code'}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        autoFocus
        value={code}
        onChange={(event) => setCode(event.target.value)}
        hint={enrolling ? undefined : 'Or one of your recovery codes, if you have lost your phone.'}
      />

      <Button type="submit" pending={pending} className="w-full" disabled={enrolling && !offer}>
        {enrolling ? 'Turn it on' : 'Continue'}
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onCancel}>
        Back to sign in
      </Button>
    </form>
  );
}

/**
 * Shown once, and deliberately blocking.
 *
 * These are the only way back in when the phone is lost, and there is no screen
 * that will show them again — so the person has to say they have kept them
 * before the app will move on.
 */
function RecoveryCodes({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [kept, setKept] = useState(false);

  return (
    <div className="space-y-5 rounded-lg border border-line bg-surface p-6">
      <div>
        <h1 className="text-base font-semibold text-ink">Save your recovery codes</h1>
        <p className="mt-0.5 text-sm text-ink-soft">
          Each one signs you in once if you lose your phone. They are not shown again.
        </p>
      </div>

      <ul className="grid grid-cols-2 gap-2 rounded-md bg-surface-sunk p-3">
        {codes.map((recoveryCode) => (
          <li key={recoveryCode} className="font-mono text-sm tracking-tight text-ink">
            {recoveryCode}
          </li>
        ))}
      </ul>

      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={kept}
          onChange={(event) => setKept(event.target.checked)}
          className="mt-0.5"
        />
        I have saved these somewhere safe
      </label>

      <Button className="w-full" disabled={!kept} onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}
