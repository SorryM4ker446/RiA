"use client";
// motion-exempt: the startup sequence is one choreographed intro, timed as a whole rather than from the motion tokens.
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import { useEffect, useRef, useState } from "react";
import { WindowControls } from "./window-controls";

export function DesktopStartup({ children }: { children: React.ReactNode }) {
  useLocale();
  const [ticket, setTicket] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const startup = window.riaDesktop?.startup;
    if (!startup) return;
    let current = true;
    void startup.claim().then(token => {
      if (!current || !token) return;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        void startup.present(token).catch(() => {});
      } else setTicket(token);
    }).catch(() => { /* Startup decoration is optional; the native window still opens. */ });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const startup = window.riaDesktop?.startup;
    const element = surface.current;
    if (!ticket || !startup || !element) return;
    let current = true;
    const animations: Animation[] = [];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (current) setTicket(null); };
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = () => { if (motion.matches) finish(); };
    const visibilityChanged = () => { if (document.hidden) finish(); };
    // Include a stalled readiness IPC in the budget, not only animation time.
    deadline = setTimeout(finish, 2000);
    motion.addEventListener("change", motionChanged);
    document.addEventListener("visibilitychange", visibilityChanged);
    void startup.present(ticket).then(shown => {
      if (!current) return;
      if (!shown || motion.matches) { finish(); return; }
      const easing = "cubic-bezier(.16,1,.3,1)";
      const start = document.timeline.currentTime;
      const animate = (target: Element, frames: Keyframe[], timing: KeyframeAnimationOptions) => {
        const animation = target.animate(frames, { fill: "both", ...timing });
        animation.startTime = start;
        animations.push(animation);
        return animation;
      };
      const mark = element.querySelector(".desktop-startup-mark")!;
      element.querySelectorAll(".desktop-startup-glyph").forEach((glyph, index) => {
        animate(glyph, [{ transform: "translateY(110%)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], { duration: 500, delay: index * 45, easing });
      });
      animate(element.querySelector(".desktop-startup-note")!, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: 180, easing });
      animate(mark, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }], { duration: 180, delay: 680, easing: "ease-in" });
      // The lettering is gone before the workspace appears, so the two never overlap.
      animate(element, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, delay: 860, easing: "ease-in-out" });
      // Reach the workspace's native transparency before removing the startup
      // surface; dropping an opaque background at teardown would cause a jump.
      animate(stage.current!, [{ backgroundColor: getComputedStyle(stage.current!).backgroundColor }, { backgroundColor: "transparent" }], { duration: 420, delay: 860, easing });
      const entrance = animate(workspace.current!, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 860, easing });
      void entrance.finished.then(finish, finish);
    }).catch(finish);
    return () => {
      current = false;
      if (deadline) clearTimeout(deadline);
      for (const animation of animations) animation.cancel();
      motion.removeEventListener("change", motionChanged);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [ticket]);

  return <div ref={stage} className="desktop-startup-stage" data-starting={ticket ? "true" : undefined}>
    <div ref={workspace} className="desktop-startup-workspace" data-starting={ticket ? "true" : undefined} inert={ticket ? true : undefined} aria-hidden={ticket ? true : undefined}>{children}</div>
    {ticket ? <section ref={surface} className="desktop-startup" aria-label={t("ui.layout.desktop-startup.riAStartupAnimation")}>
      <div className="desktop-startup-caption desktop-titlebar-drag"><WindowControls /></div>
      <div className="desktop-startup-mark">
        <span className="desktop-startup-wordmark" aria-hidden="true">
          {Array.from("RiA", letter => (
            <span className="desktop-startup-letter" key={letter}>
              <span className="desktop-startup-glyph">{letter}</span>
            </span>
          ))}
        </span>
        <p className="desktop-startup-note">{t("ui.layout.desktop-startup.readyToGetStarted")}</p>
      </div>
      <p className="sr-only" role="status">{t("ui.layout.desktop-startup.openingRiA")}</p>
    </section> : null}
  </div>;
}
