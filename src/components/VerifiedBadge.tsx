// Verified-style seal: a blue rosette with a white check — the universally
// understood "confirmed / settled / linked" mark. Deliberately NOT a pixel
// copy of Meta's verified badge (that exact scalloped asset is their brand
// property); this uses the generic seal-check geometry from our icon set,
// filled in verified blue, which reads identically at a glance.
//
// Usage semantics across the app (keep these consistent):
//   - Contacts: the person is LINKED to a real Hisaab account
//   - Loans: the loan (or a person's whole ledger) is fully SETTLED
//   - Groups: on the group DETAIL page, every debt in the group is settled;
//     on the groups LIST card, the CURRENT USER is square (whole-group debt
//     data isn't loaded there — same scope as the card's "Settled" pill)
import { BadgeCheck } from 'lucide-react';

interface Props {
  size?: number;
  className?: string;
  /** Accessible label; defaults to "verified". */
  title?: string;
}

export function VerifiedBadge({ size = 14, className = '', title }: Props) {
  return (
    <span
      className={`inline-flex items-center shrink-0 ${className}`}
      title={title}
      aria-label={title ?? 'verified'}
    >
      <BadgeCheck
        size={size}
        className="fill-[#0866FF] stroke-white"
        strokeWidth={2.2}
        aria-hidden
      />
    </span>
  );
}
