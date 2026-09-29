/* Adapted from the companion NeryaAI website. */
/* eslint-disable @next/next/no-img-element */
import React, {useRef, type CSSProperties} from 'react';
import {cn} from '../utils';
import Copy from './Copy';
import Icon from './Icon';
import NativePart from './NativePart';
import {useStory} from './useStory';






const titles = {
  strategy: ['把一句话 连接成策略', 'Connect an idea into a strategy'],
  team: ['不同视角 同一份证据', 'Different minds. Shared evidence.'],
  evolution: ['回看证据 再做改变', 'Look back before moving forward'],
  vault: ['凭据留在本地 引用进入工作流', 'Local credentials. Referenced in the flow.'],
  markets: ['行情成为研究的一部分', 'Market context, inside your research'],
  integrations: ['从接口需求 到可审阅的方案', 'From an API brief to a reviewable plan'],
};


export default function ProductStory({feature}: {feature: {id:string;steps: ReadonlyArray<{zh:string;en:string}>}}){
const ref=useRef<HTMLElement>(null); useStory(ref);
const id=feature.id; const title=titles[id as keyof typeof titles];
return <><figure ref={ref} className={cn(['product-story', `story-${id}`])} data-story={id} data-paused="true" data-chapter="0" aria-label={`${title[0]} / ${title[1]}`}>
  <div className="story-stage">
    <div className="scene-grid" aria-hidden="true"></div>
    <div className="scene-label"><span className="scene-dot"/><Copy zh="工作流演示" en="WORKFLOW STUDY" /><span className="scene-index">{String(['strategy','team','evolution','vault','markets','integrations'].indexOf(id)+1).padStart(2,'0')} / 06</span></div>
    {id === 'strategy' && <div className="strategy-scene scene-composition">
      <div className="scene-prompt phase-one"><img src="/landing/assets/nerya-logo.webp" width="26" height="26" alt=""/><Copy zh="把 BTC 趋势想法变成可验证的策略" en="Turn the BTC trend idea into a testable strategy" /><span className="prompt-cursor" aria-hidden="true"/></div>
      <div className="scene-workflow phase-two">
        <svg className="scene-connectors" viewBox="0 0 560 110" preserveAspectRatio="none" aria-hidden="true"><path className="wire" d="M55 48H505"/><path className="wire-active" d="M55 48H505" pathLength="1"/><circle className="wire-packet" r="4"/></svg>
        {[['clock','每 15 分钟','Every 15m'],['candles','行情','Market'],['code','信号','Signal'],['shield','风控','Risk']].map(([icon,zh,en],i)=><div key={icon} className="scene-node" style={{ '--i': i } as CSSProperties}><span><Icon name={icon} size={23}/></span><Copy zh={zh} en={en}/></div>)}
      </div>
      <div className="scene-result phase-three"><div className="scene-card-heading"><span className="mini-document"><Icon name="chart" size={18}/></span><div><Copy as="strong" zh="回测摘要" en="Backtest summary"/><Copy as="span" zh="模拟示例 · 180 天" en="Illustrative · 180 days"/></div><span className="scene-tag"><Copy zh="待审阅" en="In review"/></span></div>
        <svg className="scene-equity" viewBox="0 0 500 85" aria-label="示例净值曲线 / Illustrative equity curve" role="img"><path className="equity-guide" d="M0 25H500 M0 60H500"/><path className="equity-plot" pathLength="1" d="M0 70L24 66L48 72L72 55L96 59L120 47L144 55L168 42L192 46L216 28L240 39L264 22L288 29L312 19L336 26L360 15L384 23L408 10L432 15L456 7L480 12L500 3"/></svg>
        <NativePart name="backtest" />
      </div>
    </div>}
    {id === 'team' && <div className="team-scene scene-composition">
      <div className="team-core phase-one"><img src="/landing/assets/nerya-logo.webp" width="43" height="43" alt=""/><Copy as="strong" zh="研究 BTC 的趋势与风险" en="Research BTC structure & risk"/><span>AGENT TEAM</span></div>
      <div className="team-network phase-two"><svg viewBox="0 0 560 130" preserveAspectRatio="none" aria-hidden="true"><path className="wire" d="M280 0V20Q280 32 260 32H93V122M280 32V122M280 32H467V122"/><path className="wire-active" pathLength="1" d="M280 0V32H93V122M280 32V122M280 32H467V122"/></svg>
        {[['researcher','研究员','Researcher','结构与量能','Structure & volume'],['reviewer','审阅员','Reviewer','独立核查','Independent review'],['risk','风控','Risk','边界与反证','Limits & counterevidence']].map(([role,zh,en,subZh,subEn],i)=><div key={role} className="team-person" style={{ '--i': i } as CSSProperties}><img src={`/landing/assets/agent-avatars/${role}.png`} width="54" height="54" alt=""/><Copy as="strong" zh={zh} en={en}/><Copy as="span" zh={subZh} en={subEn}/><span className="agent-working" aria-hidden="true"><i/><i/><i/></span></div>)}
      </div>
      <div className="team-evidence phase-three"><span className="evidence-spine"/><div><span className="scene-tag"><Copy zh="保留分歧" en="Dissent retained"/></span><Copy as="h3" zh="结论与证据 一起交付" en="The thesis, with its evidence"/><Copy as="p" zh="趋势结构仍在，量能确认不足。保持观察，等待下一次核查。" en="Structure holds; volume is unconfirmed. Keep observing and revisit the evidence."/><div className="evidence-lines" aria-hidden="true"><i/><i/><i/></div></div></div>
    </div>}
    {id === 'evolution' && <div className="evolution-scene scene-composition">
      <div className="review-orbit phase-one"><svg viewBox="0 0 250 250" aria-hidden="true"><circle className="orbit-track" cx="125" cy="125" r="105"/><circle className="orbit-progress" cx="125" cy="125" r="105" pathLength="1"/></svg><img src="/landing/assets/agent-avatars/evolution.png" width="66" height="66" alt=""/><strong>18</strong><Copy as="span" zh="模拟会话" en="Paper sessions"/><span className="review-orbit-tick">↻</span></div>
      <div className="diff-stack phase-two"><div className="diff-behind"/><div className="diff-card"><div className="scene-card-heading"><Icon name="code" size={18}/><Copy as="strong" zh="候选改动" en="Candidate diff"/><span>014</span></div><code className="diff-context">strategy / risk</code><code className="diff-minus">− max_position_pct: 8</code><code className="diff-plus">+ max_position_pct: 5</code><div className="diff-divider"/><code className="diff-minus">− confirmation_bars: 1</code><code className="diff-plus">+ confirmation_bars: 3</code></div></div>
      <div className="review-receipt phase-three"><span className="receipt-ring"><Icon name="shield" size={23}/></span><div><Copy as="strong" zh="提案已准备好 等待你审阅" en="Proposal ready for your review"/><Copy as="p" zh="当前配置不变 · 验证、审批与应用分开" en="Runtime unchanged · Validate, approve, then apply"/></div></div>
    </div>}
    {id === 'vault' && <div className="vault-scene scene-composition">
      <div className="secret-slip phase-one"><Icon name="code" size={22}/><span>API KEY</span><code>•••• •••• ••••</code><Copy as="small" zh="仅为遮罩示意" en="Masked illustration"/></div>
      <div className="vault-halo phase-two"><div className="halo-ring ring-a"/><div className="halo-ring ring-b"/><div className="vault-core"><Icon name="shield" size={54}/></div><span>LOCAL VAULT</span></div>
      <div className="reference-slip phase-three"><span className="reference-dot"/><Copy as="strong" zh="工作流使用引用" en="A reference in the workflow"/><code>vault://market-key</code><div><Icon name="workflow" size={16}/><Copy zh="账户配置 → 运行时" en="Account config → Runtime"/></div></div>
      <div className="vault-boundary"><span/><Copy zh="加密落盘 与执行权限分别检查" en="Encryption at rest and execution permissions are separate controls"/><span/></div>
    </div>}
    {id === 'markets' && <div className="market-scene scene-composition">
      <div className="market-chips phase-one">{[['₿','加密货币','Crypto'],['◈','预测市场','Prediction'],['↗','期货','Futures'],['A','股票','Equities']].map(([mark,zh,en],i)=><span key={mark} style={{ '--i': i } as CSSProperties}><b>{mark}</b><Copy zh={zh} en={en}/></span>)}</div>
      <div className="market-chart-stage phase-two"><div className="market-chart-title"><strong>BTC / USDT</strong><span>4H <i/> EMA 20 / 60</span></div><svg viewBox="0 0 520 190" preserveAspectRatio="none" aria-label="示意 K 线 / Illustrative candles" role="img"><path className="equity-guide" d="M0 35H520M0 90H520M0 145H520"/>{[87,83,96,78,75,91,68,59,72,56,49,62,39,43,36,50,28,18,30,22,11,25,8,15].map((y,i)=><g key={i} className={cn(['scene-candle',i%4===1&&'down'])} style={{ '--i': i } as CSSProperties}><line x1={i*21+9} x2={i*21+9} y1={y+15} y2={y+60}/><rect x={i*21+5} y={y+25} width="8" height={13+i%4*3} rx="1"/></g>)}<path className="equity-plot average" pathLength="1" d="M0 150C80 149 75 110 150 119S220 98 270 89S350 73 405 65S465 56 515 50"/><path className="scan-line" d="M280 0V190"/></svg></div>
      <div className="market-native phase-three"><NativePart name="market"/></div>
    </div>}
    {id === 'integrations' && <div className="integration-scene scene-composition">
      <div className="integration-request phase-one"><span className="api-bracket">{'{ }'}</span><div><Copy as="strong" zh="接入一个新的行情接口" en="Connect a new market data API"/><span>ExampleX / market-data</span></div></div>
      <div className="integration-map phase-two"><div className="api-port"><code>GET</code><span>/markets</span><span>/candles</span><span>/account</span></div><div className="api-bridge"><span className="bridge-signal"/><Icon name="workflow" size={28}/><Copy zh="检查现有连接器" en="Check existing connectors"/></div><div className="api-package"><Icon name="code" size={27}/><span>provider_spec</span><span>validation_plan</span></div></div>
      <div className="integration-proposal phase-three"><div><span className="proposal-stamp"><Icon name="shield" size={21}/></span><Copy as="strong" zh="接入提案 等待核验" en="Integration plan awaiting validation"/></div><Copy as="p" zh="先确认能力、权限与测试方案，再由你审阅。生成提案不等于已连接。" en="Inspect capabilities, permissions and tests before review. A proposal is not a verified connection."/><span className="scene-tag"><Copy zh="订单权限保持关闭" en="Order placement remains disabled"/></span></div>
    </div>}
    <div className="scene-disclosure"><Copy zh="动画示意 · 示例数据" en="Animated illustration · Sample data" />{['strategy','markets'].includes(id)&&<Copy zh="含原生组件局部预览" en="Includes native component excerpts"/>}</div>
  </div>
  <figcaption className="story-controls"><button className="story-toggle icon-button" aria-label="播放动画 / Play animation" aria-pressed="true"><span className="story-playing"><Icon name="pause" size={16}/></span><span className="story-paused"><Icon name="play" size={16}/></span></button><div className="story-chapters" aria-label="动画章节 / Animation chapters">{feature.steps.map((step,i)=><button key={i} data-story-chapter={i} aria-pressed={i===0?'true':'false'}><span className="chapter-number">0{i+1}</span><Copy zh={step.zh} en={step.en}/><i aria-hidden="true"/></button>)}</div><button className="story-replay icon-button" aria-label="重新播放 / Replay"><Icon name="refresh" size={16}/></button></figcaption>
</figure></>;
}
