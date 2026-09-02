// Who has actually EARNED the verified seal.
//
// Audit 2026-09 (SEC-09 / H10). The blue seal used to render for two things
// that prove nothing:
//
//   1. Any contact with a `linked_profile_id`. That column is written by the
//      linking user's own client — it records "I say this contact is that
//      account", never "that account agreed".
//   2. Every phone-discovery hit. A phone number is claimed with a plain
//      profile UPDATE — no OTP, no ownership check anywhere in the stack. So
//      anyone can claim a money-changer's number, wait for their customers'
//      contacts to run discovery, and appear as that shop with a verified
//      seal beside a display name they chose themselves.
//
// The one signal in the system that REQUIRES the other party to act is an
// accepted `contact_link_requests` row: `respond_contact_link` only accepts
// when `to_user_id = auth.uid()`, and `notify_contact_linked` only writes
// 'accepted' when a `persons` row OWNED BY THE TARGET already points back at
// the caller. Neither can be produced from the claimant's side. So the seal
// means exactly one thing: an accepted link between these two accounts.
//
// Fails closed on purpose. Requests not loaded yet, a still-pending ask, or a
// legacy link predating the consent flow all render WITHOUT the seal — the
// surrounding UI already says "waiting for them to add you back". A missing
// badge costs a little reassurance; a false one is a fraud primitive in an
// app whose whole product is trust in informal debt records.

/** Structural shape of a `contact_link_requests` row.
 *  `ContactLinkRequest` from supabaseDb is assignable to this — declared
 *  locally so this module stays import-free and unit-testable in Node. */
export interface ConsentLinkRow {
  fromUserId: string;
  toUserId: string;
  status: 'pending' | 'accepted' | 'declined';
}

/**
 * True only when `theirProfileId` and I hold a mutually accepted contact link
 * (in either direction). This is THE predicate for rendering VerifiedBadge on
 * anything identity-related; never use `linkedProfileId` on its own.
 */
export function isConsentVerifiedLink(
  links: readonly ConsentLinkRow[] | null | undefined,
  myProfileId: string | null | undefined,
  theirProfileId: string | null | undefined,
): boolean {
  if (!links || !myProfileId || !theirProfileId) return false;
  // Self-links are meaningless and must never be decorated as verified.
  if (myProfileId === theirProfileId) return false;
  return links.some(
    (link) =>
      link.status === 'accepted' &&
      ((link.fromUserId === myProfileId && link.toUserId === theirProfileId) ||
        (link.fromUserId === theirProfileId && link.toUserId === myProfileId)),
  );
}
