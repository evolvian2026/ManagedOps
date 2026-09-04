import { PageHeader } from '../../components/ui';
import { ContactPreferences } from '../workforce/contact-preferences';
import { SecuritySection } from './security-section';

/**
 * The settings that are about the person rather than their work.
 *
 * One page for every role, because both of these apply to everybody: an HR
 * administrator has an authenticator to manage and no trainer profile to hang
 * it off, and a trainer has a phone number to keep current. Splitting them by
 * role would have meant two homes for the same two settings.
 */
export function MyAccountPage() {
  return (
    <>
      <PageHeader title="My account" description="How we reach you, and how you sign in." />
      <div className="grid gap-5 lg:grid-cols-2">
        <ContactPreferences />
        <SecuritySection />
      </div>
    </>
  );
}
