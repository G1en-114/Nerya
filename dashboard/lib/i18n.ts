import { en, zh } from "../messages";

type Values = Record<string, unknown> | undefined;
type Messages = Record<string, unknown>;

/** Translates a key from the selected JSON resource bundle. */
export type ResourceTranslator = {
  (key: string, values?: Record<string, unknown>): string;
};

function getCopy(messages: Messages, key: string): string | undefined {
  const parts = key.split(".");
  if (parts.shift() !== "copy") return undefined;
  let value: unknown = messages.copy;
  for (const part of parts) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  return typeof value === "string" ? value : undefined;
}

function interpolate(template: string, values: Values): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ""));
}

/** Resolve component-local copy that was moved to the locale JSON resources. */
export function copy(isChinese: boolean, key: string, values?: Values): string {
  return interpolate(getCopy(isChinese ? zh : en, key) ?? key, values);
}
