import { Icon3D } from './Icon3D';
import {
  clayCardLayoutClasses,
  clayTintClass,
  type ClayCardPadding,
  type ClayTint,
} from '../lib/clay';

interface Props {
  /** Defaults to `neutral`: an informational surface with no domain meaning
   *  must not borrow one. Tint it only when the card IS about that domain. */
  tint?: ClayTint;
  /** Structural element. Keep it semantic — `section` for a titled block,
   *  `article` for a self-contained item, `div` for pure grouping. */
  as?: 'div' | 'section' | 'article' | 'li';
  /**
   * 'md' (20px) by default. 'none' is for a list container that supplies its
   * own row padding — the card then contributes the surface and the radius
   * only, and rows can run edge to edge.
   */
  padding?: ClayCardPadding;
  /**
   * Optional 3D asset floating off the top inline-end corner, exactly as on
   * Tile3D. Sanctioned on tier 2: the tiers are separated by the lip, the
   * press, the focus ring and the radius — not by the art.
   *
   * Reserves a 64px inline-end gutter, except under `padding="none"` where
   * the caller owns the spacing.
   */
  icon?: string;
  /**
   * Inline styles. Deliberately narrow in intent: this exists for per-item
   * `animationDelay` on a staggered list, which cannot be a class because the
   * value is an index. Do not reach for it to set colours or spacing — those
   * are tokens.
   */
  style?: React.CSSProperties;
  children: React.ReactNode;
  className?: string;
}

/**
 * Tier 2 of the clay system: the INFORMATIONAL surface.
 *
 * Same lit-from-above material as Tile3D, but with a softer two-layer shadow,
 * no lip, no press, no focus ring, and a 24px radius against the tile's 16px.
 * That radius gap is the point — a user must be able to tell "I can press
 * this" from "this is telling me something" before touching either.
 *
 * If a card needs to be tappable, it is not a card. Use Tile3D.
 */
export function Card3D({
  tint = 'neutral',
  as: Tag = 'div',
  padding = 'md',
  icon,
  style,
  children,
  className = '',
}: Props) {
  const classes = [
    'clay-card',
    ...clayCardLayoutClasses({ padding, hasIcon: Boolean(icon) }),
    clayTintClass(tint),
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes} style={style}>
      {icon ? <Icon3D name={icon} size="md" float className="clay-card-icon" /> : null}
      {children}
    </Tag>
  );
}
