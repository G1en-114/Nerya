/** Convert modern RGB CSS tokens to the legacy syntax supported by chart parsers. */
export function chartColor(value: string | undefined, fallback: string): string {
  const color = value?.trim();
  if (!color) return fallback;
  const rgb = color.match(/^rgba?\((.*)\)$/i);
  if (!rgb || rgb[1].includes(',')) return color;
  const [channels, opacity, extra] = rgb[1].split('/').map(part => part.trim());
  const tokens = channels.split(/\s+/);
  if (extra !== undefined || tokens.length !== 3) return fallback;
  const numeric = (token: string, scale: number) => /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(token)
    ? Number.parseFloat(token) * (token.endsWith('%') ? scale / 100 : 1) : NaN;
  const values = tokens.map(token => numeric(token, 255));
  const alpha = opacity === undefined ? 1 : numeric(opacity, 1);
  if (![...values, alpha].every(Number.isFinite)) return fallback;
  const normalized = values.map(channel => Math.round(Math.min(255, Math.max(0, channel)))).join(', ');
  return opacity === undefined ? `rgb(${normalized})` : `rgba(${normalized}, ${Math.min(1, Math.max(0, alpha))})`;
}
