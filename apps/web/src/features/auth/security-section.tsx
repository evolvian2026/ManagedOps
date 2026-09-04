import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Capability } from '@managedops/shared';
import { Badge, Button, Card, Field } from '../../components/ui';
import { ErrorState, LoadingState } from '../../components/states';
import { api, errorMessage } from '../../lib/api';

interface MfaStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  /** Whether this deployment forces it. */
  required: boolean;
  /** Whether the permission matrix considers the role sensitive at all. */
  sensitive: boolean;
  reasons: Capability[];
  recoveryCodesRemaining: number;
}

interface EnrolmentOffer {
  secret: string;
  otpauthUri: string;
  qrDataUri: string;
}

const CAPABILITY_REASONS: Partial<Record<Capability, string>> = {
  'users.manage': 'create and disable accounts',
  'trainers.read_documents': 'open identity documents',
  'trainers.read_salary': 'see what people are paid',
  'billing.read': 'see rates and margin',
  'payroll.read': 'see the payroll register',
  'audit.read': 'read the audit log',
};

function useMfaStatus() {
  return useQuery({
    queryKey: ['mfa-status'],
    queryFn: ({ signal }) => api.get<MfaStatus>('/auth/mfa', signal),
  });
}

/**
 * The authenticator, from inside a session.
 *
 * A role that is required to hold one has already been through this on the way
 * in, so what this screen is mostly for is the rest: somebody adding one they
 * do not strictly need, and anybody checking how many recovery codes are left
 * before they find out the hard way.
 */
export function SecuritySection() {
  const client = useQueryClient();
  const status = useMfaStatus();
  const [offer, setOffer] = useState<EnrolmentOffer | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const begin = useMutation({
    mutationFn: () => api.post<EnrolmentOffer>('/auth/mfa/enrol', {}),
    onSuccess: setOffer,
  });

  const activate = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/activate', { code }),
    onSuccess: async (result) => {
      setRecoveryCodes(result.recoveryCodes);
      setOffer(null);
      setCode('');
      await client.invalidateQueries({ queryKey: ['mfa-status'] });
    },
  });

  const disable = useMutation({
    mutationFn: () => api.delete<{ message: string }>('/auth/mfa', { code }),
    onSuccess: async () => {
      setCode('');
      await client.invalidateQueries({ queryKey: ['mfa-status'] });
    },
  });

  if (status.isPending) return <LoadingState label="Loading your security settings" rows={2} />;
  if (status.isError) {
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  }

  const mfa = status.data;
  const reasons = mfa.reasons
    .map((capability) => CAPABILITY_REASONS[capability])
    .filter((reason): reason is string => Boolean(reason));

  return (
    <Card
      title="Signing in"
      description="A second factor on top of your password."
      actions={mfa.enrolled ? <Badge tone="positive">On</Badge> : <Badge tone="neutral">Off</Badge>}
    >
      <div className="space-y-5">
        {mfa.sensitive ? (
          <p className="text-sm text-ink-soft">
            Your role can {joinReasons(reasons)}, so an authenticator{' '}
            {mfa.required ? 'is required' : 'is strongly recommended'}.
          </p>
        ) : (
          <p className="text-sm text-ink-soft">
            Your role does not require one, but you can add one.
          </p>
        )}

        {recoveryCodes ? (
          <div className="rounded-md border border-line bg-surface-sunk p-3">
            <p className="text-sm font-medium text-ink">Save these. They are not shown again.</p>
            <ul className="mt-2 grid grid-cols-2 gap-2">
              {recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode} className="font-mono text-sm text-ink">
                  {recoveryCode}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {mfa.enrolled ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              {mfa.recoveryCodesRemaining} recovery{' '}
              {mfa.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
            </p>

            {mfa.required ? (
              <p className="text-sm text-ink-soft">
                It cannot be removed while your role requires it. If you have lost your phone, an
                administrator can reset it for you.
              </p>
            ) : (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  disable.mutate();
                }}
              >
                <div className="min-w-[12rem] flex-1">
                  <Field
                    label="Current code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    hint="Proves it is you, not a session somebody else is holding."
                  />
                </div>
                <Button type="submit" variant="secondary" pending={disable.isPending}>
                  Turn off
                </Button>
              </form>
            )}
          </div>
        ) : offer ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              activate.mutate();
            }}
          >
            <img
              src={offer.qrDataUri}
              alt="Scan this with your authenticator app"
              className="size-40 rounded border border-line bg-white"
            />
            <code className="block break-all rounded bg-surface-sunk px-2 py-1.5 text-xs text-ink">
              {offer.secret}
            </code>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[12rem] flex-1">
                <Field
                  label="Code from the app"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <Button type="submit" pending={activate.isPending}>
                Turn it on
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" pending={begin.isPending} onClick={() => begin.mutate()}>
            Add an authenticator
          </Button>
        )}

        {begin.isError || activate.isError || disable.isError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {errorMessage(begin.error ?? activate.error ?? disable.error)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function joinReasons(reasons: string[]): string {
  if (reasons.length === 0) return 'reach sensitive records';
  if (reasons.length === 1) return reasons[0]!;
  return `${reasons.slice(0, -1).join(', ')} and ${reasons.at(-1)}`;
}
