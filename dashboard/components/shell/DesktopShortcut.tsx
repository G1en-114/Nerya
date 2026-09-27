"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { isDesktop } from "../../lib/desktop";
import { SettingsIcon } from "../icons";

export function DesktopShortcut() {
  const [native, setNative] = useState(false);
  const t = useTranslations("desktop");
  useEffect(() => { setNative(isDesktop()); }, []);
  if (!native) return null;
  return <Link href="/desktop" aria-label={t("title")} title={t("title")} className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ink-400 hover:bg-ink-800 hover:text-ink-100">
    <SettingsIcon size={16} /><span className="hidden sm:inline">{t("title")}</span>
  </Link>;
}
