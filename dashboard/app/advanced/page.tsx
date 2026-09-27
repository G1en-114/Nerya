"use client";
import { copy as i18nCopy } from "../../lib/i18n";

// Developer diagnostics. Legacy settings links redirect here.

import { useLocale, useTranslations } from "next-intl";
import { PageBody, PageHeader } from "../../components/Page";
import { RuntimeFlagsPanel } from "../../components/RuntimeFlagsPanel";

export default function AdvancedPage() {
  const zh = useLocale().startsWith("zh");
  const t = useTranslations("advancedPage");
  return (
    <PageBody>
      <PageHeader
        eyebrow={t("eyebrow")}
        title={i18nCopy(zh, "copy.app_advanced_page.001")}
        description={i18nCopy(zh, "copy.app_advanced_page.002")}
      />
      <RuntimeFlagsPanel />
    </PageBody>
  );
}
