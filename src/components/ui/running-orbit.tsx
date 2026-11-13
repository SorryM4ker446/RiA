"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils/cn";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    onChange => { const query = window.matchMedia(REDUCED_MOTION); query.addEventListener("change", onChange); return () => query.removeEventListener("change", onChange); },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/** The orbit, tilted as in RiA's icon, and the path the dot follows along it. */
const ORBIT = { cx: 8, cy: 8, rx: 7, ry: 2.9, tilt: -24 };
const ORBIT_PATH = `M${ORBIT.cx + ORBIT.rx} ${ORBIT.cy}A${ORBIT.rx} ${ORBIT.ry} 0 1 1 ${ORBIT.cx - ORBIT.rx} ${ORBIT.cy}A${ORBIT.rx} ${ORBIT.ry} 0 1 1 ${ORBIT.cx + ORBIT.rx} ${ORBIT.cy}`;
/** RiA's four-pointed star, drawn at the orbit's centre (the shape of the `--ria-star` token, scaled). */
const STAR = "M10 0C10.6 9.2 12.6 12.9 20 14C12.6 15.1 10.6 18.8 10 28C9.4 18.8 7.4 15.1 0 14C7.4 12.9 9.4 9.2 10 0Z";

/**
 * That something is under way, drawn from RiA's icon: its star, with a dot
 * travelling its tilted orbit, slowing and quickening as a body in orbit does
 * rather than spinning at a machine's even pace. In the text's colour, the
 * orbit itself faint. With reduced motion the dot rests on the orbit.
 */
export function RunningOrbit({ className }: { className?: string }) {
  const still = usePrefersReducedMotion();
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-3.5 shrink-0 overflow-visible", className)} fill="currentColor" data-running-orbit="">
      <g transform={`rotate(${ORBIT.tilt} ${ORBIT.cx} ${ORBIT.cy})`}>
        <ellipse cx={ORBIT.cx} cy={ORBIT.cy} rx={ORBIT.rx} ry={ORBIT.ry} fill="none" stroke="currentColor" strokeWidth="0.85" opacity="0.32" />
        {still
          ? <circle cx={ORBIT.cx + ORBIT.rx} cy={ORBIT.cy} r="1.35" />
          : (
            <circle r="1.35">
              <animateMotion dur="1.6s" repeatCount="indefinite" path={ORBIT_PATH} calcMode="spline" keyPoints="0;0.5;1" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />
            </circle>
          )}
      </g>
      <path d={STAR} transform="translate(5.9 4.95) scale(0.21)" opacity="0.85" />
    </svg>
  );
}
