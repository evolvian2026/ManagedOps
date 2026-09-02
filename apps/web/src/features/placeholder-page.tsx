import { PageHeader } from '../components/ui';

/**
 * A route that exists in the navigation but whose module lands in a later
 * phase. It says so plainly rather than rendering a mocked-up screen — a fake
 * table of invented rows is worse than an honest empty one.
 */
export function PlaceholderPage({
  title,
  phase,
  summary,
}: {
  title: string;
  phase: string;
  summary: string;
}) {
  return (
    <>
      <PageHeader title={title} description={summary} />
      <div className="rounded-md border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
        <p className="text-sm font-medium text-ink">Arriving in {phase}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
          The navigation, permissions and data model for this area are in place. The screen itself
          is built in {phase}.
        </p>
      </div>
    </>
  );
}
