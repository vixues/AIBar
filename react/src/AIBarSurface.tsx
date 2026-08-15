/**
 * @aibar/react — React 19 binding (docs/aibar-architecture.md §10 usage).
 *
 * The kernel + DOM backend do all rendering; React only owns the mount node.
 * Optional `heightVariable` publishes the surface's actual footprint onto
 * `document.documentElement` so host pages can pad (design doc §3.3). Off by
 * default so iframe / multi-surface hosts are not forced to mutate `<html>`.
 */
import { useEffect, useRef } from 'react';
import { AIBarKernel, type AIBarKernelOptions } from '@aibar/core';
import { DOMRendererBackend } from '@aibar/renderer-dom';
import '@aibar/renderer-dom/styles.css';

export function createAIBarKernel(options: AIBarKernelOptions): AIBarKernel {
  return new AIBarKernel(options);
}

export interface AIBarSurfaceProps {
  kernel: AIBarKernel;
  ariaLabel: string;
  density?: 'compact' | 'regular';
  className?: string;
  /** CSS variable published on <html> with the surface's real height. Off by default. */
  heightVariable?: string | null;
}

export function AIBarSurface({
  kernel,
  ariaLabel,
  density,
  className,
  heightVariable = null,
}: AIBarSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const backend = new DOMRendererBackend({ ariaLabel, density: density ?? kernel.density });
    kernel.attach(backend, container);

    if (!heightVariable) {
      return () => {
        kernel.detach();
      };
    }

    const rootStyle = container.ownerDocument.documentElement.style;
    const observer = new ResizeObserver(() => {
      rootStyle.setProperty(heightVariable, `${container.offsetHeight}px`);
    });
    observer.observe(container);
    rootStyle.setProperty(heightVariable, `${kernel.surfaceHeight}px`);

    return () => {
      observer.disconnect();
      rootStyle.removeProperty(heightVariable);
      kernel.detach();
    };
  }, [kernel, ariaLabel, density, heightVariable]);

  return <div ref={containerRef} className={className} data-testid="aibar-surface" />;
}
