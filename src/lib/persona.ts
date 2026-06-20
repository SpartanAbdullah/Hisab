// Hisaab AI personality dial — Chill / Balanced / Roast.
//
// Personality is OPT-IN and on-device. The FACT is never changed (research:
// never restyle a number into something wrong, and never roast someone in
// distress) — persona only adds a tone wrapper, and `serious` always forces a
// neutral, kind voice regardless of the dial. Pure + tested.

export type Persona = 'chill' | 'balanced' | 'roast';

const KEY = 'hisaab_ai_persona';

export function getPersona(): Persona {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'chill' || v === 'roast') return v;
  } catch {
    /* no localStorage — fall through */
  }
  return 'balanced';
}

export function setPersona(p: Persona): void {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* ignore */
  }
}

const CHILL_CLOSERS = ['No stress. 🌿', 'Easy does it.', 'Steady as you go.', "You've got this."];
const ROAST_CLOSERS = ["Your wallet felt that. 👀", 'Bold. 😏', "We don't judge… much.", 'Noted, big spender.', 'Living the dream, huh.'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Wrap a factual line in the chosen persona's tone. `balanced` (or any
 * `serious` reply) returns the fact untouched — no jokes when money is tight.
 * Deterministic (hashed) so the same fact always reads the same way.
 */
export function flavor(fact: string, persona: Persona, serious = false): string {
  if (persona === 'balanced' || serious || !fact) return fact;
  const bank = persona === 'roast' ? ROAST_CLOSERS : CHILL_CLOSERS;
  return `${fact} ${bank[hash(fact) % bank.length]}`;
}
