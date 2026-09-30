import { useEffect, useRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/** The handful of primitives the shell needs. Everything derives from the tokens. */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  pending?: boolean;
};

export function Button({
  variant = 'primary',
  pending = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';
  const variants = {
    primary: 'bg-primary text-white hover:bg-primary-hover',
    secondary: 'border border-line-strong bg-surface text-ink hover:bg-surface-sunk',
    ghost: 'text-ink-soft hover:bg-surface-sunk hover:text-ink',
  } as const;

  return (
    <button
      {...rest}
      disabled={disabled || pending}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
};

export function Field({ label, error, hint, id, className = '', ...rest }: FieldProps) {
  const inputId = id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full rounded-md border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint ${
          error ? 'border-danger' : 'border-line-strong'
        } ${className}`}
      />
      {hint && !error ? (
        <p id={`${inputId}-hint`} className="text-xs text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${inputId}-error`} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Status is carried by the label as well as the colour, never colour alone. */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'positive' | 'pending' | 'critical';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-surface-sunk text-ink-soft',
    positive: 'bg-primary-wash text-primary',
    pending: 'bg-accent-wash text-accent',
    critical: 'bg-danger-wash text-danger',
  } as const;

  return (
    <span
      // Never wrapped: a pill that breaks across two lines stops reading as one
      // label and starts reading as two truncated ones.
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    // A titled <section> is only a landmark once it has an accessible name; an
    // unnamed one is skipped by a screen reader's region list entirely.
    <section aria-label={title} className="rounded-lg border border-line bg-surface">
      {title ? (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-ink-soft">{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-soft">{description}</p> : null}
      </div>
      {actions}
    </header>
  );
}

/* ------------------------------------------------------------ data display */

export function Table({
  head,
  children,
  caption,
  compact = false,
}: {
  head: ReactNode;
  children: ReactNode;
  caption?: string;
  /**
   * Drops the minimum width, for a table inside a modal.
   *
   * The minimum keeps a full-page table from squashing its columns into
   * unreadable slivers. In a dialog it does the opposite: the table overflows
   * the dialog and the last column — usually the one the dialog exists to
   * show — sits off the edge behind a scrollbar nobody looks for.
   */
  compact?: boolean;
}) {
  return (
    // Wide tables scroll inside their own container so the page never does.
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`w-full text-sm ${compact ? '' : 'min-w-[52rem]'}`}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-line bg-surface-sunk text-left">{head}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-soft uppercase ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle text-ink ${className}`}>{children}</td>;
}

/**
 * A row of tabs.
 *
 * `secondary` is for the second level of a two-level set: pills rather than an
 * underline, so the eye can tell which row is the section and which is the page
 * within it. One component with two looks beats two components that drift.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  variant = 'primary',
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  variant?: 'primary' | 'secondary';
}) {
  const secondary = variant === 'secondary';

  return (
    <div
      role="tablist"
      aria-label={label}
      className={
        secondary ? 'flex flex-wrap gap-1.5 py-2' : 'flex flex-wrap gap-1 border-b border-line'
      }
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const chrome = secondary
          ? selected
            ? 'rounded-full bg-primary-wash px-3 py-1 text-primary'
            : 'rounded-full px-3 py-1 text-ink-soft hover:bg-surface-sunk hover:text-ink'
          : selected
            ? '-mb-px border-b-2 border-primary px-3.5 py-2 text-primary'
            : '-mb-px border-b-2 border-transparent px-3.5 py-2 text-ink-soft hover:text-ink';

        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`text-sm font-medium transition-colors ${chrome}`}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span
                className={`ml-2 rounded-full px-1.5 py-0.5 text-xs tabular-nums ${
                  selected ? 'bg-primary/15 text-primary' : 'bg-surface-sunk text-ink-soft'
                }`}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Everything that can hold focus, in the order Tab visits it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal for the short forms this section needs — schedule, screen, offer.
 *
 * `wide` is for the few that hold a table rather than a form: the default width
 * is chosen so a form does not sprawl, and the same width squeezes a row of
 * figures into something nobody can read across.
 *
 * `aria-modal` is a promise that the rest of the page is unreachable while this
 * is open. It used to be a promise this component did not keep — Tab walked
 * straight out into the page behind, focus never entered the dialog when it
 * opened, and never came back to the control that opened it. A dialog that
 * announces itself as modal and then behaves like a floating div is worse than
 * one that never claimed it, because a screen reader repeats the claim. So:
 * focus moves in on open, Tab cycles within, Escape closes, and focus returns
 * to wherever it came from.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  wide = false,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Remembered before anything moves, so closing puts the person back on the
    // control they opened this from rather than at the top of the document.
    returnTo.current = document.activeElement as HTMLElement | null;

    // Into the first thing worth acting on, falling back to the panel itself
    // so a dialog of pure text is still announced and still scrollable.
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;

      // Re-read on every press: a dialog's fields appear and disappear as
      // choices are made, and a list captured on open goes stale immediately.
      const stops = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }

      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;

      // Wrapping by hand rather than letting the browser take focus to the
      // page behind, which is exactly what `aria-modal` says cannot happen.
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!panel.current.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Only if focus is still somewhere in here: a dialog that closed because
      // the person clicked something else must not steal it back.
      if (!panel.current || panel.current.contains(document.activeElement)) {
        returnTo.current?.focus?.();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4 sm:items-center">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Focusable only programmatically: the panel is a fallback target when
        // it holds nothing else, never a stop on the way round.
        tabIndex={-1}
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-lg border border-line bg-surface shadow-lg focus:outline-none`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-ink-soft">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-ink-faint hover:bg-surface-sunk hover:text-ink"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

export function Select({
  label,
  error,
  hint,
  id,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: string }) {
  const selectId = id ?? `select-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={selectId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <select
        {...rest}
        id={selectId}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-md border bg-surface px-3 py-2 text-sm text-ink ${
          error ? 'border-danger' : 'border-line-strong'
        }`}
      >
        {children}
      </select>
      {hint && !error ? <p className="text-xs text-ink-soft">{hint}</p> : null}
      {error ? <p className="text-xs font-medium text-danger">{error}</p> : null}
    </div>
  );
}

export function TextArea({
  label,
  error,
  hint,
  id,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  const areaId = id ?? `area-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={areaId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <textarea
        {...rest}
        id={areaId}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-md border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint ${
          error ? 'border-danger' : 'border-line-strong'
        }`}
      />
      {hint && !error ? <p className="text-xs text-ink-soft">{hint}</p> : null}
      {error ? <p className="text-xs font-medium text-danger">{error}</p> : null}
    </div>
  );
}
