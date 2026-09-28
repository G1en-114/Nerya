"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./WayAgentHome.module.css";

const copy = {
  zh: {
    home: "首页", product: "产品能力", scenarios: "使用场景", workspace: "进入工作台",
    start: "开始使用", explore: "探索使用场景", next: "下一个主题", skip: "跳至主要内容",
    eyebrow: "YOUR NEXT-GEN TRADING AGENT", tagline: "让智能，连接每一次交易。",
    slides: [
      { lead: "洞察市场 · 自主协作 · 从容执行", accent: "面向未来的 AI 交易工作空间", description: "将市场研究、策略回测与交易执行融为一体。\n让想法成为策略，让你的每一步决策都有据可依。" },
      { lead: "从一个问题，走向全局洞察", accent: "让多个智能体，成为你的研究团队", description: "汇集市场信号，串联研究线索。\n与 AI 一起探索机会，构建属于自己的交易认知。" },
      { lead: "从策略构想到行动，步步可循", accent: "先验证想法，再迈出下一步", description: "通过历史回测检验策略，在模拟交易中观察表现。\n把风险边界与人工审批，融入每一次执行。" },
    ],
    pillars: ["技能驱动", "多智能体协作", "自主进化"], scroll: "向下探索", platform: "为你的下一步，准备就绪",
    productsTitle: "从洞察到行动，一个工作空间。", productsText: "把复杂的交易流程，交给有序协作的智能体。",
    products: [
      { title: "市场研究", text: "聚合市场信息，与智能体对话，在纷繁信号中建立清晰判断。", link: "开启研究", href: "/chat" },
      { title: "策略实验室", text: "将想法转化为策略，通过历史回测与模拟交易持续验证。", link: "探索策略", href: "/strategies" },
      { title: "你的技能网络", text: "按需组合专业技能，让智能体的能力随你的工作方式一起生长。", link: "浏览技能", href: "/skills" },
    ],
    scenariosTitle: "每一种交易思路，都有新的可能。",
    scenariosText: "从研究一个市场，到管理一组策略，找到适合你的起点。",
    cases: [
      { number: "01", title: "读懂市场", text: "和 AI 一起梳理行情、新闻与关键市场信号。", href: "/chat" },
      { number: "02", title: "验证策略", text: "用回测检验假设，在执行前了解策略表现。", href: "/strategies" },
      { number: "03", title: "连接交易账户", text: "统一管理账户连接，为策略执行做好准备。", href: "/accounts" },
    ],
    footer: "智能相伴，决策由你。", footerLink: "打开工作台",
  },
  en: {
    home: "Home", product: "Product", scenarios: "Use cases", workspace: "Open workspace",
    start: "Get started", explore: "Explore use cases", next: "Next theme", skip: "Skip to content",
    eyebrow: "YOUR NEXT-GEN TRADING AGENT", tagline: "Intelligence behind every trade.",
    slides: [
      { lead: "Discover. Collaborate. Execute.", accent: "Your AI-native trading workspace", description: "Bring market research, backtesting, and execution together.\nTurn ideas into strategies, with insight at every step." },
      { lead: "From one question to a wider perspective", accent: "Meet your AI research team", description: "Connect market signals and follow the evidence.\nExplore opportunities with agents working alongside you." },
      { lead: "From an idea to a considered next move", accent: "Test your thinking before you trade", description: "Backtest strategies and observe them in paper trading.\nKeep risk limits and human approval part of execution." },
    ],
    pillars: ["Skill-first", "Multi-agent", "Self-evolving"], scroll: "SCROLL TO EXPLORE", platform: "READY FOR YOUR NEXT MOVE",
    productsTitle: "From insight to action. One workspace.", productsText: "Let collaborating agents bring structure to your trading workflow.",
    products: [
      { title: "Market research", text: "Explore market information with your agents and find clarity in the signals.", link: "Start researching", href: "/chat" },
      { title: "Strategy lab", text: "Turn ideas into strategies, then validate them with backtests and paper trading.", link: "Explore strategies", href: "/strategies" },
      { title: "Your skill network", text: "Combine specialist skills as needed and grow your agents around your workflow.", link: "Browse skills", href: "/skills" },
    ],
    scenariosTitle: "A new possibility for every trading idea.",
    scenariosText: "From researching a market to managing strategies, find your starting point.",
    cases: [
      { number: "01", title: "Understand the market", text: "Explore price action, news, and key market signals with AI.", href: "/chat" },
      { number: "02", title: "Validate a strategy", text: "Backtest your hypothesis before putting it into action.", href: "/strategies" },
      { number: "03", title: "Connect your accounts", text: "Manage account connections and prepare for strategy execution.", href: "/accounts" },
    ],
    footer: "Powered by intelligence. Directed by you.", footerLink: "Open workspace",
  },
};

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h15m-6-6 6 6-6 6"} /></svg>;
}

