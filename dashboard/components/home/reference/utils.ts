export function cn(...values: unknown[]): string {
  return values.flat(Infinity).filter(Boolean).join(" ");
}
