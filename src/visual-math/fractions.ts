export function partitionWidth(parts: number): number {
  if (!Number.isInteger(parts) || parts < 1 || parts > 12)
    throw new Error("Parts must be an integer from 1 to 12.");
  return 100 / parts;
}

export function compareFractions(
  a: number,
  b: number,
  c: number,
  d: number,
): -1 | 0 | 1 {
  if (![a, b, c, d].every(Number.isSafeInteger) || b <= 0 || d <= 0)
    throw new Error("Use integer numerators and positive denominators.");
  const difference = BigInt(a) * BigInt(d) - BigInt(c) * BigInt(b);
  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
}
