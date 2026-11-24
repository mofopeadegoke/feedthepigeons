import { ensurePositioned, injectStyle } from './dom';
import { PIGEON_SVG } from './loading';

const CSS = `
.ftp-fallback {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  background: radial-gradient(120% 90% at 50% 20%, #f1e6d2 0%, #e2d2b8 60%, #cdbb9c 100%);
  color: #4f453b;
  font: 500 15px/1.45 ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
}
.ftp-fallback__scene {
  position: relative; flex: 1; min-height: 0; width: 100%;
  margin: 0; padding: 0; border: 0; background: transparent;
  cursor: pointer; overflow: hidden; color: inherit; font: inherit;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ftp-fallback__scene img {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block;
}
.ftp-fallback__scene svg {
  position: absolute; left: 50%; top: 52%; width: min(28vw, 150px); transform: translate(-50%, -50%);
  opacity: 0.85;
}
.ftp-fallback__scene:focus { outline: none; }
.ftp-fallback__scene:focus-visible { box-shadow: inset 0 0 0 4px #fffaf0, inset 0 0 0 7px #3b6b55; }
.ftp-fallback__note {
  margin: 0; padding: 14px 20px calc(14px + env(safe-area-inset-bottom));
  text-align: center; background: rgba(255, 250, 240, 0.86);
}
.ftp-crumb {
  position: absolute; width: 9px; height: 7px; margin: -3px 0 0 -4px;
  border-radius: 45% 55% 40% 60%;
  background: #d9a865; box-shadow: inset -1px -1px 0 rgba(120, 70, 20, 0.35);
  pointer-events: none;
}
`;

export function showFallback(container: HTMLElement, onToss: () => void): void {
  injectStyle('ftp-fallback-style', CSS);
  ensurePositioned(container);

  const root = document.createElement('div');
  root.className = 'ftp-fallback';

  const scene = document.createElement('button');
  scene.type = 'button';
  scene.className = 'ftp-fallback__scene';
  scene.setAttribute('aria-label', 'Toss a crumb to the pigeons');

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  // Without the snapshot, the warm gradient and a drawn pigeon still make a pleasant place to tap.
  img.addEventListener('error', () => {
    img.remove();
    scene.insertAdjacentHTML('afterbegin', PIGEON_SVG);
  });
  img.src = `${import.meta.env.BASE_URL}fallback.jpg`;
  scene.appendChild(img);

  const note = document.createElement('p');
  note.className = 'ftp-fallback__note';
  note.textContent = "Your browser can't draw the live park, but your crumbs still count.";

  root.append(scene, note);
  container.appendChild(root);

  scene.addEventListener('click', (e) => {
    const rect = scene.getBoundingClientRect();
    // Keyboard activation has no pointer position (detail 0), so toss from the bottom centre.
    const fromKeyboard = e.detail === 0;
    const x = fromKeyboard ? rect.width / 2 : e.clientX - rect.left;
    const y = fromKeyboard ? rect.height * 0.62 : e.clientY - rect.top;
    tossFlourish(scene, x, y, rect.height);
    onToss();
  });
}

function tossFlourish(host: HTMLElement, x: number, y: number, height: number) {
  const crumb = document.createElement('span');
  crumb.className = 'ftp-crumb';
  crumb.style.left = `${x}px`;
  crumb.style.top = `${y}px`;
  host.appendChild(crumb);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drift = (Math.random() - 0.5) * 60;
  const rise = Math.min(90, height * 0.18);
  const keyframes: Keyframe[] = reduced
    ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }]
    : [
        { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
        { transform: `translate(${drift * 0.6}px, ${-rise}px) rotate(160deg) scale(1)`, opacity: 1, offset: 0.45, easing: 'cubic-bezier(.4,0,1,1)' },
        { transform: `translate(${drift}px, ${rise * 0.25}px) rotate(300deg) scale(0.8)`, opacity: 0.9, offset: 0.85 },
        { transform: `translate(${drift}px, ${rise * 0.25}px) rotate(300deg) scale(0.6)`, opacity: 0 },
      ];
  const anim = crumb.animate(keyframes, { duration: reduced ? 500 : 760, easing: 'cubic-bezier(0,.55,.45,1)' });
  anim.onfinish = () => crumb.remove();
}
