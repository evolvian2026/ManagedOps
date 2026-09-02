import { useState } from 'react';
import { PageHeader, Tabs } from '../../components/ui';
import { ErrorBoundary } from '../../components/states';
import { OpenPositions } from './open-positions';
import { InterviewPipeline } from './interview-pipeline';
import { OfferLetters } from './offer-letters';

type Section = 'positions' | 'interviews' | 'offers';

const SECTIONS: { id: Section; label: string; description: string }[] = [
  {
    id: 'positions',
    label: 'Open Positions',
    description: 'Every open requisition and who has applied to it.',
  },
  {
    id: 'interviews',
    label: 'Interview Pipeline',
    description: 'Who is booked, who has been seen, and who needs rescheduling.',
  },
  {
    id: 'offers',
    label: 'Offer Letters',
    description: 'Offers drafted, sent, and how each one was answered.',
  },
];

/**
 * The three stages of hiring, in the order they happen. Each is wrapped in its
 * own boundary so a failure in one does not take the whole section down.
 */
export function OnboardingPage() {
  const [section, setSection] = useState<Section>('positions');
  const current = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0]!;

  return (
    <>
      <PageHeader title="Onboarding" description={current.description} />

      <div className="mb-5">
        <Tabs
          label="Onboarding stages"
          active={section}
          onChange={setSection}
          tabs={SECTIONS.map((entry) => ({ id: entry.id, label: entry.label }))}
        />
      </div>

      <ErrorBoundary area={current.label}>
        {section === 'positions' ? (
          <OpenPositions />
        ) : section === 'interviews' ? (
          <InterviewPipeline />
        ) : (
          <OfferLetters />
        )}
      </ErrorBoundary>
    </>
  );
}
