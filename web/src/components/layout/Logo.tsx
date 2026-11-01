// Inline brand mark (same geometry as brand/icon-*.svg, viewBox 1024).
//   variant "app" (default): the app icon, a foreground-coloured square with the mark in the
//     background colour (the dark icon on light screens and the light icon on dark ones);
//   variant "mark": the mark alone in the current text colour, for the greeting next to large text.

import { cn } from "cn";

const RAYS: readonly (readonly [number, number, number, number])[] = [
  [534, 520, 534, 217],
  [500, 500, 269, 265],
  [570, 500, 732, 306],
  [520, 534, 217, 534],
  [600, 580, 852, 613],
  [470, 655, 265, 770],
  [590, 655, 855, 852],
];
const ARCH = "M396 676 V545 A127 127 0 0 1 650 545 V676 Z";

export function Logo({ className, variant = "app" }: { className?: string; variant?: "app" | "mark" }) {
  if (variant === "mark") {
    // Cropped to the mark's own extent so it lines up with the text beside it.
    return (
      <svg viewBox="185 185 700 700" className={cn("size-6", className)} aria-hidden="true">
        <g stroke="currentColor" strokeWidth="56" strokeLinecap="round" fill="none">
          {RAYS.map(([x1, y1, x2, y2]) => (
            <line key={`${x2}-${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
        <path d={ARCH} fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 1024 1024" className={cn("size-6", className)} aria-hidden="true">
      <rect width="1024" height="1024" rx="230" className="fill-foreground" />
      <g className="stroke-background" strokeWidth="48" strokeLinecap="round" fill="none">
        {RAYS.map(([x1, y1, x2, y2]) => (
          <line key={`${x2}-${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
      <path d={ARCH} className="fill-background" />
    </svg>
  );
}
