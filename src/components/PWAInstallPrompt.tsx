import { useState, useEffect } from 'react';
import { Download, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('pwa_dismissed') === '1');

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem('pwa_dismissed', '1');
  };

  if (!deferredPrompt || dismissed) return null;

  return (
    <div className="fixed top-4 left-4 right-4 z-[60] animate-fade-in max-w-[448px] mx-auto">
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl p-4 flex items-center gap-3 text-white shadow-xl shadow-indigo-500/30">
        <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center shrink-0 backdrop-blur-sm">
          <Download size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold">Install Hisaab</p>
          <p className="text-[10px] text-white/70">Add to home screen for quick access</p>
        </div>
        <button onClick={handleInstall}
          className="px-4 py-2 rounded-xl bg-white text-indigo-600 text-[12px] font-bold active:scale-95 transition-all shrink-0">
          Install
        </button>
        <button onClick={handleDismiss} className="text-white/50 active:text-white/80 shrink-0">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
