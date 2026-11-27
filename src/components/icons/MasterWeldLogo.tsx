import type { SVGProps } from "react";

interface LogoMarkProps extends SVGProps<SVGSVGElement> {
  size?: number;
  animated?: boolean;
}

/**
 * Geometric MasterWeld brand mark (64x64 grid):
 * Precision hexagonal industrial housing split by a 45-degree welding arc gap
 * forming an interlocking M/W spark silhouette.
 */
export function MasterWeldMark({
  size = 32,
  animated = false,
  className,
  ...props
}: LogoMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Outer machined chamfered hex frame */}
      <path
        d="M32 3L57 17.5V46.5L32 61L7 46.5V17.5L32 3Z"
        fill="currentColor"
        fillOpacity="0.06"
        stroke="currentColor"
        strokeOpacity="0.28"
        strokeWidth="2"
        className={animated ? "mw-logo-draw" : undefined}
      />
      {/* Inner recessed bevel */}
      <path
        d="M32 9L52 20.5V43.5L32 55L12 43.5V20.5L32 9Z"
        stroke="currentColor"
        strokeOpacity="0.12"
        strokeWidth="1.25"
      />
      {/* Left interlocking M-facet (steel white) */}
      <path
        d="M17 43V21L26.5 31.5L32 25.5L29.2 22.4L26.5 25.4L17 15V43Z"
        fill="currentColor"
        fillOpacity="0"
      />
      <path
        d="M17.5 43.5V21.5L26 31L31 25.5"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
        className={animated ? "mw-logo-draw" : undefined}
      />
      {/* Right interlocking W-facet (thermal arc amber) */}
      <path
        d="M46.5 20.5V42.5L38 33L33 38.5"
        stroke="var(--mw-amber)"
        strokeWidth="3.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
        className={animated ? "mw-logo-draw-delay" : undefined}
      />
      {/* Center plasma arc discharge core */}
      <circle
        cx="32"
        cy="32"
        r="3.2"
        fill="var(--mw-cyan)"
        className={animated ? "mw-arc-core" : undefined}
      />
      <path
        d="M32 24.5V26.8M32 37.2V39.5M24.5 32H26.8M37.2 32H39.5"
        stroke="var(--mw-cyan)"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}
