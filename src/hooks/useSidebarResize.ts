import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Sidebar resize for Electron BrowserView architecture.
 *
 * KEY DESIGN: No requestAnimationFrame throttle during drag.
 * Every pointer move fires IPC directly. The main process only calls
 * setBounds on the CONTENT view (not the sidebar), so there's only
 * one async GPU operation per frame — no compositor desync.
 */

const STORAGE_KEY = 'astra-sidebar-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 220;
const MAX_WIDTH = 500;
const VIEW_INSET = 8;

function saveWidth(w: number) {
  try { localStorage.setItem(STORAGE_KEY, String(w)); } catch { /* localStorage can be unavailable in sandboxed views */ }
}

function loadWidth(): number {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
  } catch {
    /* localStorage can be unavailable in sandboxed views */
  }
  return DEFAULT_WIDTH;
}

export function useSidebarResize() {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const currentWidthRef = useRef(loadWidth());
  const [isResizing, setIsResizing] = useState(false);

  // On mount: restore saved width
  useEffect(() => {
    const saved = loadWidth();
    currentWidthRef.current = saved;
    document.documentElement.style.setProperty('--astra-sidebar-width', `${saved}px`);
    window.astra.resizeSidebar(saved);
  }, []);

  const handleResizeMouseDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const cssWidth = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--astra-sidebar-width'),
      10,
    );
    const domWidth = sidebarRef.current
      ? sidebarRef.current.getBoundingClientRect().width - VIEW_INSET
      : Number.NaN;
    const startWidth = Number.isFinite(cssWidth)
      ? cssWidth
      : Number.isFinite(domWidth)
        ? domWidth
        : currentWidthRef.current;

    const handle = e.currentTarget;

    setIsResizing(true);
    try { handle.setPointerCapture(e.pointerId); } catch { /* pointer capture is best effort */ }
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    let lastWidth = startWidth;

    const onPointerMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      if (clamped === lastWidth) return;
      lastWidth = clamped;
      currentWidthRef.current = clamped;
      document.documentElement.style.setProperty('--astra-sidebar-width', `${clamped}px`);
      window.astra.resizeSidebar(clamped);
    };

    const finishResize = () => {
      // Final authoritative call + persist
      window.astra.resizeSidebar(lastWidth);
      currentWidthRef.current = lastWidth;
      saveWidth(lastWidth);

      setIsResizing(false);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* pointer capture is best effort */ }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', finishResize);
      document.removeEventListener('pointercancel', finishResize);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', finishResize);
    document.addEventListener('pointercancel', finishResize);
  }, []);

  return { sidebarRef, isResizing, handleResizeMouseDown };
}
