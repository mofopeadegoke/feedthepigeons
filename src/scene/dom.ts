export function injectStyle(id: string, css: string) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

/** Overlays and the canvas are absolutely positioned, so the container must be their containing block. */
export function ensurePositioned(container: HTMLElement) {
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
}
