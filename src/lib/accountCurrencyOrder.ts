// Currency-aware ordering for account pickers. When a flow already knows the
// money's currency (repaying an AED loan, settling an AED card), accounts in
// that currency are what the user almost always wants — mismatched accounts
// force a conversion-rate step. Matching accounts float to the front (stable
// within each side, so caller ordering survives); the type-grouping done later
// by groupAccountsByType preserves this order inside each bucket. Pure +
// tested; rendering (mismatch badges etc.) stays in the components.

interface CurrencyOrderable {
  currency: string;
}

export function orderAccountsForCurrency<A extends CurrencyOrderable>(
  accounts: A[],
  currency: string | null | undefined,
): A[] {
  if (!currency) return accounts;
  const matching: A[] = [];
  const others: A[] = [];
  for (const account of accounts) {
    (account.currency === currency ? matching : others).push(account);
  }
  return [...matching, ...others];
}
