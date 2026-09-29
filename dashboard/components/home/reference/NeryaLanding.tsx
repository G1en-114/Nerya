"use client";
/* Adapted from the companion NeryaAI website. */
/* eslint-disable @next/next/no-img-element */
import React, {useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {LandingContext} from './context';
import {TeamIdentity} from './TeamIdentity';
import './site.css';
import './adaptations.css';
import {cn} from './utils';

import Copy from './components/Copy';
import Icon from './components/Icon';
import ProductStory from './components/ProductStory';
import AgentWorkspace from './components/AgentWorkspace';
import ResultShowcase from './components/ResultShowcase';
import { ContainerScroll } from './ui/container-scroll-animation';
import { BackgroundPaths } from './ui/background-paths';
function WorkspaceButton({compact=false}:{compact?:boolean}) { return <Link className={`button github-cta ${compact?'github-cta-small':''}`} href="/chat"><Copy zh={compact?'进入工作台':'开始使用 Nerya Agent'} en={compact?'Open workspace':'Get started with Nerya Agent'} /><Icon name="arrowUpRight" size={17}/></Link>; }

import { features } from './data/product';

const markets = [
  { id:'crypto', zh:'加密货币', en:'Crypto', symbol:'BTC / USDT', icon:'bitcoin', note:['趋势、动量与组合策略','Trend, momentum and portfolio strategies'], route:'/strategies?strategy_id=btc_trend_guard' },
  { id:'prediction', zh:'预测市场', en:'Prediction markets', symbol:'EVENT / PROBABILITY', icon:'prediction', note:['事件证据与概率判断','Event evidence and probability research'], route:'/strategies?strategy_id=event_probability' },
  { id:'futures', zh:'期货', en:'Futures', symbol:'CONTRACT / TERM', icon:'candles', note:['期限结构、换月与 CTA','Term structure, rolls and CTA strategies'], route:'/strategies?strategy_id=futures_term_structure' },
  { id:'equities', zh:'A 股', en:'A-shares', symbol:'FACTORS / ROTATION', icon:'building', note:['因子研究与组合轮动','Factor research and portfolio rotation'], route:'/strategies?strategy_id=ashare_factor_rotation' },
];
// Additional scenes share the same story controls as the core features.
const marketFilm = {
  id: 'markets',
  title: { zh: '按市场选择研究方向', en: 'Research with each market in view' },
  steps: [
    { zh: '选择市场', en: 'Choose a market' },
    { zh: '查看策略', en: 'Inspect a strategy' },
    { zh: '检查规则', en: 'Check the rules' },
  ],
};
const integrationFilm = {
  id: 'integrations',
  title: { zh: '把接入需求交给 Agent', en: 'Build a connector with your Agent' },
  steps: [
    { zh: '提出需求', en: 'Describe the API' },
    { zh: '准备适配', en: 'Draft the adapter' },
    { zh: '验证接入', en: 'Review validation' },
  ],
};

export default function NeryaLanding(){
const router=useRouter();
const [language,setLanguage]=useState<'zh'|'en'>('zh');
const [dark,setDark]=useState(false);
const [paused,setPaused]=useState(false);
const [menu,setMenu]=useState(false);
const [market,setMarket]=useState('crypto');
const selectedMarket=markets.find(item=>item.id===market)!;
return <LandingContext.Provider value={{language,dark,paused}}><div className={`nerya-landing ${paused?'motion-paused':''}`} data-theme={dark?'dark':'light'} lang={language} onClick={event=>{
  if(!(event.target instanceof Element))return;
  const button=event.target.closest<HTMLElement>('[data-open-agent]');
  if(button){const route=button.dataset.openAgent||'/chat';router.push(route.startsWith('/chat')?'/chat':route.split('?')[0]);}
  if(event.target.closest('nav a'))setMenu(false);
}}>

    <a className="skip-link" href="#main"><Copy zh="跳到内容" en="Skip to content" /></a>
    <header className="site-header">
      <a className="brand" href="#top" aria-label="Nerya Agent"><img src="/landing/assets/nerya-logo.webp" width="32" height="32" alt="" /><span>Nerya <small>Agent</small></span></a>
      <nav className={menu?"open":""} id="navigation" aria-label="主导航 / Navigation"><a href="#workspace"><Copy zh="工作台" en="Workspace" /></a><a href="#strategy"><Copy zh="能力" en="Capabilities" /></a><a href="https://github.com/NeryaAI/Nerya#readme" target="_blank" rel="noopener noreferrer"><Copy zh="文档" en="Docs" /></a></nav>
      <div className="header-actions"><button type="button" className="icon-button" onClick={()=>setDark(value=>!value)} aria-label={language==='zh'?'切换明暗主题':'Toggle color theme'}><Icon name={dark?'sun':'moon'} size={19}/></button><button id="language" type="button" className="language-button" onClick={()=>setLanguage(value=>value==='zh'?'en':'zh')} aria-label={language==='zh'?'Switch to English':'切换至简体中文'}>{language==='zh'?'EN':'中文'}</button><WorkspaceButton compact /><button id="menu-toggle" type="button" className="menu-toggle icon-button" onClick={()=>setMenu(value=>!value)} aria-controls="navigation" aria-expanded={menu} aria-label="菜单 / Menu"><Icon name={menu?"x":"menu"} /></button></div>
    </header>
    <main id="main">
      <section className="hero" id="top">
        <BackgroundPaths />
        <ContainerScroll titleComponent={<><div className="hero-layout wrap"><div className="hero-copy">
        <p className="hero-intro"><Copy zh="Nerya Agent · 你的 Agent 策略工作区" en="Nerya Agent · Your Agent strategy workspace" /></p>
        <h1><Copy zh="一句想法" en="One idea" /><br /><Copy className="hero-accent" zh="一支策略团队" en="A team to build it" /></h1>
        <Copy className="hero-description" as="p" zh="你提出交易逻辑，Agent 分工研究、编写策略。查看运行记录，再决定下一次改动。" en="Describe your trading idea. Agents research it and write the strategy. Review the runs and decide what to change next." />
        <div className="hero-actions"><WorkspaceButton /><a className="workspace-try" href="#workspace"><Copy zh="体验工作台" en="Explore the workspace" /><Icon name="arrowUpRight" size={17} /></a></div>
        <div className="hero-team"><span className="avatar-stack" aria-hidden="true">{['lead','researcher','reviewer','coder'].map(role=><img key={role} src={`/landing/assets/agent-avatars/${role}.png`} alt="" width="26" height="26" />)}</span><Copy zh="研究员 · 策略作者 · 审阅员" en="Researchers · Authors · Reviewers" /></div>
        </div></div><TeamIdentity /></>}>

        <AgentWorkspace />
        </ContainerScroll>
        <div className="scroll-invitation" aria-hidden="true"><span/><Copy zh="向下探索" en="Scroll to explore" /></div>
      </section>

      <div className="story-intro wrap"><span className="story-eyebrow">IDEA → RESEARCH → STRATEGY</span><Copy as="h2" zh="从一个想法 到每一步都有据可查" en="From an idea to a traceable workflow" /><Copy as="p" zh="让想法连成工作流，让研究留下证据，让每次改动都可审阅" en="Connect the steps. Keep the evidence. Review every change." /><button id="motion-toggle" type="button" className="motion-button" onClick={()=>setPaused(value=>!value)} aria-pressed={paused}><Icon name={paused?"play":"pause"} size={15} /><Copy zh={paused?"播放动效":"暂停动效"} en={paused?"Play motion":"Pause motion"} /></button></div>

      <div className="feature-stories" data-tracing-story><div className="story-trace" aria-hidden="true"><i/><span/></div>
        {features.map((feature, i) => <section key={feature.id} className={cn(['feature-section', `feature-${feature.id}`, i % 2 === 1 && 'reverse'])} id={feature.id} aria-labelledby={`${feature.id}-title`}>
          <div className="feature-inner wrap">
            <div className="feature-copy">
              <Copy as="h2" id={`${feature.id}-title`} zh={feature.title.zh} en={feature.title.en} />
              <Copy as="p" zh={feature.description.zh} en={feature.description.en} />
              <button className="feature-link" data-open-agent={feature.route}><Copy zh={feature.cta.zh} en={feature.cta.en} /><Icon name="arrowUpRight" size={17} /></button>
              {feature.id === 'team' && <div className="team-signatures" aria-label="Agent 团队成员 / Team members">{[['researcher','研究员','Researcher'],['reviewer','审阅员','Reviewer'],['coder','策略作者','Author']].map(([role,zh,en])=><span key={role}><img src={`/landing/assets/agent-avatars/${role}.png`} width="34" height="34" alt="" /><Copy zh={zh} en={en} /></span>)}</div>}
              {feature.id === 'vault' && <a className="detail-link" href="https://github.com/NeryaAI/Nerya#readme" target="_blank" rel="noopener noreferrer"><Copy zh="阅读安全机制" en="Read the security model" /><Icon name="arrowUpRight" size={14} /></a>}
            </div>
            <ProductStory feature={feature} />
          </div>
        </section>)}
      </div>

      <section className="outputs-section wrap" aria-labelledby="outputs-title">
        <div className="outputs-copy"><span className="story-eyebrow">THE OUTPUT / YOUR WORKSPACE</span><Copy as="h2" id="outputs-title" zh="结果不止一段文字" en="More than a written reply" /><Copy as="p" zh="策略工作流、回测曲线、行情卡片和完整投研报告。点开看细节，回到同一条对话继续研究。" en="Strategy workflows, backtest curves, market cards and full research briefs. Inspect the details, then continue in the same conversation." /><a className="feature-link" href="https://github.com/NeryaAI/Nerya#readme" target="_blank" rel="noopener noreferrer"><Copy zh="探索 Agent SDK 与产物契约" en="Explore the Agent SDK & artifacts" /><Icon name="arrowUpRight" size={17}/></a></div>
        <ResultShowcase />
      </section>

      <section className="feature-section markets-section" id="markets" aria-labelledby="markets-title">
        <div className="feature-inner wrap">
          <div className="feature-copy">
            <Copy as="h2" id="markets-title" zh="换个市场 继续研究" en="Bring another market into your research" />
            <Copy as="p" zh="从加密货币到预测市场，查看不同的策略示例，把数据与交易规则带进研究。" en="Explore strategy examples from crypto to prediction markets. Check the data and trading rules for each research task." />
          </div>
          <ProductStory feature={marketFilm} />
          <div className="market-picker">
            <div className="market-options" role="group" aria-label="选择策略示例 / Choose a strategy example">{markets.map(m=><button key={m.id} data-market={m.id} data-market-route={m.route} aria-pressed={m.id===market} onClick={()=>setMarket(m.id)}><Icon name={m.icon} size={18} /><Copy zh={m.zh} en={m.en} /></button>)}</div>
            <div className="market-detail"><span id="market-symbol">{selectedMarket.symbol}</span><p id="market-description" aria-live="polite">{selectedMarket.note[language==='zh'?0:1]}</p><button className="feature-link" id="market-open" onClick={()=>router.push("/strategies")}><Copy zh="打开策略库" en="Open strategy library" /><Icon name="arrowUpRight" size={17} /></button></div>
          </div>
        </div>
      </section>

      <section className="feature-section integration-section reverse" id="integrations" aria-labelledby="integrations-title">
        <div className="feature-inner wrap">
          <div className="feature-copy">
            <Copy as="h2" id="integrations-title" zh="需要新接口 从需求开始" en="Describe the connector you need" />
            <Copy as="p" zh="告诉 Agent 目标平台与数据需求。它会检查已有连接器，准备适配代码和验证方案，供你审阅。" en="Tell the Agent which platform and data you need. It checks existing connectors and prepares adapter code and a validation plan for your review." />
          </div>
          <ProductStory feature={integrationFilm} />
          <div className="integration-workspace-link"><Link className="feature-link" href="/accounts"><Copy zh="在工作台配置账户与连接器" en="Configure accounts and connectors"/><Icon name="arrowUpRight" size={17}/></Link></div>
        </div>
      </section>

      <section className="start-section wide" id="start">
        <div className="launch-orbits" aria-hidden="true" data-ambient><i/><i/><i/></div><div className="start-content"><img src="/landing/assets/nerya-logo.webp" alt="" width="52" height="52" loading="lazy" /><Copy as="h2" zh="从你的第一个策略开始" en="Start with your first strategy" /><WorkspaceButton /></div>
      </section>
    </main>

    <footer className="site-footer wrap"><div className="footer-top"><a className="brand" href="#top"><img src="/landing/assets/nerya-logo.webp" alt="" width="28" height="28" />Nerya Agent</a><div><a href="https://github.com/NeryaAI/Nerya#readme" target="_blank" rel="noopener noreferrer"><Copy zh="文档" en="Docs" /></a><a href="/skills"><Copy zh="技能" en="Skills" /></a><a href="https://github.com/NeryaAI/Nerya#readme"><Copy zh="SDK 示例" en="SDK examples" /></a><a href="https://github.com/NeryaAI/Nerya" target="_blank" rel="noopener">GitHub <Icon name="arrowUpRight" size={14} /></a></div></div><div className="footer-bottom"><span>© 2026 Nerya Agent · WayAgent FX</span><Copy as="p" zh="页面体验使用示例数据，不连接真实账户或执行交易" en="The tour uses example data and does not connect real accounts or place trades" /><a href="https://github.com/NeryaAI/Nerya/blob/main/LICENSE">PolyForm Noncommercial</a></div></footer>

</div></LandingContext.Provider>;
}
