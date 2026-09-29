import { useEffect, type RefObject } from "react";
import { useLanding } from "../context";

/** Synchronize the reference's authored CSS scenes; release clocks on route exit. */
export function useStory(ref: RefObject<HTMLElement>) {
  const { paused, language } = useLanding();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false, manual = false, time = 8000, previous = 0, raf = 0;
    let animations: Animation[] = [];
    const toggle = el.querySelector<HTMLButtonElement>(".story-toggle")!;
    const replay = el.querySelector<HTMLButtonElement>(".story-replay")!;
    const chapters = [...el.querySelectorAll<HTMLButtonElement>("[data-story-chapter]")];
    const paint = () => {
      const phase = (time % 12000) / 4000;
      el.dataset.chapter = String(Math.floor(phase));
      chapters.forEach((button, index) => {
        button.setAttribute("aria-pressed", String(index === Math.floor(phase)));
        button.style.setProperty("--chapter-progress", `${Math.max(0, Math.min(1, phase - index)) * 100}%`);
      });
      animations.forEach(animation => { animation.currentTime = time; });
    };
    const sync = () => {
      cancelAnimationFrame(raf); previous = 0;
      const stopped = paused || media.matches || manual || !visible || document.hidden;
      el.dataset.paused = String(stopped);
      toggle.disabled = media.matches || paused;
      toggle.setAttribute("aria-pressed", String(stopped));
      toggle.setAttribute("aria-label", language === "zh" ? (stopped ? "播放动画" : "暂停动画") : (stopped ? "Play animation" : "Pause animation"));
      animations = el.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation);
      animations.forEach(animation => animation.pause());
      paint();
      if (stopped) return;
      const tick = (now: number) => {
        if (previous) time = (time + Math.min(100, now - previous)) % 12000;
        previous = now; paint(); raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: .12 });
    const onToggle = () => { manual = !manual; sync(); };
    const onReplay = () => { time = 0; manual = false; sync(); };
    const onChapter = (event: Event) => { manual = true; time = Number((event.currentTarget as HTMLElement).dataset.storyChapter) * 4000 + 1600; sync(); };
    observer.observe(el);
    toggle.addEventListener("click", onToggle); replay.addEventListener("click", onReplay);
    chapters.forEach(button => button.addEventListener("click", onChapter));
    document.addEventListener("visibilitychange", sync); media.addEventListener("change", sync);
    sync();
    return () => {
      cancelAnimationFrame(raf); observer.disconnect();
      toggle.removeEventListener("click", onToggle); replay.removeEventListener("click", onReplay);
      chapters.forEach(button => button.removeEventListener("click", onChapter));
      document.removeEventListener("visibilitychange", sync); media.removeEventListener("change", sync);
    };
  }, [ref, paused, language]);
}
