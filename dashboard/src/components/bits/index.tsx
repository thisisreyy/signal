/**
 * Four small pieces adapted from React Bits (reactbits.dev, MIT), typed and
 * fitted to Signal's tokens. Each earns its place by doing a job:
 * CountUp says "freshly computed", SpotlightCard gives hover feedback,
 * GradualBlur signals that a scrollable list continues, ShinyText marks
 * live work. Nothing here animates on idle.
 */
import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useInView, useMotionValue, useSpring } from "framer-motion";
import { useCalm } from "../motion";

/** A number that counts to its value once, when it comes into view. */
export function CountUp({
  to,
  from = 0,
  duration = 1.1,
  prefix = "",
  className,
  style,
}: {
  to: number;
  from?: number;
  duration?: number;
  prefix?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  const motionValue = useMotionValue(calm ? to : from);
  const spring = useSpring(motionValue, {
    damping: 26,
    stiffness: 90,
    duration: duration * 1000,
  });
  const inView = useInView(ref, { once: true, margin: "0px" });

  useEffect(() => {
    const node = ref.current;
    if (node) node.textContent = `${prefix}${Math.round(calm ? to : from)}`;
  }, [from, to, prefix, calm]);

  useEffect(() => {
    if (inView && !calm) motionValue.set(to);
  }, [inView, calm, motionValue, to]);

  useEffect(() => {
    return spring.on("change", (latest: number) => {
      const node = ref.current;
      if (node) node.textContent = `${prefix}${Math.round(latest)}`;
    });
  }, [spring, prefix]);

  return <span ref={ref} className={className} style={style} />;
}

/** A card whose surface lights faintly under the cursor. No idle motion. */
export function SpotlightCard({
  children,
  className = "",
  style,
  spotlightColor = "rgba(148, 135, 235, 0.14)",
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  spotlightColor?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
    node.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      className={`spotlight ${className}`}
      style={{ ...style, ["--spotlight-color" as string]: spotlightColor }}
    >
      {children}
    </div>
  );
}

/**
 * A soft fade at the bottom edge of a scrollable list — the affordance that
 * says "this continues" instead of a hard cut.
 */
export function GradualBlur({ height = 56 }: { height?: number }) {
  return <div className="gradual-blur" aria-hidden="true" style={{ height }} />;
}

/** A quiet sheen across text, for work that is happening right now. */
export function ShinyText({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const calm = useCalm();
  return (
    <span className={`${calm ? "" : "shiny"} ${className}`.trim()}>{children}</span>
  );
}
