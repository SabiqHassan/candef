import { useEffect, type ReactNode } from "react";

/**
 * Scrolling content page. The scroll container is keyboard-focusable and labelled, so keyboard
 * users can scroll pages that have few focusable elements (axe: scrollable-region-focusable).
 */
export function Page({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${label} | CANDEF`;
  }, [label]);
  return (
    <div className="page" tabIndex={0} role="region" aria-label={label}>
      <div className={className ? `page-inner ${className}` : "page-inner"}>{children}</div>
    </div>
  );
}
