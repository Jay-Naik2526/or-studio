/**
 * Keyboard-shortcut guards shared by the app shell, the workspace frame and the step player.
 * Kept free of React so it can be unit-tested in node.
 */

export interface KeyTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

export interface KeyEventLike {
  key: string;
  target: unknown;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

const TYPING_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

/** True while the user is typing (or operating a native form control) — shortcuts must stay out of the way. */
export function isTypingTarget(t: unknown): boolean {
  const el = t as KeyTargetLike | null | undefined;
  if (!el || typeof el !== 'object') return false;
  if (el.tagName && TYPING_TAGS.includes(el.tagName.toUpperCase())) return true;
  if (el.isContentEditable) return true;
  try { if (typeof el.closest === 'function' && el.closest('[contenteditable=""],[contenteditable="true"],[role="textbox"]')) return true; } catch { /* ignore */ }
  return false;
}

/** Composite widgets that own the arrow keys (tabs, radio groups, menus, listboxes). */
const ARROW_OWNERS = '[role="tablist"],[role="radiogroup"],[role="menu"],[role="listbox"],[role="slider"],[role="tree"],[role="grid"],[role="combobox"]';
/** Controls whose own activation key is Space. */
const SPACE_OWNERS = 'button,a[href],summary,[role="button"],[role="tab"],[role="radio"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"]';

export function ownsArrowKeys(t: unknown): boolean {
  const el = t as KeyTargetLike | null | undefined;
  try { return !!(el && typeof el.closest === 'function' && el.closest(ARROW_OWNERS)); } catch { return false; }
}
export function ownsSpaceKey(t: unknown): boolean {
  const el = t as KeyTargetLike | null | undefined;
  try { return !!(el && typeof el.closest === 'function' && el.closest(SPACE_OWNERS)); } catch { return false; }
}

/** Is a modal dialog (command palette, save/open dialog, mobile menu) currently open? */
export function modalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * Should a bare-key global shortcut (arrows, Space, digits, P, /) be ignored for this event?
 * Ignored while typing, with Ctrl/Cmd/Alt held, during IME composition, when something already handled the event,
 * and while any modal dialog is open.
 */
export function shortcutBlocked(e: KeyEventLike, modal: boolean): boolean {
  if (e.defaultPrevented || e.isComposing) return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (modal) return true;
  return isTypingTarget(e.target);
}
