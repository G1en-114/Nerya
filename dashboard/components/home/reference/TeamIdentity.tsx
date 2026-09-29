import Image from "next/image";
import Copy from "./components/Copy";

export function TeamIdentity() {
  return <section className="team-identity wrap" aria-label="WayAgent FX · GWDC 2026">
    <div className="team-identity-name"><span>GWDC 2026 · SEOUL</span><h2>WayAgent FX</h2><Copy as="p" zh="参赛战队 · 代表项目 Nerya Agent" en="Hackathon team · Presenting Nerya Agent" /></div>
    <div className="team-identity-organizations"><Copy as="h3" zh="代表组织" en="Representing" /><div className="team-identity-logos">
      <span><Image src="/branding/partners/feixiaohao-mark.svg" alt="" width={48} height={36} /><b>非小号<small>Feixiaohao</small></b></span><i aria-hidden="true">×</i><span><Image src="/branding/partners/waytoweb4-orbit-mark.webp" alt="" width={56} height={35} /><b>WayToWeb4</b></span>
    </div></div>
    <div className="team-identity-communities"><Copy as="h3" zh="合作社区" en="Community partners" /><div className="team-identity-logos"><span><Image src="/branding/partners/tintinland-mark.webp" alt="" width={27} height={27} /><b>TinTinLand</b></span><span className="community-cddjap"><b>CDDJAP</b><Image src="/branding/partners/cddjap-logo.jpg" alt="Draper Dragon" width={112} height={18} /></span></div></div>
  </section>;
}
