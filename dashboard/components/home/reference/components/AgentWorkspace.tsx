/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Copy from "./Copy";
import Icon from "./Icon";
import { useLanding } from "../context";

const tabs = [["/", "开始探索", "Explore"], ["/chat/demo-strategy", "创建策略", "Create a strategy"], ["/chat/demo-research", "团队投研", "Team research"], ["/chat/demo-review", "复盘与改进", "Review a run"]];

export default function AgentWorkspace() {
  const { language, dark } = useLanding();
  const frame = useRef<HTMLIFrameElement>(null);
  const [route, setRoute] = useState("/");
  const sync = () => frame.current?.contentWindow?.postMessage({ type: "nerya-demo", lang: language, theme: dark ? "dark" : "light", route }, window.location.origin);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: "nerya-demo", lang: language, theme: dark ? "dark" : "light", route }, window.location.origin); }, [language, dark, route]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "nerya-demo-route" && tabs.some(tab => tab[0] === event.data.route)) setRoute(event.data.route);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return <section className="workspace-section wide" id="workspace" aria-label={language === "zh" ? "工作台交互演示" : "Interactive workspace demo"}>
    <div className="workspace-stage"><div className="workspace-shell">
      <div className="workspace-chrome"><span className="window-dots" aria-hidden="true"><i /><i /><i /></span><span>Nerya Agent <span className="chrome-divider">/</span><Copy zh="工作空间" en="workspace" /></span><a className="expand-workspace" href={`/demo/index.html?lang=${language}&theme=${dark ? "dark" : "light"}#${route}`} target="_blank" rel="noopener noreferrer"><Copy zh="展开演示" en="Expand demo" /><Icon name="arrowUpRight" size={15} /></a></div>
      <iframe ref={frame} id="agent-frame" title="Nerya Agent 工作台演示 / Workspace demo" src="/demo/index.html?lang=zh&theme=light" onLoad={sync} sandbox="allow-scripts allow-same-origin allow-downloads" referrerPolicy="no-referrer" />
    </div></div>
    <div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label={language === "zh" ? "演示场景" : "Demo scenarios"} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.findIndex(tab => tab[0] === route);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setRoute(tabs[next][0]); (event.currentTarget.children[next] as HTMLElement).focus();
    }}>{tabs.map(([value, zh, en]) => <button type="button" key={value} role="tab" aria-selected={route === value} tabIndex={route === value ? 0 : -1} aria-controls="agent-frame" onClick={() => setRoute(value)}><Copy zh={zh} en={en} /></button>)}</div><span className="workspace-label"><i /> Nerya Agent</span></div>
    <div className="workspace-caption"><Copy as="p" zh="交互演示 · 使用示例数据，不连接真实账户" en="Interactive demo · Sample data, no live account connection" /><Link href="/chat"><Copy zh="进入实际工作台" en="Open your workspace" /><Icon name="arrowUpRight" size={16} /></Link></div>
  </section>;
}
