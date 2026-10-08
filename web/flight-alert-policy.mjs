// Pure policy: prices and threshold in whole units. Doesn't use the model's
// text, generic averages, or multiply price by passenger count to fabricate a
// reference.
export function flightPriceCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e8) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents > 0 && Math.abs(value * 100 - cents) < 1e-5 ? cents : null;
}
export function percentageDrop(currentCents, referenceCents, dropBps) {
  if (![currentCents, referenceCents].every(v => Number.isSafeInteger(v) && v > 0 && v <= 1e10)
      || !Number.isInteger(dropBps) || dropBps <= 0 || dropBps >= 10000) throw Error('Comparação de preço inválida.');
  const difference = referenceCents - currentCents;
  // BigInt avoids overflow in the product and the comparison does NOT round
  // the percentage.
  const triggered = BigInt(difference) * 10000n > BigInt(referenceCents) * BigInt(dropBps);
  const percent = difference * 100 / referenceCents;
  return { triggered, differenceCents: difference, percent };
}
