import { useEffect } from 'react';
import { lookupTerm } from '../../lib/glossary';

/**
 * Hover (or tap / keyboard-focus) explanations for every short form in the app.
 *
 * Instead of wrapping labels one by one in every module, this layer watches the page: any element whose own
 * text is exactly a known label (a table heading, a badge, a symbol such as ρ or RHS, a method name) is marked
 * with `data-term`, and a single tooltip shows its meaning from lib/glossary.ts. New modules are covered
 * automatically as long as their labels are in the glossary.
 */
const SKIP = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE', 'OPTION', 'CODE', 'PRE', 'SVG', 'PATH', 'TEXT', 'TSPAN', 'MATH', 'ANNOTATION']);

function ownText(el: Element): string {
  let t = '';
  el.childNodes.forEach(n => { if (n.nodeType === 3) t += n.textContent ?? ''; });
  return t;
}

function tag(el: Element) {
  if (SKIP.has(el.tagName.toUpperCase()) || el.closest('svg, .katex, #glossary-tip, [data-no-glossary]')) return;
  const isCell = el.tagName === 'TH' || el.tagName === 'TD';
  // icons (svg) do not count as content: a tab such as <svg/> Gantt is still a plain label
  if (!isCell && Array.from(el.children).some(c => c.tagName.toLowerCase() !== 'svg')) return;
  const raw = ownText(el);
  if (!raw.trim() || raw.length > 60) { if (el.hasAttribute('data-term')) el.removeAttribute('data-term'); return; }
  const module = el.closest('[data-module]')?.getAttribute('data-module') ?? null;
  const entry = lookupTerm(raw, module);
  if (entry) {
    el.setAttribute('data-term', raw.replace(/\s+/g, ' ').trim());
    el.setAttribute('aria-description', `${entry.title}. ${entry.def}`);
  } else if (el.hasAttribute('data-term')) {
    el.removeAttribute('data-term');
    el.removeAttribute('aria-description');
  }
}

function scan(root: Element) {
  tag(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n = walker.nextNode();
  while (n) { tag(n as Element); n = walker.nextNode(); }
}

export function GlossaryLayer() {
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    const pending = new Set<Element>();
    let frame = 0;
    const flush = () => {
      frame = 0;
      pending.forEach(el => { if (el.isConnected) scan(el); });
      pending.clear();
    };
    const queue = (el: Element | null) => {
      if (!el) return;
      pending.add(el);
      if (!frame) frame = window.setTimeout(flush, 40);
    };
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'characterData') queue(m.target.parentElement);
        else m.addedNodes.forEach(n => { if (n.nodeType === 1) queue(n as Element); else if (n.nodeType === 3) queue(n.parentElement); });
      }
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    queue(root);

    // ---- one shared tooltip ----
    const tip = document.createElement('div');
    tip.id = 'glossary-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    let current: Element | null = null;
    let timer = 0;

    const hide = () => {
      window.clearTimeout(timer);
      tip.hidden = true;
      current?.removeAttribute('aria-describedby');
      current = null;
    };
    const show = (el: Element) => {
      const module = el.closest('[data-module]')?.getAttribute('data-module') ?? null;
      const entry = lookupTerm(el.getAttribute('data-term') ?? '', module);
      if (!entry) return;
      current = el;
      el.setAttribute('aria-describedby', 'glossary-tip');
      tip.innerHTML = '';
      const h = document.createElement('div'); h.className = 'gt-title'; h.textContent = entry.title;
      const d = document.createElement('div'); d.className = 'gt-def'; d.textContent = entry.def;
      tip.append(h, d);
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
      let top = r.bottom + 8;
      if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };
    const target = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-term]') : null);

    const over = (e: MouseEvent) => {
      const el = target(e);
      if (el === current) return;
      window.clearTimeout(timer);
      if (!el) { hide(); return; }
      timer = window.setTimeout(() => show(el), 180);
    };
    const out = (e: MouseEvent) => {
      const el = target(e);
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide();
    };
    const focus = (e: FocusEvent) => { const el = target(e); if (el) show(el); };
    const click = (e: MouseEvent) => {
      if (!window.matchMedia('(pointer: coarse)').matches) return;
      const el = target(e);
      if (el && el !== current) show(el); else hide();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };

    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('click', click);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('hashchange', hide);
    return () => {
      obs.disconnect();
      window.clearTimeout(frame);
      window.clearTimeout(timer);
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mouseout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('click', click);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('hashchange', hide);
      tip.remove();
    };
  }, []);
  return null;
}
