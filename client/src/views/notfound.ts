import type { View } from '../app.ts';
import { h } from '../dom.ts';
import { routeHref } from '../format.ts';
import { emptyState } from '../ui.ts';

/** Unknown route (old or mistyped link). */
export function notFoundView(): View {
  return {
    el: h(
      'div',
      { class: 'page page-notfound' },
      emptyState(
        'Page introuvable',
        'Ce lien ne mène nulle part : il est peut-être ancien ou incomplet.',
        h(
          'div',
          { class: 'empty-actions' },
          h('a', { class: 'btn btn-primary', href: routeHref('home') }, 'Accueil'),
          h('a', { class: 'btn btn-ghost', href: routeHref('discover') }, 'Découvrir')
        )
      )
    ),
  };
}
