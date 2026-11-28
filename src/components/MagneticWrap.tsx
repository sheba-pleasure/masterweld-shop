import type { ReactNode } from "react";

// Preserve call sites; movement belongs to the workshop scene, not shopping controls.
export function MagneticWrap({
  children,
  className = "",
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  return <div className={`inline-block ${className}`}>{children}</div>;
}
export function SpotlightBezel({
  children,
  className = "",
  innerClassName = "",
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <div className={`bezel-outer ${className}`}>
      <div className={`bezel-inner relative z-10 ${innerClassName}`}>{children}</div>
    </div>
  );
}
