import { useEffect, useState } from 'react';
import { LockKeyhole, WalletCards } from 'lucide-react';

const LOADING_MESSAGES = [
  'Loading awesomeness for you 🚀',
  'Preparing your dashboard ✨',
  'Balancing your Hisaab 🧮',
  'Securing your data 🔐',
  'Getting your groups ready 🤝',
  'Almost there, money boss 😄',
];

export function AppLoadingScreen() {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % LOADING_MESSAGES.length);
    }, 1600);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="app-loading-screen" role="status" aria-live="polite" aria-label="Hisaab is loading">
      <span className="sr-only">Hisaab is loading. Your finances are being prepared securely.</span>

      <div className="app-loading-content">
        <div className="app-loading-brand">
          <div className="app-loading-mark" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 512 512">
              <rect x="160" y="146" width="56" height="220" rx="10" fill="#F4F2EC" />
              <rect x="296" y="146" width="56" height="220" rx="10" fill="#F4F2EC" />
              <rect x="160" y="229" width="192" height="54" rx="10" fill="#7C5CFF" />
            </svg>
          </div>
          <h1>Hisaab</h1>
        </div>

        <div className="app-loading-visual" aria-hidden="true">
          <div className="app-loading-wallet">
            <WalletCards size={42} strokeWidth={1.6} />
          </div>
          <span className="app-loading-coin app-loading-coin-one">₨</span>
          <span className="app-loading-coin app-loading-coin-two">₨</span>
          <span className="app-loading-coin app-loading-coin-three">₨</span>
          <span className="app-loading-spark app-loading-spark-one">✦</span>
          <span className="app-loading-spark app-loading-spark-two">✧</span>
        </div>

        <div className="app-loading-copy">
          <p className="app-loading-message" aria-hidden="true" key={messageIndex}>
            {LOADING_MESSAGES[messageIndex]}
          </p>
          <p className="app-loading-subline">Your finances. Your way. All in one place.</p>
        </div>

        <div className="app-loading-progress" aria-hidden="true">
          <span />
        </div>

        <p className="app-loading-trust">
          <LockKeyhole size={12} strokeWidth={2} aria-hidden="true" />
          Your data stays private and secure.
        </p>
      </div>

      <p className="app-loading-tip">
        Tip: You can track expenses, loans, and group splits in one place.
      </p>
    </main>
  );
}
