import React, { type CSSProperties } from 'react';

/** Vector light field inspired by Kokonut UI Background Paths on 21st.dev.
 * Original Nerya path geometry, deterministic SSR, no canvas or random hydration.
 * The landing page's motion preference controls its CSS animations. */
export function BackgroundPaths() {
  const paths = Array.from({ length: 18 }, (_, i) => {
    const shift = i * 15;
    return `M ${-140 + shift} -80 C ${-230 + shift} 160, ${150 + shift} 230, ${180 + shift} 370 S ${400 + shift} 660, ${-160 + shift} 970`;
  });
  return <div className="hero-atmosphere" data-ambient aria-hidden="true">
    <div className="aurora-wash aurora-wash-a" /><div className="aurora-wash aurora-wash-b" />
    <div className="atmosphere-grid" />
    <svg className="atmosphere-paths" viewBox="0 0 1440 1060" preserveAspectRatio="xMidYMid slice" fill="none">
      <defs>
        <linearGradient id="nerya-path-light" x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--fx-violet)" stopOpacity=".05"/><stop offset=".45" stopColor="var(--fx-violet)"/><stop offset="1" stopColor="var(--fx-cyan)" stopOpacity=".1"/></linearGradient>
        <linearGradient id="nerya-path-right" x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--fx-cyan)" stopOpacity=".05"/><stop offset=".6" stopColor="var(--fx-cyan)"/><stop offset="1" stopColor="var(--fx-violet)" stopOpacity=".1"/></linearGradient>
      </defs>
      {[0,1].map(side=><g key={side} transform={side ? 'translate(1440 0) scale(-1 1)' : undefined}>
        {paths.map((d,i)=><g key={i} style={{ '--path-i': i, '--path-delay': `${-(i * .71 + side * 4)}s` } as CSSProperties}>
          <path d={d} stroke={side ? 'url(#nerya-path-right)' : 'url(#nerya-path-light)'} strokeWidth=".8" opacity=".24"/>
          <path className="photon-path" d={d} pathLength="1" stroke={side ? 'url(#nerya-path-right)' : 'url(#nerya-path-light)'} strokeWidth={i%5===0 ? '2' : '1'} strokeLinecap="round"/>
        </g>)}
      </g>)}
    </svg>
    <div className="horizon-orbit horizon-orbit-a"/><div className="horizon-orbit horizon-orbit-b"/>
    <div className="atmosphere-stars">{Array.from({length:28},(_,i)=><i key={i} style={{left:`${(i*37+11)%100}%`,top:`${(i*23+7)%85}%`,'--star-delay':`${-(i%9)}s`,'--star-size':`${i%5===0?3:2}px`} as CSSProperties}/>)}</div>
  </div>;
}
