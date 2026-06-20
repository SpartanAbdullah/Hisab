// Sukoon — Hisaab 2.0 redesign tokens.
// Single source of truth for palette / type / components used across the
// canvas. Mounted to window so every later <script type="text/babel"> file
// can read identical values.

const SukoonTokens = {
  // Deep navy hero — the "Wio moment". Used on home top half, onboarding,
  // confirmation moments. Warm violet bloom prevents it feeling clinical.
  navy: {
    900: '#0B0E2A',
    800: '#11142F',
    700: '#171B3D',
    600: '#222654',
    bloom: 'radial-gradient(120% 90% at 80% 10%, rgba(124,92,255,0.32) 0%, rgba(124,92,255,0) 55%), radial-gradient(80% 70% at 10% 100%, rgba(217,97,74,0.18) 0%, rgba(217,97,74,0) 60%)',
  },
  // Warm light body — softer than slate-50, feels like Wio's lower half.
  cream: {
    bg:     '#F4F2EC',
    card:   '#FFFFFF',
    elev:   '#FFFFFF',
    border: '#EAE5D9',
    hairline: '#EFEBE0',
    soft:   '#F8F6F0',
  },
  // Primary accent — calmer than indigo-600, more violet than blue.
  accent: {
    600: '#5B47E8',
    500: '#7C5CFF',
    100: '#EBE6FF',
    50:  '#F3F0FF',
  },
  // Money semantics — green is forest (calm), red is coral (warm, not alarmed).
  receive: {
    700: '#076B53',
    600: '#0F9D7B',
    50:  '#E6F4EE',
    chip: '#DEF1E7',
    text: '#0F8466',
  },
  pay: {
    700: '#B4452C',
    600: '#D9614A',
    50:  '#FBEDE7',
    chip: '#F7DDD2',
    text: '#C45339',
  },
  // Ink scale — true neutral; no slate-bluish cast.
  ink: {
    900: '#0E102B',
    800: '#23253F',
    600: '#5A5C72',
    500: '#7E809A',
    400: '#A8AABD',
    300: '#C9CAD8',
    200: '#E6E6EF',
  },
  // Functional
  warn: { 600: '#C28E1A', 50: '#FBF3DD' },
  info: { 600: '#3F6BD9', 50: '#E8EEFB' },
  fontDisplay: '"Geist", "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  fontBody:    '"Geist", "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  fontNumeric: '"Geist", "Inter", -apple-system, system-ui, sans-serif',
};

// Currency meta — flag glyphs, exchange.
const SukoonCurrencies = {
  AED: { code: 'AED', flag: '🇦🇪', symbol: 'AED', name: 'UAE Dirham' },
  PKR: { code: 'PKR', flag: '🇵🇰', symbol: 'PKR', name: 'Pakistani Rupee' },
  USD: { code: 'USD', flag: '🇺🇸', symbol: '$',   name: 'US Dollar'    },
  EUR: { code: 'EUR', flag: '🇪🇺', symbol: '€',   name: 'Euro'         },
};

function fmtMoney(n, cur='AED', { showCode = true, signed = false } = {}) {
  const sign = signed && n > 0 ? '+' : '';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const out = `${sign}${n < 0 ? '−' : ''}${s}`;
  return showCode ? `${out} ${cur}` : out;
}

// Initials avatar with a colour deterministically chosen from the name. Tuned
// palette — warm earthy tones rather than rainbow chips, so the "people"
// page does not look like a casino.
const SukoonAvatarColors = [
  ['#F3E9D8', '#9B7E4F'], // sand
  ['#E2EDE3', '#3F7F5C'], // sage
  ['#E5E1F0', '#5B47E8'], // lilac
  ['#F5DED4', '#B4452C'], // coral
  ['#DCE4F1', '#3F6BD9'], // sky
  ['#EBE3D4', '#7D5C29'], // ochre
  ['#E1E8E6', '#4A6D69'], // pine
  ['#F1DEDE', '#9E3F4F'], // rose
];
function pickAvatarColor(name) {
  const i = (name || '?').split('').reduce((a,c)=>a+c.charCodeAt(0),0) % SukoonAvatarColors.length;
  return SukoonAvatarColors[i];
}

window.SukoonTokens = SukoonTokens;
window.SukoonCurrencies = SukoonCurrencies;
window.fmtMoney = fmtMoney;
window.pickAvatarColor = pickAvatarColor;
