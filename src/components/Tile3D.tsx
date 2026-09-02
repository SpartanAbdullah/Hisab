import { Link } from 'react-router-dom';
import { Icon3D } from './Icon3D';
import {
  clayBadgeClass,
  clayTileIconClass,
  clayTileLayoutClasses,
  clayTintClass,
  type ClayBadgePlacement,
  type ClayIconPlacement,
  type ClayTileIconSize,
  type ClayTint,
} from '../lib/clay';

interface Props {
  /** Which clay material this tile is made of. See docs/design-system.md §10. */
  tint?: ClayTint;
  /** Name of a 3D asset in public/3d. Unknown/absent names render no icon. */
  icon?: string;
  /**
   * 'corner' (default) — icon on the top inline-end corner, text beside it.
   * 'top' — icon centred over the top edge, text centred beneath. Use 'top'
   * for dense grids: a 4-up row on a 360px phone leaves ~74px per tile, and
   * 'corner' reserves 64px for the icon alone.
   */
  iconPlacement?: ClayIconPlacement;
  /** 'md' (default, 48px) or 'sm' (36px). Pair 'sm' with 'top' on 4-up grids. */
  iconSize?: ClayTileIconSize;
  /**
   * Copy comes in as props — this component never holds a string of its own,
   * so the i18n rule is satisfied at the call site with t('key').
   */
  title: string;
  subtitle?: string;
  /** Small neutral pill (a count, a due date, a status). */
  badge?: React.ReactNode;
  /**
   * 'inline' (default) — pill in the content flow, under the subtitle.
   * 'corner' — count pinned to the top inline-end corner, ringed in the
   * tile's own surface colour so it stays legible over a floating icon.
   */
  badgePlacement?: ClayBadgePlacement;
  /**
   * The app's ONE selection treatment (an inset accent ring), replacing the
   * hand-rolled rings that had started to drift across call sites.
   *
   * Leave it `undefined` for a tile that is not part of a selectable set —
   * the component then emits no aria-pressed/aria-current at all, so an
   * ordinary navigation tile is not announced as a toggle.
   */
  selected?: boolean;
  onClick?: () => void;
  /** Router destination. Ignored when `disabled`. */
  to?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Tier 1 of the clay system: the PRESSABLE tile.
 *
 * A gradient clay surface with a bottom lip, a floating 3D icon hanging off
 * its top inline-end corner, and a 2px press. Renders a real <button> or a
 * router <Link> — never a div with an onClick, so keyboard and screen-reader
 * users get the affordance for free.
 *
 * Layout note for callers: the icon overlaps the tile's top edge by ~35% of
 * its height, so a grid of tiles needs room above the first row —
 * `pt-5` on the container, or `gap-y-6` between rows. Inside a scroll
 * container with `overflow-hidden` the icon will clip.
 */
export function Tile3D({
  tint = 'neutral',
  icon,
  iconPlacement = 'corner',
  iconSize = 'md',
  title,
  subtitle,
  badge,
  badgePlacement = 'inline',
  selected,
  onClick,
  to,
  disabled = false,
  className = '',
}: Props) {
  const classes = [
    'clay-tile',
    clayTintClass(tint),
    ...clayTileLayoutClasses({ hasIcon: Boolean(icon), iconPlacement, iconSize }),
    selected ? 'clay-tile-selected' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const body = (
    <>
      {icon ? (
        <Icon3D
          name={icon}
          size={iconSize}
          // 'top' placement owns its own (deeper) overhang via
          // .clay-tile-icon-top, so the generic float must stay off — two
          // negative block margins on one element would stack.
          float={iconPlacement === 'corner'}
          className={clayTileIconClass(iconPlacement)}
        />
      ) : null}
      <span className="clay-tile-title">{title}</span>
      {subtitle ? <span className="clay-tile-sub">{subtitle}</span> : null}
      {badge ? <span className={clayBadgeClass(badgePlacement)}>{badge}</span> : null}
    </>
  );

  // A disabled destination is still a <button disabled>, never a dead <Link>:
  // an anchor has no disabled state, and stripping its href to fake one leaves
  // it focusable and announced as a link that goes nowhere.
  if (to && !disabled) {
    // aria-pressed is meaningless on a link (a link is not a toggle);
    // aria-current is the correct "this is the active one" for navigation.
    return (
      <Link to={to} className={classes} aria-current={selected ? 'page' : undefined}>
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // `undefined` (not `false`) when the prop is absent, so a plain action
      // tile keeps role=button instead of being announced as an unpressed
      // toggle.
      aria-pressed={selected}
      className={classes}
    >
      {body}
    </button>
  );
}
