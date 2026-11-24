import type { LoadingScreen } from '../contracts';
import { ensurePositioned, injectStyle } from './dom';

const CSS = `
.ftp-loading {
  position: absolute; inset: 0; z-index: 20;
  display: grid; place-items: center; align-content: center; gap: 14px;
  background: #e9dcc6;
  color: #6b5f52;
  font: 500 15px/1.4 ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
  letter-spacing: 0.01em;
  transition: opacity 650ms cubic-bezier(.4,0,.2,1);
}
.ftp-loading[data-leaving] { opacity: 0; }
.ftp-loading svg { width: 88px; height: auto; overflow: visible; }
.ftp-loading .ftp-pigeon-head { animation: ftp-head 0.62s infinite; transform-box: view-box; }
.ftp-loading .ftp-pigeon-body { animation: ftp-body 0.62s infinite ease-in-out; transform-box: view-box; }
.ftp-loading .ftp-leg-a { animation: ftp-leg 0.62s infinite ease-in-out; transform-origin: 56px 70px; transform-box: view-box; }
.ftp-loading .ftp-leg-b { animation: ftp-leg 0.62s infinite ease-in-out reverse; transform-origin: 64px 70px; transform-box: view-box; }
/* A pigeon's head snaps forward, then holds still in space while the body catches up. */
@keyframes ftp-head {
  0%   { transform: translateX(-2.5px); animation-timing-function: cubic-bezier(.2,.8,.3,1); }
  22%  { transform: translateX(4px);    animation-timing-function: linear; }
  100% { transform: translateX(-2.5px); }
}
@keyframes ftp-body {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-1.2px); }
}
@keyframes ftp-leg {
  0%, 100% { transform: rotate(-12deg); }
  50%      { transform: rotate(12deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ftp-loading .ftp-pigeon-head, .ftp-loading .ftp-pigeon-body,
  .ftp-loading .ftp-leg-a, .ftp-loading .ftp-leg-b { animation: none; }
  .ftp-loading { transition-duration: 200ms; }
}
`;

/** Hand-drawn side-on rock pigeon, facing right. Shared with the fallback screen. */
export const PIGEON_SVG = `
<svg viewBox="0 0 120 90" aria-hidden="true" focusable="false">
  <ellipse cx="60" cy="84" rx="30" ry="2.6" fill="#000" opacity="0.08"/>
  <g class="ftp-leg-a" stroke="#a5675e" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M56 68 L55 81 M55 81 L50 82.5 M55 81 L60 82.5"/>
  </g>
  <g class="ftp-leg-b" stroke="#b9776c" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M64 68 L65 81 M65 81 L60 82.5 M65 81 L70 82.5"/>
  </g>
  <g class="ftp-pigeon-body">
    <path fill="#6d6a74" d="M6 55 L28 45 C38 31 62 27 77 35 C86 40 90 51 85 60
      C78 70 56 74 40 68 C33 66 28 63 24 61 Z"/>
    <path fill="#5a5762" d="M32 47 C44 38 62 37 72 45 C64 50 50 54 34 55 Z"/>
    <path fill="#4f4c56" d="M6 55 L22 50 L25 59 Z"/>
    <path fill="none" stroke="#3f3c45" stroke-width="1.6" stroke-linecap="round" d="M44 48 C50 50 56 50 62 48 M47 53 C53 55 59 54 64 52"/>
  </g>
  <g class="ftp-pigeon-head">
    <path fill="#6d6a74" d="M74 36 C78 30 80 24 85 20 L92 26 C90 33 88 40 86 46 Z"/>
    <path fill="#7f8f84" d="M78 36 C80 33 84 32 88 34 C88 39 86 43 84 46 C81 43 79 40 78 36 Z" opacity="0.75"/>
    <circle cx="88" cy="20" r="8.5" fill="#6d6a74"/>
    <path fill="#3d3a40" d="M95.5 18.5 L103 20.8 L95.5 22.6 Z"/>
    <circle cx="95.4" cy="18.6" r="1.4" fill="#e8e3da"/>
    <circle cx="90.6" cy="17.6" r="2" fill="#e0884a"/>
    <circle cx="90.8" cy="17.5" r="1" fill="#1d1b1f"/>
  </g>
</svg>`;

export function showLoading(container: HTMLElement): LoadingScreen {
  injectStyle('ftp-loading-style', CSS);
  ensurePositioned(container);
  const el = document.createElement('div');
  el.className = 'ftp-loading';
  el.setAttribute('role', 'status');
  el.innerHTML = `${PIGEON_SVG}<span>Finding a bench…</span>`;
  container.appendChild(el);

  let finished: Promise<void> | null = null;
  return {
    done() {
      if (finished) return finished;
      finished = new Promise<void>((resolve) => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const remove = () => {
          el.remove();
          resolve();
        };
        // Let the first frame of the park paint under the overlay before it fades.
        requestAnimationFrame(() => {
          el.setAttribute('data-leaving', '');
          el.addEventListener('transitionend', remove, { once: true });
          // transitionend never fires if styles were blocked or the element was hidden.
          setTimeout(remove, reduced ? 400 : 900);
        });
      });
      return finished;
    },
  };
}
