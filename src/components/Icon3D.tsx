import { CLAY_ICONS } from '../lib/clayIcons.generated';
import {
  clayIconClass,
  clayIconPx,
  clayIconSrc,
  clayIconSrcSet,
  normalizeClayIconRegistry,
  resolveClayIcon,
  type ClaySize,
} from '../lib/clay';

// Normalised once at module scope, not per render. The registry is a build-time
// constant; `normalizeClayIconRegistry` tolerates whatever shape the asset
// generator emits (see its doc comment).
const REGISTRY = normalizeClayIconRegistry(CLAY_ICONS);

interface Props {
  /** Asset name, matching public/3d/<name>.webp. Unknown names render nothing. */
  name: string;
  size?: ClaySize;
  /** Pull the icon up so it overlaps its container's top edge by ~35%. */
  float?: boolean;
  className?: string;
}

/**
 * A rendered 3D icon.
 *
 * Purely decorative by construction: `alt=""` + `aria-hidden`, because the
 * meaning always lives in the adjacent label (Tile3D's `title`). An icon that
 * carried meaning on its own would need a real alt string, which would need an
 * i18n key — if you find yourself wanting that, the label is missing, not the
 * alt text.
 *
 * If the name is not in the generated registry this renders NOTHING. That is
 * deliberate: the asset pipeline runs as a separate workstream, so a tile can
 * legitimately name an icon that has not been produced yet, and the tile must
 * degrade to a plain clay tile rather than to a broken-image glyph.
 */
export function Icon3D({ name, size = 'md', float = false, className = '' }: Props) {
  const resolved = resolveClayIcon(name, REGISTRY);
  if (!resolved) return null;

  // width/height are the intrinsic box in CSS px. They match the
  // .clay-icon-{size} rules exactly and are what reserves layout space before
  // the asset arrives, so a slow icon never shifts the tile's text.
  const px = clayIconPx(size);

  return (
    <img
      src={clayIconSrc(resolved)}
      srcSet={clayIconSrcSet(resolved)}
      width={px}
      height={px}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      className={`${clayIconClass(size, float)} ${className}`.trim()}
    />
  );
}
