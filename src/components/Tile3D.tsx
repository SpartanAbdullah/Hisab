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
  type ClayTileLabel,
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
  /**
   * 'sm' (36px) | 'md' (default, 48px) | 'lg' (64px).
   *
   * 'lg' + 'top' is the home-grid shape: on a 4-up grid at 360px the tile is
   * ~74px wide, so a 64px icon is 86% of it and hangs 26px above its top
   * edge. That disproportion is deliberate — the founder asked for the icons
   * to be the obvious thing on the grid, so the art is the bold element and
   * the label is a caption.
   */
  iconSize?: ClayTileIconSize;
  /**
   * Copy comes in as props — this component never holds a string of its own,
   * so the i18n rule is satisfied at the call site with t('key').
   */
  title: string;
  /**
   * 'below' (default) — the title renders as an 11px caption under the art
   * (stacked placement) or beside it (corner).
   * 'hidden' — stacked placement only: the title renders as a visually-hidden
   * span, so it is still the tile's accessible name, and the art carries the
   * tile on its own. Never omit `title` to get this shape; an icon-only
   * button with no accessible name is unusable with a screen reader.
   *
   * `subtitle` is dropped under 'hidden' — a hidden title above visible
   * secondary copy is incoherent, so the component refuses to render it
   * rather than leaving that decision at the call site. A `badge` still
   * renders; pair it with badgePlacement="corner", which is the only
   * placement that makes sense with no text under the art.
   */
  label?: ClayTileLabel;
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
 * A faintly luminous tinted surface — hairline inside the radius, soft
 * large-radius ambient shadow, no drawn edge of any kind — with a floating
 * 3D icon hanging over it, and a scale press. Renders a real <button> or a
 * router <Link> — never a div with an onClick, so keyboard and screen-reader
 * users get the affordance for free.
 *
 * Layout note for callers: the icon overlaps the tile's top edge by 35%
 * (corner) or 40% (top) of its height — 26px for an `lg` icon — so a grid of
 * tiles needs room above the first row: `pt-6` on the container, or `gap-y-7`
 * between rows. Inside a scroll container with `overflow-hidden` it clips.
 */
export function Tile3D({
  tint = 'neutral',
  icon,
  iconPlacement = 'corner',
  iconSize = 'md',
  title,
  label = 'below',
  subtitle,
  badge,
  badgePlacement = 'inline',
  selected,
  onClick,
  to,
  disabled = false,
  className = '',
}: Props) {
  // Hiding the label is a property of the stacked shape only; a corner tile
  // with no visible text is an empty box with an icon bolted to one side.
  const titleHidden = label === 'hidden' && iconPlacement === 'top' && Boolean(icon);

  const classes = [
    'clay-tile',
    clayTintClass(tint),
    ...clayTileLayoutClasses({
      hasIcon: Boolean(icon),
      iconPlacement,
      iconSize,
      label: titleHidden ? 'hidden' : 'below',
    }),
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
      {/* `sr-only`, never `aria-label` on the element: the title stays a real
          text node, so it is what the accessible name is computed from with
          no duplication, and it still gets picked up by find-in-page and by
          translation tooling. */}
      <span className={titleHidden ? 'sr-only' : 'clay-tile-title'}>{title}</span>
      {subtitle && !titleHidden ? <span className="clay-tile-sub">{subtitle}</span> : null}
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
