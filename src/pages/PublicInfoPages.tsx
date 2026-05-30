import { ArrowLeft, ExternalLink, Mail } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const LAST_UPDATED = 'May 31, 2026';
const SUPPORT_EMAIL = 'support@usehisaab.com';
const SITE_URL = 'https://usehisaab.com';

type InfoPageKind = 'privacy' | 'terms' | 'contact' | 'delete-account';

interface PublicInfoPageProps {
  kind: InfoPageKind;
}

interface SectionProps {
  title: string;
  children: ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <section className="py-5 border-b border-cream-hairline last:border-b-0">
      <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
      <div className="mt-2.5 space-y-2.5 text-[13px] leading-6 text-ink-600">
        {children}
      </div>
    </section>
  );
}

function PolicyList({ children }: { children: ReactNode }) {
  return <ul className="list-disc pl-5 space-y-1.5">{children}</ul>;
}

function PublicInfoLayout({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  return (
    <main className="min-h-dvh bg-cream-soft">
      <header className="bg-navy-900 text-white">
        <div className="max-w-3xl mx-auto px-5 pt-5 pb-8">
          <div className="flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => navigate('/')}
              aria-label="Back to Hisaab"
              className="nav-icon-button bg-white/10 text-white border-white/10"
            >
              <ArrowLeft size={17} />
            </button>
            <Link to="/" className="text-[14px] font-semibold text-white">
              Hisaab
            </Link>
          </div>
          <h1 className="mt-8 text-[28px] font-semibold leading-tight">{title}</h1>
          <p className="mt-2 max-w-xl text-[13px] leading-6 text-white/65">{intro}</p>
          {title !== 'Contact & Support' && (
            <p className="mt-4 text-[11px] text-white/45">Last updated: {LAST_UPDATED}</p>
          )}
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-5 pb-8">
        <div className="bg-cream-card border-x border-b border-cream-border px-5 sm:px-7">
          {children}
        </div>
        <nav className="flex flex-wrap gap-x-4 gap-y-2 px-1 pt-5 text-[12px] font-semibold text-accent-600">
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/contact">Contact</Link>
          <Link to="/delete-account">Delete Account</Link>
        </nav>
        <p className="px-1 pt-4 text-[11px] text-ink-500">
          Hisaab is operated by Muhammad Abdullah.
        </p>
      </div>
    </main>
  );
}

function PrivacyPolicy() {
  return (
    <PublicInfoLayout
      title="Privacy Policy"
      intro="This policy explains how Hisaab handles information when you use the Hisaab web, PWA, or Android app."
    >
      <Section title="Who operates Hisaab">
        <p>
          Hisaab is operated by Muhammad Abdullah. The official website is{' '}
          <a className="font-semibold text-accent-600" href={SITE_URL}>
            {SITE_URL}
          </a>
          .
        </p>
      </Section>

      <Section title="Information Hisaab handles">
        <PolicyList>
          <li>Account and authentication data, such as your email address, authentication identifiers, and session information.</li>
          <li>Profile and settings data, such as your name, selected currency, language, app mode, and optional phone number you enter in Settings.</li>
          <li>User-created finance records, including accounts, income, expenses, transfers, loans, repayments, balances, goals, budgets, recurring entries, remittance records, notes, categories, and currencies.</li>
          <li>Collaboration data, including manually entered contacts, groups, split expenses, settlements, invite links, linked-record requests, and in-app notifications.</li>
          <li>Basic technical information needed to operate, secure, and debug the service. If crash reporting is enabled, error details and limited technical context may be sent to Sentry. Hisaab configures Sentry not to automatically send personal information.</li>
        </PolicyList>
        <p>
          Hisaab stores some settings, session information, and local data mirrors on your device so the app can stay signed in and work reliably. JSON backup files are created or imported only when you choose those actions.
        </p>
      </Section>

      <Section title="How information is used">
        <PolicyList>
          <li>To create and secure your account, sign you in, and keep your session active.</li>
          <li>To save, sync, restore, and display your finance records across supported devices.</li>
          <li>To calculate balances, summaries, reports, reminders, and group splits.</li>
          <li>To support collaboration features that you choose to use, such as shared groups and linked requests.</li>
          <li>To provide support, debug errors, and prevent fraud, misuse, or unauthorized access.</li>
        </PolicyList>
      </Section>

      <Section title="Storage and service providers">
        <p>
          Hisaab uses Supabase infrastructure for authentication and cloud data storage. It also uses service providers needed to operate the app, such as Vercel for website hosting. Those providers may process limited information on Hisaab&apos;s behalf when delivering their services.
        </p>
      </Section>

      <Section title="Sharing and sale of data">
        <p>Hisaab does not sell your personal data.</p>
        <p>
          Your private finance records are not intended to be shared with other users. Information is shared with another Hisaab user only when needed for a feature you choose to use, such as a group split, invite, or linked request. Hisaab may also disclose information when required by law or when reasonably necessary to protect users and the service.
        </p>
      </Section>

      <Section title="Retention and deletion">
        <p>
          You can delete your account inside the app from Settings, or request help by emailing{' '}
          <a className="font-semibold text-accent-600" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          . The in-app flow disables account access, removes personal finance records, and anonymizes your profile. Some shared records or limited provider backups and security logs may remain for a reasonable period when needed for other users&apos; accounting history, security, legal, or operational purposes.
        </p>
        <p>
          Read the <Link className="font-semibold text-accent-600" to="/delete-account">delete-account instructions</Link> for the current process.
        </p>
      </Section>

      <Section title="Your choices">
        <p>
          You may request access, correction, or deletion help by contacting{' '}
          <a className="font-semibold text-accent-600" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          . You are responsible for keeping exported backup files secure after downloading them.
        </p>
      </Section>

      <Section title="Security and changes">
        <p>
          Hisaab uses reasonable safeguards, including encrypted network connections, but no system can guarantee absolute security. This policy may be updated as the app changes. The latest version will remain available on this page.
        </p>
      </Section>
    </PublicInfoLayout>
  );
}

function TermsOfUse() {
  return (
    <PublicInfoLayout
      title="Terms of Use"
      intro="These terms apply when you use Hisaab to organize your personal finance records."
    >
      <Section title="About Hisaab">
        <p>
          Hisaab is a personal finance record-keeping tool. It helps you enter and review information such as accounts, income, expenses, loans, repayments, balances, currencies, and group splits.
        </p>
        <p>
          Hisaab is not a bank, licensed wallet, custody provider, lender, money transfer provider, investment platform, investment adviser, tax adviser, or financial adviser. Hisaab does not hold, move, lend, or invest money for you.
        </p>
      </Section>

      <Section title="Your records and decisions">
        <p>
          You are responsible for the accuracy of records you enter and for reviewing them before relying on them. Summaries, reports, reminders, exchange-rate entries, and calculations are informational only. You remain responsible for financial, legal, and tax decisions made using the app.
        </p>
      </Section>

      <Section title="Your account">
        <p>
          Keep your login details secure and use the app only through your own account. Notify{' '}
          <a className="font-semibold text-accent-600" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>{' '}
          if you believe your account has been accessed without permission.
        </p>
      </Section>

      <Section title="Acceptable use">
        <PolicyList>
          <li>Do not use Hisaab for illegal, fraudulent, or abusive activity.</li>
          <li>Do not disrupt, overload, probe, reverse engineer, or misuse the app or its infrastructure except where applicable law expressly permits it.</li>
          <li>Do not attempt to access another user&apos;s account, records, or shared information without permission.</li>
          <li>Do not upload or enter content that violates another person&apos;s rights.</li>
        </PolicyList>
      </Section>

      <Section title="Early-release service">
        <p>
          Hisaab is an early-release service. Features may change, be unavailable, or contain bugs. Access may be interrupted for maintenance, security work, provider outages, or product updates. Keep your own backup of records that are important to you.
        </p>
      </Section>

      <Section title="Accounts and deletion">
        <p>
          You may stop using Hisaab at any time. You can delete your account from Settings or request support by email. Hisaab may suspend or terminate access when reasonably necessary to address misuse, security risks, or legal requirements. See the{' '}
          <Link className="font-semibold text-accent-600" to="/delete-account">delete-account instructions</Link>.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          To the extent permitted by law, Hisaab and its operator are not liable for financial decisions, losses, missed payments, tax outcomes, or other consequences arising from records, calculations, reports, interruptions, or your use of the app. Nothing in these terms excludes liability that cannot legally be excluded.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms can be sent to{' '}
          <a className="font-semibold text-accent-600" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </PublicInfoLayout>
  );
}

function ContactSupport() {
  return (
    <PublicInfoLayout
      title="Contact & Support"
      intro="Reach the Hisaab support channel for account help, privacy questions, deletion requests, or bug reports."
    >
      <Section title="Hisaab support">
        <p>
          Email:{' '}
          <a className="font-semibold text-accent-600" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
        </p>
        <p>
          Website:{' '}
          <a className="font-semibold text-accent-600" href={SITE_URL}>
            {SITE_URL}
          </a>
        </p>
      </Section>

      <Section title="What to include">
        <p>
          For support or bug reports, describe what happened and the steps that led to it. For privacy or deletion requests, email from the address associated with your Hisaab account so the request can be verified.
        </p>
        <a
          className="inline-flex items-center gap-2 font-semibold text-accent-600"
          href={`mailto:${SUPPORT_EMAIL}?subject=Hisaab support request`}
        >
          <Mail size={15} />
          Email Hisaab support
        </a>
      </Section>
    </PublicInfoLayout>
  );
}

function DeleteAccountInstructions() {
  return (
    <PublicInfoLayout
      title="Delete Your Hisaab Account"
      intro="You can start account deletion inside Hisaab or request help from support."
    >
      <Section title="Delete from inside the app">
        <PolicyList>
          <li>Sign in to Hisaab.</li>
          <li>Open Settings.</li>
          <li>Open Delete account in the danger zone.</li>
          <li>Type DELETE and confirm the action.</li>
        </PolicyList>
      </Section>

      <Section title="Request deletion by email">
        <p>
          If you cannot access the app, email{' '}
          <a className="font-semibold text-accent-600" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>{' '}
          from the email address associated with your Hisaab account. Support may ask for reasonable information to verify the request.
        </p>
      </Section>

      <Section title="What deletion does">
        <p>
          The current in-app deletion flow disables access to the account, removes personal finance records, and anonymizes the profile. Collaboration links are removed or anonymized. Some shared records may remain or be adjusted where necessary so other users can retain their accounting history.
        </p>
        <p>
          Limited provider backups, security logs, or records required for legal or operational reasons may remain for a reasonable period before deletion or anonymization.
        </p>
      </Section>

      <Section title="Need help?">
        <a
          className="inline-flex items-center gap-2 font-semibold text-accent-600"
          href={`mailto:${SUPPORT_EMAIL}?subject=Hisaab account deletion request`}
        >
          <Mail size={15} />
          Request account deletion
          <ExternalLink size={14} />
        </a>
      </Section>
    </PublicInfoLayout>
  );
}

export function PublicInfoPage({ kind }: PublicInfoPageProps) {
  if (kind === 'privacy') return <PrivacyPolicy />;
  if (kind === 'terms') return <TermsOfUse />;
  if (kind === 'contact') return <ContactSupport />;
  return <DeleteAccountInstructions />;
}