function BrandMark() {
  return <svg className={styles.brandMark} width="35" height="35" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m5 11 7 19 8-15 8 15 7-19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /><path d="m17 7 3 5 3-5" stroke="#d4b873" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function WayAgentHome() {
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [slide, setSlide] = useState(0);
  const t = copy[language];
  const current = t.slides[slide];

  return <div className={styles.root} lang={language === "zh" ? "zh-CN" : "en"}>
    <a className={styles.skipLink} href="#home-content">{t.skip}</a>
    <div className={styles.firstScreen} id="home">
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="WayAgent FX home"><BrandMark /><span>WayAgent <b>FX</b></span></Link>
        <nav className={styles.nav} aria-label={language === "zh" ? "主导航" : "Main navigation"}>
          <a href="#home" className={styles.activeNav}>{t.home}</a>
          <a href="#product">{t.product}</a>
          <a href="#scenarios">{t.scenarios}</a>
        </nav>
        <div className={styles.headerActions}>
          <button className={styles.language} type="button" onClick={() => setLanguage(language === "zh" ? "en" : "zh")} aria-label={language === "zh" ? "Switch to English" : "切换至简体中文"}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></svg>
            {language === "zh" ? "简体中文" : "English"}<span className={styles.chevron}>⌄</span>
          </button>
          <Link href="/chat" className={styles.workspaceLink}>{t.workspace}<Arrow diagonal /></Link>
        </div>
      </header>

      <main className={styles.hero} id="home-content" tabIndex={-1}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}><span />{t.eyebrow}</div>
          <h1>WayAgent <span>FX</span></h1>
          <p className={styles.tagline}>{t.tagline}</p>
          <div className={styles.slideCopy} aria-live="polite" aria-atomic="true">
            <div key={`${language}-${slide}`} className={styles.copyReveal}>
              <p className={styles.lead}>{current.lead}</p>
              <h2>{current.accent}</h2>
              <p className={styles.description}>{current.description}</p>
            </div>
          </div>
          <div className={styles.heroActions}>
            <Link href="/chat" className={styles.primaryButton}>{t.start}<Arrow /></Link>
            <a href="#scenarios" className={styles.secondaryButton}>{t.explore}<Arrow diagonal /></a>
          </div>
          <div className={styles.pillars}>{t.pillars.map((item) => <span key={item}><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 1 6 3.5v7L8 15l-6-3.5v-7L8 1Z" stroke="currentColor" /><path d="m5 8 2 2 4-4" stroke="currentColor" /></svg>{item}</span>)}</div>
        </div>

        <div className={styles.universe} aria-hidden="true">
          <div className={styles.starField} />
          <div className={styles.coordinate}>INTELLIGENCE IN ORBIT <span>／ 001</span></div>
          <div className={styles.planetHalo} />
          <div className={styles.planet}><div className={styles.planetGrid} /><div className={styles.planetShine} /></div>
          <div className={styles.orbitWide}><span /></div>
          <div className={styles.orbitGold}><span /></div>
          <div className={styles.orbitSmall} />
          <div className={styles.orbitLabel}><span />AUTONOMOUS BY DESIGN</div>
          <span className={styles.crosshair}>+</span>
        </div>
        <button className={styles.nextSlide} type="button" onClick={() => setSlide((slide + 1) % t.slides.length)} aria-label={t.next}><Arrow /></button>
      </main>

      <div className={styles.heroBottom}>
        <div className={styles.pagination}><span>0{slide + 1}<i> / 03</i></span><div role="group" aria-label={language === "zh" ? "首页主题" : "Hero themes"}>{t.slides.map((item, index) => <button key={index} type="button" className={index === slide ? styles.selectedDot : styles.dot} onClick={() => setSlide(index)} aria-label={item.accent} aria-pressed={index === slide} />)}</div></div>
        <a href="#product" className={styles.scrollHint}><span />{t.scroll}</a>
        <span className={styles.bottomNote}>BUILT FOR WHAT’S NEXT <span>↗</span></span>
      </div>
    </div>

    <section id="product" className={styles.section}>
      <div className={styles.sectionEyebrow}>THE WAY FORWARD <span>01 — PRODUCT</span></div>
      <h2>{t.productsTitle}</h2><p className={styles.sectionIntro}>{t.productsText}</p>
      <div className={styles.products}>{t.products.map((product, index) => <article key={product.href} className={styles.product}>
        <span className={styles.productIcon}>{["◎", "⌁", "✧"][index]}</span><span className={styles.productNumber}>0{index + 1}</span>
        <h3>{product.title}</h3><p>{product.text}</p><Link href={product.href}>{product.link}<Arrow diagonal /></Link>
      </article>)}</div>
    </section>
    <section id="scenarios" className={`${styles.section} ${styles.scenarios}`}>
      <div className={styles.sectionEyebrow}>{t.platform}<span>02 — USE CASES</span></div>
      <h2>{t.scenariosTitle}</h2><p className={styles.sectionIntro}>{t.scenariosText}</p>
      <div className={styles.caseList}>{t.cases.map(item => <Link href={item.href} className={styles.case} key={item.number}><span className={styles.caseNumber}>{item.number}</span><h3>{item.title}</h3><p>{item.text}</p><Arrow diagonal /></Link>)}</div>
    </section>
    <footer className={styles.footer}><Link href="/" className={styles.brand}><BrandMark /><span>WayAgent <b>FX</b></span></Link><p>{t.footer}</p><Link href="/chat">{t.footerLink}<Arrow diagonal /></Link></footer>
  </div>;
}
