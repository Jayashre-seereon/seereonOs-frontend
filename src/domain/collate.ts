// Numeric-aware string order ("2.10" after "2.9"). Identical to `a.localeCompare(b, undefined, { numeric: true })`
// (ECMA-402 defines that call as compare() of a new Intl.Collator(undefined, { numeric: true })), but the collator is
// built once instead of on every comparison, which made sorting thousands of WBS codes the slowest part of some lists.
const collator = new Intl.Collator(undefined, { numeric: true })
export const compareNumeric = (a: string, b: string): number => collator.compare(a, b)
