// WhatsApp deep links for payment reminders.
//
// The whole point of this helper is that the recipient does NOT need to be a
// Hisaab user. Most real-world IOUs are with people who will never install the
// app — the shopkeeper, a cousin, a flatmate. WhatsApp is the region's dominant
// channel, so a one-tap "remind on WhatsApp" with a pre-filled message closes
// the biggest gap our competitive benchmark surfaced (every khata app wins on
// free reminders to non-app contacts; we previously only reminded linked users).
//
// Two link shapes:
//   - Known number   -> https://wa.me/<intl-number>?text=...  (opens that chat)
//   - Unknown number  -> https://wa.me/?text=...              (WhatsApp contact picker)
//
// We never invent a country code. A number we can't trust is treated as
// "unknown" so the user lands on the picker instead of a broken chat link.

// Strip a stored phone down to the bare international digits wa.me expects:
// no '+', spaces, dashes or parentheses. Returns null when there's nothing
// usable so callers fall back to the contact picker.
export function normalizeWhatsAppPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  // Shorter than 7 digits can't be a real international number — don't risk a
  // dead link; let the caller fall through to the picker.
  if (digits.length < 7) return null;
  return digits;
}

export function hasWhatsAppNumber(phone: string | null | undefined): boolean {
  return normalizeWhatsAppPhone(phone) !== null;
}

// Build the wa.me URL. `text` is the human-readable reminder body; it is URL
// encoded here so callers pass plain multi-line text.
export function buildWhatsAppUrl(phone: string | null | undefined, text: string): string {
  const number = normalizeWhatsAppPhone(phone);
  const encoded = encodeURIComponent(text);
  return number ? `https://wa.me/${number}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}
