import { useState } from 'react';
import { CLIENT_STATUSES, type ClientStatus } from '@managedops/shared';
import {
  Badge,
  Button,
  Card,
  Field,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  TextArea,
  Th,
} from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { ApiError, errorMessage } from '../../lib/api';
import { formatDate, formatInr, humanise } from '../onboarding/format';
import { downloadCsv } from '../exit/api';
import { useAuth } from '../auth/auth-context';
import { useClient, useClients, useCreateClient, useUpdateClient } from './api';

/**
 * Who we deliver for, and on what terms.
 *
 * The rate column is not hidden by role here — it is simply absent from the
 * payload for anyone without `billing.read`, so this renders what it was given.
 * HR sees the directory they staff against; a manager sees the contract too.
 */
export function ClientsPage() {
  // HR reads this directory but does not own it. Offering them a control the
  // API would refuse is worse than not offering it: the refusal arrives after
  // they have typed the form.
  const { can } = useAuth();
  const mayManage = can('clients.manage');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ClientStatus | ''>('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const clients = useClients({
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(status ? { status } : {}),
  });

  const rows = clients.data?.data ?? [];
  const showsRates = rows.some((row) => 'defaultDayRate' in row);

  return (
    <>
      <PageHeader
        title="Clients"
        description="The organisations we deliver for, and the terms we deliver under."
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => void downloadCsv('/clients/export.csv', 'managedops-clients.csv')}
            >
              Export CSV
            </Button>
            {mayManage ? <Button onClick={() => setCreating(true)}>Add a client</Button> : null}
          </div>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Field
          label="Search"
          placeholder="Name, code or contact"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as ClientStatus | '')}
        >
          <option value="">Every status</option>
          {CLIENT_STATUSES.map((option) => (
            <option key={option} value={option}>
              {humanise(option)}
            </option>
          ))}
        </Select>
      </div>

      {clients.isPending ? (
        <LoadingState label="Loading clients" rows={4} />
      ) : clients.isError ? (
        <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No clients match"
          description="Widen the filters, or add the organisation you are delivering for."
        />
      ) : (
        <Table
          caption="Clients"
          head={
            <>
              <Th>Client</Th>
              <Th>Contact</Th>
              <Th>Running projects</Th>
              {showsRates ? <Th className="text-right">Contract rate</Th> : null}
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </>
          }
        >
          {rows.map((row) => (
            <tr key={row.id}>
              <Td>
                <div className="font-medium text-ink">{row.name}</div>
                <div className="font-mono text-xs text-ink-soft">{row.code}</div>
              </Td>
              <Td>
                {row.contactName ? (
                  <>
                    <div className="text-ink">{row.contactName}</div>
                    <div className="text-xs text-ink-soft">{row.contactEmail ?? '—'}</div>
                  </>
                ) : (
                  <span className="text-xs text-ink-faint">Nobody named</span>
                )}
              </Td>
              <Td className="tabular-nums">{row._count.projects}</Td>
              {showsRates ? (
                <Td className="text-right tabular-nums">
                  {row.defaultDayRate == null ? (
                    <span className="text-xs text-ink-faint">No rate agreed</span>
                  ) : (
                    <>
                      {formatInr(row.defaultDayRate)}
                      <span className="text-xs text-ink-soft"> / day</span>
                    </>
                  )}
                </Td>
              ) : null}
              <Td>
                <Badge tone={row.status === 'active' ? 'positive' : 'neutral'}>
                  {humanise(row.status)}
                </Badge>
              </Td>
              <Td className="text-right">
                <Button variant="secondary" onClick={() => setOpenId(row.id)}>
                  Open
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <ClientDialog open={creating} onClose={() => setCreating(false)} />
      <ClientDetailDialog id={openId} mayManage={mayManage} onClose={() => setOpenId(null)} />
    </>
  );
}

function ClientDetailDialog({
  id,
  mayManage,
  onClose,
}: {
  id: string | null;
  mayManage: boolean;
  onClose: () => void;
}) {
  const client = useClient(id);
  const update = useUpdateClient();
  const [problem, setProblem] = useState<string | null>(null);

  async function setStatus(status: ClientStatus) {
    setProblem(null);
    try {
      await update.mutateAsync({ id: id!, status });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={id !== null}
      title={client.data?.name ?? 'Client'}
      description={client.data ? `Code ${client.data.code}` : undefined}
      onClose={() => {
        setProblem(null);
        onClose();
      }}
    >
      {client.isPending ? (
        <LoadingState label="Loading the client" rows={3} />
      ) : client.isError ? (
        <ErrorState error={client.error} onRetry={() => void client.refetch()} />
      ) : (
        <div className="space-y-5">
          {problem ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
            >
              {problem}
            </div>
          ) : null}

          <Card title="Contract">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-ink-soft">Contact</dt>
              <dd className="text-ink">{client.data.contactName ?? '—'}</dd>
              <dt className="text-ink-soft">Email</dt>
              <dd className="text-ink">{client.data.contactEmail ?? '—'}</dd>
              <dt className="text-ink-soft">Phone</dt>
              <dd className="text-ink">{client.data.contactPhone ?? '—'}</dd>
              <dt className="text-ink-soft">GSTIN</dt>
              <dd className="font-mono text-ink">{client.data.gstin ?? '—'}</dd>
              <dt className="text-ink-soft">Billing address</dt>
              <dd className="text-ink">{client.data.billingAddress ?? '—'}</dd>
              {'defaultDayRate' in client.data ? (
                <>
                  <dt className="text-ink-soft">Contract rate</dt>
                  <dd className="text-ink tabular-nums">
                    {client.data.defaultDayRate == null
                      ? 'No rate agreed'
                      : `${formatInr(client.data.defaultDayRate)} per day`}
                  </dd>
                </>
              ) : null}
            </dl>
            {'defaultDayRate' in client.data ? (
              <p className="mt-3 text-xs text-ink-soft">
                This prefills a new assignment. What a client is billed is the rate on each
                assignment, so changing it here never reprices work already delivered.
              </p>
            ) : null}
          </Card>

          <Card title="Projects">
            {client.data.projects.length === 0 ? (
              <p className="text-sm text-ink-soft">Nothing has been delivered for them yet.</p>
            ) : (
              <ul className="space-y-2">
                {client.data.projects.map((project) => (
                  <li key={project.id} className="flex items-center justify-between gap-3 text-sm">
                    <div>
                      <div className="font-medium text-ink">{project.name}</div>
                      <div className="text-xs text-ink-soft">
                        {project.code} · from {formatDate(project.startDate)} ·{' '}
                        {project._count.assignments} on the roster
                      </div>
                    </div>
                    <Badge tone={project.status === 'active' ? 'positive' : 'neutral'}>
                      {humanise(project.status)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="flex justify-end gap-2">
            {mayManage ? (
              <Button
                variant="secondary"
                pending={update.isPending}
                onClick={() =>
                  void setStatus(client.data.status === 'active' ? 'inactive' : 'active')
                }
              >
                {client.data.status === 'active' ? 'Mark inactive' : 'Mark active'}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ClientDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [gstin, setGstin] = useState('');
  const [rate, setRate] = useState('');
  const [address, setAddress] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const create = useCreateClient();

  function close() {
    setName('');
    setCode('');
    setContactName('');
    setContactEmail('');
    setContactPhone('');
    setGstin('');
    setRate('');
    setAddress('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    setProblem(null);
    setFieldErrors({});
    try {
      await create.mutateAsync({
        name: name.trim(),
        code: code.trim().toUpperCase(),
        ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
        ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
        ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
        ...(gstin.trim() ? { gstin: gstin.trim().toUpperCase() } : {}),
        ...(address.trim() ? { billingAddress: address.trim() } : {}),
        ...(rate.trim() ? { defaultDayRate: Number(rate) } : {}),
      });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={open}
      title="Add a client"
      description="Projects are delivered for a client, so a project cannot exist without one."
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

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Name"
            required
            value={name}
            error={fieldErrors.name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label="Code"
            required
            hint="Short and unique. Letters, numbers and hyphens."
            value={code}
            error={fieldErrors.code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Field
            label="Contact name"
            value={contactName}
            error={fieldErrors.contactName}
            onChange={(event) => setContactName(event.target.value)}
          />
          <Field
            label="Contact email"
            type="email"
            value={contactEmail}
            error={fieldErrors.contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
          />
          <Field
            label="Contact phone"
            value={contactPhone}
            error={fieldErrors.contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
          />
          <Field
            label="GSTIN"
            hint="Optional. 15 characters."
            value={gstin}
            error={fieldErrors.gstin}
            onChange={(event) => setGstin(event.target.value)}
          />
          <Field
            label="Contract day rate"
            type="number"
            min={0}
            hint="In rupees. Prefills each new assignment."
            value={rate}
            error={fieldErrors.defaultDayRate}
            onChange={(event) => setRate(event.target.value)}
          />
        </div>

        <TextArea
          label="Billing address"
          rows={2}
          value={address}
          error={fieldErrors.billingAddress}
          onChange={(event) => setAddress(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={create.isPending}
            disabled={name.trim().length < 2 || code.trim().length < 2}
          >
            Create client
          </Button>
        </div>
      </div>
    </Modal>
  );
}
