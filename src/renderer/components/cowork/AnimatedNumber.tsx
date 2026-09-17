import './animatedNumber.css';

import { useEffect, useRef, useState } from 'react';

export interface AnimatedNumberProps {
  value: number;
  /** Text placed before the number inside the same span (e.g. "+" / "-"). */
  prefix?: string;
  /** Text placed after the number (e.g. " files changed"). */
  suffix?: string;
  className?: string;
}

/**
 * Codex-style odometer: every digit sits in its own column whose 0–9 strip (a CSS
 * pseudo-element, so it never leaks into textContent or the accessible name) slides
 * vertically to the new digit. The real number stays in the DOM as screen-reader text.
 * Columns are keyed from the units place so a growing number only adds a leading column.
 */
export default function AnimatedNumber({ value, prefix = '', suffix = '', className }: AnimatedNumberProps) {
  const target = Number.isFinite(value) ? Math.round(value) : 0;
  const digits = String(Math.abs(target));
  const sign = target < 0 ? '-' : '';
  const previous = useRef(target);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (previous.current === target) return;
    setDirection(target > previous.current ? 'up' : 'down');
    previous.current = target;
    const timer = setTimeout(() => setDirection(null), 600);
    return () => clearTimeout(timer);
  }, [target]);
  return (
    <span
      className={`cowork-odometer ${className ?? ''}`}
      data-animated-number={target}
      data-animated-number-direction={direction ?? undefined}
    >
      {prefix}{sign}
      <span aria-hidden="true" className="cowork-odometer-digits">
        {digits.split('').map((digit, index) => (
          <span
            key={digits.length - index}
            className="cowork-odometer-digit"
            data-digit={digit}
            style={{ ['--odo' as string]: digit }}
          />
        ))}
      </span>
      <span className="cowork-odometer-value">{digits}</span>
      {suffix}
    </span>
  );
}
