import { RefObject, useEffect, useRef } from 'react';
import { modalOpen } from './keys';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
}

/**
 * Modal behaviour for a dialog element: focus moves in on open, Tab / Shift+Tab are trapped inside, Escape closes
 * and focus returns to whatever had it before the dialog opened. Page scrolling is locked while it is open.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void, opts: { initialFocus?: () => HTMLElement | null | undefined; lockScroll?: boolean } = {}): void {
  const close = useRef(onClose);
  close.current = onClose;
  const initial = useRef(opts.initialFocus);
  initial.current = opts.initialFocus;
  const lock = opts.lockScroll ?? true;
  // what had focus before the dialog rendered (read once, so a dev-mode effect re-run cannot capture the dialog itself)
  const origin = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const prev = origin.current instanceof HTMLElement ? origin.current : null;
    const first = initial.current?.() ?? focusables(root)[0] ?? root;
    if (first === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    first.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      if (items.length === 0) { e.preventDefault(); root.focus(); return; }
      const a = document.activeElement as HTMLElement | null;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (!a || !root.contains(a)) { e.preventDefault(); (e.shiftKey ? lastEl : firstEl).focus(); }
      else if (e.shiftKey && a === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && a === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    // focus that escapes the dialog (e.g. a click on the backdrop's blur) is pulled back in
    const onFocusIn = (e: FocusEvent) => { if (e.target instanceof Node && !root.contains(e.target)) { (focusables(root)[0] ?? root).focus({ preventScroll: true }); } };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    const prevOverflow = document.body.style.overflow;
    if (lock) document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      if (lock) document.body.style.overflow = prevOverflow;
      // restored on a later tick, and only if nothing else (e.g. the new page) has taken focus meanwhile: restoring synchronously lets the Enter key that closed the dialog also press the trigger button
      if (prev) window.setTimeout(() => { if (prev.isConnected && !modalOpen() && (!document.activeElement || document.activeElement === document.body)) prev.focus({ preventScroll: true }); }, 0);
    };
  }, [ref, lock]);
}
