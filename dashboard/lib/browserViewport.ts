export type BrowserViewport = { width: number; height: number };
export type BrowserViewportMode = 'fill' | 'desktop' | 'laptop' | 'tablet' | 'phone' | 'custom';
export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { width: 1280, height: 800 };
export const BROWSER_VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
} satisfies Record<string, BrowserViewport>;

export function validBrowserViewport(size: BrowserViewport): boolean {
  return Number.isInteger(size.width) && Number.isInteger(size.height)
    && size.width >= 240 && size.height >= 180 && size.width <= 3840 && size.height <= 3840;
}

export function boundedBrowserViewport(size: BrowserViewport): BrowserViewport {
  return {
    width: Math.max(240, Math.min(3840, Math.floor(size.width) || 1280)),
    height: Math.max(180, Math.min(3840, Math.floor(size.height) || 800)),
  };
}

/** Fit the actual frame, not its parent. Letterboxing never receives input. */
export function fitBrowserViewport(size: BrowserViewport, available: BrowserViewport): BrowserViewport {
  const scale = Math.min(available.width / size.width, available.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

export function browserViewportPoint(x: number, y: number,
  rect: { left: number; top: number; width: number; height: number }, size: BrowserViewport) {
  if (rect.width <= 0 || rect.height <= 0 || !Number.isFinite(x) || !Number.isFinite(y)
      || x < rect.left || y < rect.top || x >= rect.left + rect.width || y >= rect.top + rect.height) return null;
  return { x: Math.min(size.width - 1, (x - rect.left) / rect.width * size.width),
    y: Math.min(size.height - 1, (y - rect.top) / rect.height * size.height) };
}
