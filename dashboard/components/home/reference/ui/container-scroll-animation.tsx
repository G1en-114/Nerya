"use client";

// Adapted from the ContainerScroll supplied in the brief (Aceternity UI).
// Keep titleComponent/children and the MotionValue-based Header/Card API.
// Changes: typed props, accessible motion controls, live iframe hit testing,
// scoped scroll offsets, and no demonstration-only 1000px opening spacer.
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useScroll, useSpring, useTransform, useMotionValueEvent, useReducedMotion, type MotionValue } from 'framer-motion';
import { cn } from '../utils';
import {useLanding} from '../context';

export type ContainerScrollProps = {
  titleComponent: string | ReactNode;
  children: ReactNode;
  className?: string;
};

export function ContainerScroll({ titleComponent, children, className }: ContainerScrollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const prefersReduced = useReducedMotion();
  const [isMobile, setIsMobile] = useState(false);
  const {paused} = useLanding();
  const [interactive, setInteractive] = useState(false);
  const [ready, setReady] = useState(false);
  const hold = useRef(false);
  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start start', 'end 45%'] });
  const progress = useSpring(scrollYProgress, { stiffness: 145, damping: 32, mass: .45 });
  const rotate = useTransform(progress, [0, 1], [30, 0]);
  // A usable iframe must not shrink to 70% on phones. Keep native readable
  // sizing on touch, but retain the supplied desktop 1.05 → 1 framing.
  const scale = useTransform(progress, [0, 1], isMobile ? [1, 1] : [1.02, 1]);
  const headerTranslate = useTransform(progress, [0, 1], [0, -45]);
  const blur = useTransform(progress, [0, .32, 1], ['blur(3px)', 'blur(0px)', 'blur(0px)']);
  // Start the Mock tucked behind the slogan, then let it settle back into
  // its reserved document-flow position during the first part of the scroll.
  // Once settled it stops translating, so it can never drift into the copy
  // that follows the hero.
  const cardTranslate = useTransform(progress, [0, .28, 1], [-70, 0, 0]);
  const disabled = !ready || Boolean(prefersReduced) || isMobile || paused || interactive;
  const active = useRef(false);
  active.current = !disabled;

  useMotionValueEvent(progress, 'change', value => {
    if (!containerRef.current || !active.current || hold.current) return;
    containerRef.current.dataset.progress = Math.max(0, Math.min(1, value)).toFixed(4);
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const media = matchMedia('(max-width: 768px), (hover: none), (pointer: coarse)');
    const updateMobile = () => setIsMobile(media.matches);

    updateMobile(); setReady(true);
    media.addEventListener('change', updateMobile);


    const frame = container.querySelector<HTMLIFrameElement>('#agent-frame');
    const cleanups: Array<() => void> = [];
    const bound = new WeakSet<EventTarget>();
    let raf = 0;
    // Only genuine input activates the workspace. Its delayed autofocus is
    // not visitor intent. Freeze the transform until pointerup/click finishes.
    const activate = () => { hold.current = false; setInteractive(true); };
    const down = () => {
      hold.current = true;
      const card = cardRef.current;
      if (card) { card.style.setProperty('--held-transform', getComputedStyle(card).transform); card.dataset.held = 'true'; }
    };
    const up = () => {
      if (!hold.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { activate(); if (cardRef.current) delete cardRef.current.dataset.held; });
    };
    const bind = (target: EventTarget) => {
      if (bound.has(target)) return; bound.add(target);
      target.addEventListener('pointerdown', down, { capture: true, passive: true });
      target.addEventListener('pointerup', up, { capture: true, passive: true });
      target.addEventListener('pointercancel', up, { capture: true, passive: true });
      // KeyboardEvent comes from a different realm inside an iframe.
      const localKey = () => activate();
      target.addEventListener('keydown', localKey, { capture: true });
      cleanups.push(() => {
        target.removeEventListener('pointerdown', down, true); target.removeEventListener('pointerup', up, true);
        target.removeEventListener('pointercancel', up, true); target.removeEventListener('keydown', localKey, true);
      });
    };
    if (cardRef.current) bind(cardRef.current);
    const inside = () => { try { if (frame?.contentDocument) bind(frame.contentDocument); } catch { /* Cross-origin frames remain isolated. */ } };
    frame?.addEventListener('load', inside); inside();
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', up, { passive: true });
    window.addEventListener('nerya:workspaceopen', activate);
    window.addEventListener('nerya:workspaceexpand', activate);
    // Tab focus into the workspace must settle before a user activates controls.
    let keyboardIntent = false;
    const markKeyboard = (event: KeyboardEvent) => { if (event.key === 'Tab') keyboardIntent = true; };
    const focus = () => { if (keyboardIntent && !hold.current) activate(); };
    document.addEventListener('keydown', markKeyboard, true);
    cardRef.current?.addEventListener('focusin', focus);
    const card = cardRef.current;
    return () => {
      cancelAnimationFrame(raf); media.removeEventListener('change', updateMobile);
      frame?.removeEventListener('load', inside); cleanups.forEach(fn => fn());
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      window.removeEventListener('nerya:workspaceopen', activate); window.removeEventListener('nerya:workspaceexpand', activate);
      document.removeEventListener('keydown', markKeyboard, true); card?.removeEventListener('focusin', focus);
    };
  }, []);

  return <div ref={containerRef} className={cn('container-scroll relative w-full', className)}
    data-container-scroll data-ready={ready} data-motion={disabled ? 'static' : 'scroll'} data-progress="0">
    <div className="container-scroll-perspective relative w-full">
      <Header translate={headerTranslate} titleComponent={titleComponent} disabled={disabled} />
      <Card ref={cardRef} rotate={rotate} scale={scale} translate={cardTranslate} blur={blur} disabled={disabled}>{children}</Card>
    </div>
  </div>;
}

export function Header({ translate, titleComponent, disabled = false }: {
  translate: MotionValue<number>; titleComponent: ReactNode; disabled?: boolean;
}) {
  return <motion.div className="container-scroll-header relative mx-auto text-center" style={{ y: disabled ? 0 : translate }}>
    {titleComponent}
  </motion.div>;
}

export const Card = React.forwardRef<HTMLDivElement, {
  rotate: MotionValue<number>; scale: MotionValue<number>; translate: MotionValue<number>; blur: MotionValue<string>;
  children: ReactNode; disabled?: boolean;
}>(function Card({ rotate, scale, translate, blur, children, disabled = false }, ref) {
  return <motion.div ref={ref} className="container-scroll-card relative mx-auto" data-scroll-card
    style={{ rotateX: disabled ? 0 : rotate, scale: disabled ? 1 : scale, y: disabled ? 0 : translate, filter: disabled ? 'none' : blur }}>
    {children}
  </motion.div>;
});
