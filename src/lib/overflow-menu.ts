// Small popover menu anchored to a button (the phone header's ⋯).
// Closes on Escape, outside tap, or choosing an item.

import { el } from './render.js';

export interface OverflowItem {
  label: string | (() => string);
  onSelect?: () => void;          // omitted = display-only row
  hidden?: () => boolean;
}

export function overflowMenu(button: HTMLElement, items: OverflowItem[]): { refresh(): void; close(): void } {
  const menu = el('div', { class: 'overflow-menu', role: 'menu', hidden: true });
  document.body.appendChild(menu);

  const render = () => {
    menu.replaceChildren(...items
      .filter((it) => !(it.hidden && it.hidden()))
      .map((it) => {
        const label = typeof it.label === 'function' ? it.label() : it.label;
        if (!it.onSelect) return el('div', { class: 'overflow-menu__info' }, label);
        return el('button', {
          type: 'button', class: 'overflow-menu__item', role: 'menuitem',
          onclick: () => { close(); it.onSelect!(); },
        }, label);
      }));
  };

  const onDocDown = (ev: Event) => {
    const t = ev.target as Node;
    if (!menu.contains(t) && !button.contains(t)) close();
  };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };

  function open(): void {
    render();
    const r = button.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey);
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey);
  }

  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => (menu.hidden ? open() : close()));

  return { refresh: () => { if (!menu.hidden) render(); }, close };
}
