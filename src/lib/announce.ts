/** ARIA live-region announcer (step changes, results). */
let region: HTMLElement | null = null;
export function announce(msg: string): void {
  if (typeof document === 'undefined') return;
  if (!region) {
    region = document.getElementById('sr-live');
    if (!region) {
      region = document.createElement('div');
      region.id = 'sr-live';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('role', 'status');
      region.className = 'sr-only';
      document.body.appendChild(region);
    }
  }
  region.textContent = '';
  window.setTimeout(() => { if (region) region.textContent = msg; }, 30);
}
