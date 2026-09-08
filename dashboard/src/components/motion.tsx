import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/** True when motion should stay minimal: reduced-motion preference or a small viewport. */
export function useCalm(): boolean {
  const reduced = useReducedMotion();
  const [small, setSmall] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const onChange = () => setSmall(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return Boolean(reduced) || small;
}
