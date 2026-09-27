import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { notFound } from "next/navigation";
import { ResearchLivePreview } from "../../../tests/ui/ResearchLivePreview";

export const dynamic = "force-dynamic";
/** Opt-in development viewer. Only public source observations, no synthetic conversation. */
export default async function Page() {
  if (process.env.NODE_ENV !== "development" || process.env.NERYA_RESEARCH_LIVE_REVIEW !== "1") notFound();
  let data;
  try { data = JSON.parse(await readFile(resolve(process.cwd(), "../test-results/research-live/published.json"), "utf8")); }
  catch { return <p className="p-8">尚未获取真实行情，不能显示验收图表。</p>; }
  return <ResearchLivePreview publication={data} />;
}
