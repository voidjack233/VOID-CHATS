import LegalLayout, {
  LegalBulletList,
  LegalSection,
} from '../components/common/LegalLayout';

const LAST_UPDATED = 'April 1, 2026';

export default function TermsOfUse() {
  return (
    <LegalLayout
      title="Terms of Use"
      subtitle="These are the simple rules for using VOID. VOID is a small private messaging app for direct messages, group chats, media sharing, invites, and supported encrypted conversations."
      lastUpdated={LAST_UPDATED}
      active="terms"
    >
      <LegalSection title="1. Using VOID">
        <p>
          VOID is a messaging app. By using it, you agree to these terms. If you do not agree, do
          not use VOID.
        </p>
        <p>
          VOID may change a lot while it is still small and growing. Features may be added, changed,
          limited, or removed at any time.
        </p>
      </LegalSection>

      <LegalSection title="2. Accounts And Security">
        <LegalBulletList
          items={[
            'You are responsible for your account, devices, passwords, and recovery methods.',
            'You must provide real account information and keep it reasonably up to date.',
            'You must not use someone else’s account or let someone else use yours to abuse the service.',
          ]}
        />
      </LegalSection>

      <LegalSection title="3. Acceptable Use">
        <LegalBulletList
          items={[
            'Do not use VOID to break the law, harm people, spread malware, spam, phish, or harass others.',
            'Do not try to access accounts, messages, or systems you are not allowed to access.',
            'Do not overload, scrape, sabotage, or abuse the service.',
            'Do not impersonate other people or misrepresent who you are.',
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Content">
        <p>
          You keep ownership of the content you create or send through VOID.
        </p>
        <p>
          You give VOID permission to store, process, and transmit that content only as needed to
          run, secure, and improve the service.
        </p>
        <p>
          You are responsible for what you upload, send, or share.
        </p>
      </LegalSection>

      <LegalSection title="5. Encryption And Limits">
        <p>
          VOID supports encryption for supported conversations and encrypted attachment flows, but
          not every part of the service is end-to-end encrypted.
        </p>
        <p>
          Account data, security logs, metadata, session data, avatars, group icons, and some
          invite-related information may be stored or processed outside end-to-end encryption.
        </p>
        <p>
          VOID is provided as is. We do not promise perfect uptime, perfect delivery, or perfect
          recovery of every message or file.
        </p>
      </LegalSection>

      <LegalSection title="6. Enforcement And Updates">
        <p>
          VOID may suspend or remove access if someone abuses the service, creates risk for other
          users, or breaks these terms.
        </p>
        <p>
          These terms may be updated over time. If you keep using VOID after an update, that means
          you accept the new version.
        </p>
        <p>
          Your use of VOID is also subject to the Privacy Policy.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
