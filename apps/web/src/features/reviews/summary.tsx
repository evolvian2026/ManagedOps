import { Badge } from '../../components/ui';
import { humanise } from '../onboarding/format';
import type { ReviewSummary } from './api';

const TREND_LABEL: Record<'improving' | 'declining' | 'steady', string> = {
  improving: 'Improving',
  declining: 'Declining',
  steady: 'Steady',
};

/**
 * How somebody is rated, said carefully.
 *
 * The caveat is the point. A 5.0 from one review rendered like a verdict is how
 * a score gets acted on that should not have been, so where the summary is not
 * confident the screen says so louder than it says the number.
 */
export function QualitySummary({
  summary,
  compact = false,
}: {
  summary: ReviewSummary;
  compact?: boolean;
}) {
  if (summary.overall == null) {
    return (
      <p className="text-sm text-ink-soft">
        {summary.retractedCount > 0
          ? 'Every review recorded has since been withdrawn.'
          : 'Nobody has recorded any feedback yet.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-semibold tabular-nums text-ink">{summary.overall}</span>
        <span className="text-sm text-ink-soft">out of 5</span>
        {summary.trend ? (
          <Badge
            tone={
              summary.trend === 'improving'
                ? 'positive'
                : summary.trend === 'declining'
                  ? 'critical'
                  : 'neutral'
            }
          >
            {TREND_LABEL[summary.trend]}
          </Badge>
        ) : null}
        {summary.confident ? null : <Badge tone="pending">Not enough to go on</Badge>}
      </div>

      <p className="text-xs text-ink-soft">
        {summary.reviewCount} review{summary.reviewCount === 1 ? '' : 's'} from{' '}
        {summary.respondentCount} {summary.respondentCount === 1 ? 'person' : 'people'}
        {summary.retractedCount > 0 ? ` · ${summary.retractedCount} withdrawn and excluded` : ''}
      </p>

      {summary.caveat ? (
        <p className="rounded-md border border-accent/30 bg-accent-wash px-3 py-2 text-xs text-ink">
          {summary.caveat}
        </p>
      ) : null}

      {compact ? null : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {summary.bySource.map((entry) => (
              <div key={entry.source} className="contents">
                <dt className="text-ink-soft">{humanise(entry.source)}</dt>
                <dd className="tabular-nums text-ink">
                  {entry.average}
                  <span className="ml-1.5 text-xs text-ink-soft">
                    from {entry.respondents} {entry.respondents === 1 ? 'person' : 'people'}
                  </span>
                </dd>
              </div>
            ))}
          </dl>

          <p className="text-xs text-ink-faint">
            Each source counts equally. Within one, a cohort counts for its size — so forty learners
            are not one opinion, and one client is not drowned out by them.
          </p>

          <Dimensions dimensions={summary.dimensions} />
        </>
      )}
    </div>
  );
}

function Dimensions({ dimensions }: { dimensions: ReviewSummary['dimensions'] }) {
  const entries = (
    [
      ['Knowledge', dimensions.knowledge],
      ['Delivery', dimensions.delivery],
      ['Professionalism', dimensions.professionalism],
    ] as const
  ).filter(([, value]) => value != null);

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([label, value]) => (
        <span
          key={label}
          className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-soft"
        >
          {label} <span className="font-medium tabular-nums text-ink">{value}</span>
        </span>
      ))}
    </div>
  );
}
