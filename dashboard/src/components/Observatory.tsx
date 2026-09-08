import { createContext, useContext, useRef, type ReactNode } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "framer-motion";
import { useCalm } from "./motion";

/**
 * The one pinned sequence on the page. The band is taller than the viewport;
 * its content sticks briefly while scroll progress (0..1 across the band)
 * drives the signal-row reveals, a progress rail, and a slight depth offset
 * between the two columns. Implemented with CSS sticky + scroll-linked
 * transforms only — the native scrollbar is never hijacked.
 */
const BandContext = createContext<MotionValue<number> | null>(null);

export function useBandProgress(): MotionValue<number> | null {
  return useContext(BandContext);
}

export function Observatory({ left, right }: { left: ReactNode; right: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const leftY = useTransform(scrollYProgress, (v) => v * -14);
  const rightY = useTransform(scrollYProgress, (v) => v * 22);
  const rail = useTransform(scrollYProgress, (v) => clamp01((v - 0.02) / 0.9));

  if (calm) {
    return (
      <section className="observatory calm" ref={ref}>
        <div className="obs-inner">
          <div className="obs-grid">
            <div>{left}</div>
            <div>{right}</div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <BandContext.Provider value={scrollYProgress}>
      <section className="observatory" ref={ref}>
        <div className="obs-inner">
          <motion.span className="obs-rail" aria-hidden="true" style={{ scaleY: rail }} />
          <div className="obs-grid">
            <motion.div style={{ y: leftY }}>{left}</motion.div>
            <motion.div className="obs-right" style={{ y: rightY }}>{right}</motion.div>
          </div>
        </div>
      </section>
    </BandContext.Provider>
  );
}

/** A signal row whose entrance is driven by the band's scroll progress. */
export function ProgressRow({
  progress,
  index,
  children,
}: {
  progress: MotionValue<number>;
  index: number;
  children: ReactNode;
}) {
  const start = 0.05 + index * 0.09;
  const reveal = (v: number) => Math.min(1, Math.max(0, (v - start) / 0.08));
  const opacity = useTransform(progress, reveal);
  const x = useTransform(progress, (v) => -16 * (1 - reveal(v)));
  return (
    <motion.li className="signal-row" style={{ opacity, x }}>
      {children}
    </motion.li>
  );
}
