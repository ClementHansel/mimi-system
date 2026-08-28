/**
 * Moved to `@/lib/money` — the dashboard's Sales and Marketing tabs foot their
 * own money columns too, and a second implementation of "add up these decimal
 * strings" is how two screens start disagreeing about the same day's revenue.
 *
 * Re-exported from here so finance's existing call sites (`JournalPanel`,
 * `ReportsPanel`, `io-columns`) and `money.test.ts` keep working unchanged.
 */
export { sumMoney, moneyEquals, isZeroMoney, moneySharePct } from '@/lib/money';
