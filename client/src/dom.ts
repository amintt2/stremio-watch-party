type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;
type Child = Node | string | null | undefined | false;

/** Tiny element builder: h('button', { class: 'btn', onclick }, 'Play'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function clear(el: Element, ...children: (Child | Child[])[]) {
  el.replaceChildren();
  for (const child of children.flat()) if (child) el.append(child);
}

export function toast(text: string) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: 'toast', role: 'status' }, text);
  host.append(el);
  setTimeout(() => el.classList.add('out'), 4500);
  setTimeout(() => el.remove(), 5000);
}
