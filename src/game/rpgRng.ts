/**
 * Server-side dice for tabletop checks. Board movement still uses crypto
 * in server.ts; combat/quest checks go through this module so tests can
 * inject a sequence without touching Math.random.
 */

export type DiceFn = (sides: number) => number;

/** Inclusive 1..sides. */
export function cryptoDice(sides: number): number {
  const n = Math.max(2, Math.floor(sides));
  return crypto.randomInt(1, n + 1);
}

/** Fixed D20. */
export function d20(roll: DiceFn = cryptoDice): number {
  return roll(20);
}

export function sequenceDice(values: number[]): DiceFn {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
}
