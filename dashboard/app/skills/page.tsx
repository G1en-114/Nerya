"use client";

import { useTranslations } from "next-intl";
import { PageBody, PageHeader } from "../../components/Page";
import { SectionTabs } from "../../components/SectionTabs";
import SkillManagementPanel from "../../components/settings/SkillManagementPanel";

export default function SkillsPage() {
  const t = useTranslations("skills");
  return <PageBody><PageHeader title={t("title")} /><SectionTabs section="runtime" /><SkillManagementPanel /></PageBody>;
}
