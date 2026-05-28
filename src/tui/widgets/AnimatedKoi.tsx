import React, { useEffect, useState } from "react";
import { useInput } from "ink";
import KohakuKoi, { type KohakuKoiProps } from "./KohakuKoi.js";

const FLASH_MS = 180;
const AMBER = "#ffb000";

/** Eye flashes amber briefly on arrow-key navigation. */
export default function AnimatedKoi(props: KohakuKoiProps) {
  const [active, setActive] = useState(false);

  useInput((_, key) => {
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setActive(true);
    }
  });

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setActive(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [active]);

  return <KohakuKoi {...props} eyeColor={active ? AMBER : undefined} />;
}
