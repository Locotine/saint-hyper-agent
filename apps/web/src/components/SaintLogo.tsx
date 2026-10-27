// FILE: SaintLogo.tsx
// Purpose: Render the Saint mark as an inline SVG that follows theme foreground color.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { SAINT_LOGO_PATHS, SAINT_LOGO_VIEW_BOX } from "~/assets/saintLogoPath";
import { cn } from "~/lib/utils";

export function SaintLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox={SAINT_LOGO_VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      {SAINT_LOGO_PATHS.map((path) => (
        <path key={path} d={path} fill="currentColor" fillRule="evenodd" />
      ))}
    </svg>
  );
}
