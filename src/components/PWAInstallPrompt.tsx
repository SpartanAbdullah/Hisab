import { useEffect, useState } from 'react';
import { Download, Share2, Smartphone, X } from 'lucide-react';
import { useT } from '../lib/i18n';

const DISMISS_KEY = 'hisaab_pwa_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

type InstallMode = 'native' | 'ios' | 'android' | null;

function isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  const navigatorWithStandalone = window.navigator as NavigatorWithStandalone;
  return window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true;
}

function getInstallPlatform(): 'ios' | 'android' | 'other' {
  if (typeof window === 'undefined') return 'other';

  const userAgent = window.navigator.userAgent.toLowerCase();
  const navigatorWithStandalone = window.navigator as NavigatorWithStandalone;
  const isDesktopIpad = userAgent.includes('macintosh') && (navigatorWithStandalone.maxTouchPoints ?? 0) > 1;

  if (/iphone|ipad|ipod/.test(userAgent) || isDesktopIpad) return 'ios';
  if (/android/.test(userAgent)) return 'android';
  return 'other';
}

export function PWAInstallPrompt() {
  const t = useT();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1');
  const [installed, setInstalled] = useState(() => isStandaloneMode());
  const [showFallback, setShowFallback] = useState(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const legacyMediaQuery = mediaQuery as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    };
    const handleStandaloneChange = (event?: MediaQueryListEvent) => {
      if (event?.matches ?? mediaQuery.matches) {
        setInstalled(true);
        setDeferredPrompt(null);
      }
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    if ('addEventListener' in mediaQuery) {
      mediaQuery.addEventListener('change', handleStandaloneChange);
    } else if (legacyMediaQuery.addListener) {
      legacyMediaQuery.addListener(handleStandaloneChange);
    }

    const fallbackTimer = window.setTimeout(() => setShowFallback(true), 1500);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      if ('removeEventListener' in mediaQuery) {
        mediaQuery.removeEventListener('change', handleStandaloneChange);
      } else if (legacyMediaQuery.removeListener) {
        legacyMediaQuery.removeListener(handleStandaloneChange);
      }
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  const installPlatform = getInstallPlatform();
  let installMode: InstallMode = null;

  if (!installed && !dismissed) {
    if (deferredPrompt) {
      installMode = 'native';
    } else if (showFallback && installPlatform === 'ios') {
      installMode = 'ios';
    } else if (showFallback && installPlatform === 'android') {
      installMode = 'android';
    }
  }

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
    sessionStorage.setItem(DISMISS_KEY, '1');
  };

  if (!installMode) return null;

  const PromptIcon = installMode === 'ios' ? Share2 : installMode === 'android' ? Smartphone : Download;
  const subtitle =
    installMode === 'native'
      ? t('pwa_install_native_sub')
      : installMode === 'ios'
        ? t('pwa_install_ios_sub')
        : t('pwa_install_android_sub');
  const steps =
    installMode === 'ios'
      ? t('pwa_install_ios_steps')
      : installMode === 'android'
        ? t('pwa_install_android_steps')
        : '';

  return (
    <div className="fixed top-4 left-4 right-4 z-[60] animate-fade-in max-w-[448px] mx-auto">
      <div className="bg-gradient-to-r from-indigo-600 to-violet-600 rounded-2xl p-4 flex items-start gap-3 text-white shadow-xl shadow-indigo-500/30">
        <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center shrink-0 backdrop-blur-sm mt-0.5">
          <PromptIcon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold">{t('pwa_install_title')}</p>
          <p className="text-[10px] text-white/75 mt-0.5">{subtitle}</p>
          {steps ? <p className="text-[10px] text-white/85 mt-2 leading-relaxed">{steps}</p> : null}
        </div>
        {installMode === 'native' ? (
          <button
            onClick={handleInstall}
            className="px-4 py-2 rounded-xl bg-white text-indigo-600 text-[12px] font-bold active:scale-95 transition-all shrink-0"
          >
            {t('pwa_install_cta')}
          </button>
        ) : null}
        <button onClick={handleDismiss} className="text-white/60 active:text-white/90 shrink-0">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
