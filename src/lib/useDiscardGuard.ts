import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useT } from './i18n';

// Returns a guard for modal/stepper dismissal. Pass it as Modal's `confirmClose`
// (or call directly): when `isDirty` is true it asks the user to confirm
// discarding their unsaved input; when false it closes with zero friction.
//
//   const guardClose = useDiscardGuard();
//   <Modal confirmClose={() => guardClose(isDirty)} ... />
//
// Resolves true when it's OK to close, false to stay open.
export function useDiscardGuard() {
  const t = useT();
  return (isDirty: boolean): boolean | Promise<boolean> => {
    if (!isDirty) return true;
    return confirmDestructive({
      title: t('discard_title'),
      description: t('discard_body'),
      confirmLabel: t('discard_yes'),
      cancelLabel: t('discard_keep'),
      tone: 'warning',
    });
  };
}
