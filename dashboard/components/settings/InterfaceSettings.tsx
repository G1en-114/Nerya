"use client";

import { useTranslations } from "next-intl";
import { getDefaultSettings, useUiSettings, type UiSettings, type ThemeMode, type LanguagePreference } from "../../lib/settings";
import { confirm } from "../../lib/dialogs";
import { SettingsIcon } from "../icons";
import { Row, SettingsGroup, CompactSelect as Select } from "./SettingsFields";

/** Browser preferences are independent of provider, vault and runtime forms. */
export function InterfaceSettings() {
  const [settings, patch] = useUiSettings();
  const appearance = useTranslations("settings.appearance");
  const display = useTranslations("settings.displayCard");
  const chart = useTranslations("settings.chartCard");
  const tabs = useTranslations("settings.tabs");
  const common = useTranslations("common");
  const ui = useTranslations("ui");
  async function reset() {
    if (await confirm({ title: ui("resetPreferences"), message: ui("resetPreferencesDescription") })) patch({ darkMode: getDefaultSettings().darkMode, language: getDefaultSettings().language, timezone: getDefaultSettings().timezone });
  }
  return (
    <div id="settings-panel-interface" role="region" aria-label={tabs("interface")} className="space-y-7">
      <SettingsGroup title={appearance("title")} description={appearance("description")}>
        <Row label={appearance("theme")} desc={appearance("themeDesc")}>
          <Select value={settings.darkMode} onChange={(value) => patch({ darkMode: value as ThemeMode })} options={[
            { value: "system", label: appearance("themeSystem") }, { value: "light", label: appearance("themeLight") }, { value: "dark", label: appearance("themeDark") },
          ]} />
        </Row>
        <Row label={appearance("language")} desc={appearance("languageDesc")}>
          <Select value={settings.language === "zh" ? "zh" : "en"} onChange={(value) => patch({ language: value as LanguagePreference })} options={[{ value: "en", label: appearance("languageEnglish") }, { value: "zh", label: appearance("languageChinese") }]} />
        </Row>
      </SettingsGroup>
      <SettingsGroup title={display("title")} description={display("description")}>
        <Row label={display("timezone")} desc={display("timezoneDesc")}>
          <Select value={settings.timezone} onChange={(value) => patch({ timezone: value as UiSettings["timezone"] })} options={[
            { value: "auto", label: "Auto" }, { value: "utc+0", label: "UTC+0" }, { value: "utc+8", label: "UTC+8 Shanghai" },
            { value: "utc+9", label: "UTC+9 Tokyo" }, { value: "utc-5", label: "UTC-5 New York" }, { value: "utc-8", label: "UTC-8 Los Angeles" },
          ]} />
        </Row>
        <Row label={chart("resetSettings")} desc={chart("resetSettingsDesc")}>
          <button type="button" className="btn btn-ghost" onClick={() => void reset()}><SettingsIcon size={14} />{common("reset")}</button>
        </Row>
      </SettingsGroup>
    </div>
  );
}
