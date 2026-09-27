"use client";

/**
 * Dashboard-level user preferences, persisted in localStorage.
 *
 * This is intentionally decoupled from the backend: these are purely visual
 * choices (which venue to pull candles from, which symbol to pin, what
 * interval to show, refresh cadence) and should survive reloads without
 * hitting the server.
 */

import { useSyncExternalStore } from "react";

export type KlineVenue =
  | "mock"
  | "binance"
  | "bybit"
  | "okx"
  | "hyperliquid";

export type KlineInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type TimezonePreference =
  | "auto"
  | "utc+8"
  | "utc+0"
  | "utc-5"
  | "utc+9"
  | "utc-8";

export type LanguagePreference = "en" | "zh";


export type ThemeMode = "light" | "dark" | "system";

export type UiSettings = {
  kline: {
    venue: KlineVenue;
    symbol: string;   // plain pair, e.g. "BTCUSDT"
    interval: KlineInterval;
    count: number;    // number of candles to show
  };
  refreshSeconds: number; // dashboard auto-refresh cadence
  showVolume: boolean;
  chartType: "candlestick" | "line" | "area";
  timezone: TimezonePreference;
  language: LanguagePreference;
  darkMode: ThemeMode;
};

export const DEFAULT_SETTINGS: UiSettings = {
  kline: {
    venue: "binance",
    symbol: "BTCUSDT",
    interval: "1h",
    count: 96,
  },
  refreshSeconds: 30,
  showVolume: true,
  chartType: "candlestick",
  timezone: "auto",
  language: "en",
  darkMode: "dark",
};

const KEY = "nerya.ui_settings.v1";
const EVT = "nerya:ui_settings_changed";

/** Use the browser only until the operator chooses and saves a language. */
export function detectBrowserLanguage(): LanguagePreference {
  if (typeof navigator === "undefined") return DEFAULT_SETTINGS.language;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return DEFAULT_SETTINGS.language;
}

export function getDefaultSettings(): UiSettings {
  return { ...DEFAULT_SETTINGS, language: detectBrowserLanguage(), kline: { ...DEFAULT_SETTINGS.kline } };
}

let cachedRaw: string | null | undefined;
let cachedSettings: UiSettings = DEFAULT_SETTINGS;

/** Merge helper that tolerates missing keys / extra fields in old blobs. */
function resolveThemeMode(value: unknown): ThemeMode {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "dark" : "light";
  }
  return DEFAULT_SETTINGS.darkMode;
}

export function getSystemDarkPreference(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function isDarkThemeMode(mode: ThemeMode): boolean {
  return mode === "system" ? getSystemDarkPreference() : mode === "dark";
}

function merge(stored: unknown): UiSettings {
  const defaults = getDefaultSettings();
  if (!stored || typeof stored !== "object") return defaults;
  const { compact: _compact, marketStream: _stream, ...s } = stored as Partial<UiSettings> & { compact?: unknown; marketStream?: unknown };
  const darkMode = resolveThemeMode(s.darkMode);
  const language = s.language === "zh" || s.language === "en" ? s.language : defaults.language;
  return {
    ...defaults,
    ...s,
    language,
    darkMode,
    kline: { ...defaults.kline, ...(s.kline ?? {}) },
  };
}

export function loadSettings(): UiSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === cachedRaw) return cachedSettings;
    cachedRaw = raw;
    cachedSettings = raw ? merge(JSON.parse(raw)) : getDefaultSettings();
    return cachedSettings;
  } catch {
    cachedSettings = DEFAULT_SETTINGS;
    return cachedSettings;
  }
}

export function saveSettings(next: UiSettings): void {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.stringify(next);
    cachedRaw = raw;
    cachedSettings = next;
    window.localStorage.setItem(KEY, raw);
    window.dispatchEvent(new CustomEvent(EVT));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

export function patchSettings(patch: Partial<UiSettings>): UiSettings {
  const cur = loadSettings();
  const next: UiSettings = {
    ...cur,
    ...patch,
    kline: { ...cur.kline, ...(patch.kline ?? {}) },
  };
  saveSettings(next);
  return next;
}

/* ---------------------------------------------------------------- React hook */

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener(EVT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVT, handler);
    window.removeEventListener("storage", handler);
  };
}

function getSnapshot(): UiSettings {
  return loadSettings();
}

function getServerSnapshot(): UiSettings {
  return DEFAULT_SETTINGS;
}

export function useUiSettings(): [UiSettings, (p: Partial<UiSettings>) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return [value, patchSettings];
}
