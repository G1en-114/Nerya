/** Omnibox parsing only; the runtime validates the resulting navigation again. */
export function browserAddress(value: string): string {
  const text = value.trim();
  if (!text || text === 'about:blank') return 'about:blank';
  const host = /^(?:localhost|\[[\da-f:]+\]|(?:[\p{L}\d-]+\.)+[\p{L}\d-]+)(?::\d+)?(?:[/?#][^\s]*)?$/iu.test(text);
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(text) && !host;
  if (explicit || host) {
    const url = new URL(explicit ? text : `${/^localhost(?:[:/]|$)|^127\.|^\[::1\]/i.test(text) ? 'http' : 'https'}://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_browser_address');
    return url.href;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
