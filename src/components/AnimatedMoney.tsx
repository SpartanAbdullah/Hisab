import { MoneyDisplay } from './MoneyDisplay';
import { useCountUp } from '../hooks/useCountUp';

type MoneyProps = React.ComponentProps<typeof MoneyDisplay>;

interface Props extends MoneyProps {
  /** Set false while the real figure is still loading — animating a
   *  placeholder to zero and back looks like the balance dropped. */
  animate?: boolean;
  durationMs?: number;
}

// MoneyDisplay, but the figure counts up to its value.
//
// This wrapper is the entire reason useCountUp is safe to use: the rAF loop
// sets state ~50 times per run, and React re-renders the component that owns
// that state plus its children. Keeping it here — a leaf whose only child is
// MoneyDisplay's handful of spans — means the Home page's own tree (quick
// tiles, this-week rows, coach cards, account list) renders exactly once
// while the hero number animates.
//
// Put this in a page component instead and you get a 50× re-render of the
// whole dashboard on every balance refresh.
export function AnimatedMoney({ amount, animate = true, durationMs, ...rest }: Props) {
  const value = useCountUp(amount, { enabled: animate, ...(durationMs ? { duration: durationMs } : {}) });
  return <MoneyDisplay amount={value} {...rest} />;
}
