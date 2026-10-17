// Subtitle style controls, shared by the settings page and the player's menu, and a
// live preview. Every change applies at once everywhere (see substyle.ts).
import { h } from './dom.ts';
import {
  BACKGROUNDS,
  BG_OPACITIES,
  FONTS,
  OUTLINE_COLORS,
  OUTLINE_LEVELS,
  POSITION_LEVELS,
  SHADOW_LEVELS,
  SIZE_LEVELS,
  TEXT_COLORS,
  applyStyleVars,
  onSubtitleStyle,
  resetSubtitleStyle,
  setSubtitleStyle,
  styleVars,
  subtitleStyle,
  type SubStyle,
} from './substyle.ts';

type Option<T> = { value: T; label: string; title?: string; style?: string };

function segmented<T>(label: string, options: Option<T>[], value: T, onPick: (v: T) => void, media: boolean) {
  return h(
    'div',
    { class: `segmented segmented-wrap${media ? ' segmented-media' : ''}`, role: 'radiogroup', 'aria-label': label },
    options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': String(o.value === value),
          class: o.value === value ? 'active' : '',
          title: o.title || '',
          style: o.style || '',
          onclick: () => onPick(o.value),
        },
        o.label
      )
    )
  );
}

function swatches(label: string, colors: { label: string; value: string }[], value: string, onPick: (v: string) => void) {
  return h(
    'div',
    { class: 'swatches', role: 'radiogroup', 'aria-label': label },
    colors.map((c) =>
      h('button', {
        type: 'button',
        role: 'radio',
        class: `swatch${c.value.toLowerCase() === value.toLowerCase() ? ' active' : ''}`,
        'aria-checked': String(c.value.toLowerCase() === value.toLowerCase()),
        'aria-label': c.label,
        title: c.label,
        style: `--swatch: ${c.value}`,
        onclick: () => onPick(c.value),
      })
    )
  );
}

function row(title: string, ...controls: (Node | null)[]) {
  return h('div', { class: 'substyle-row' }, h('span', { class: 'substyle-label' }, title), h('div', { class: 'substyle-controls' }, ...controls));
}

/**
 * Every style setting. `media`: drawn on the dark player menu. `compact`: the
 * essentials only (the player menu), the rest in Paramètres.
 */
export function subtitleStyleControls({ media = false, compact = false } = {}) {
  const root = h('div', { class: `substyle${compact ? ' substyle-compact' : ''}` });
  const set = (patch: Partial<SubStyle>) => setSubtitleStyle(patch);
  const idx = (list: { label: string; short?: string }[], short = false) =>
    list.map((l, i) => ({ value: i, label: short && l.short ? l.short : l.label, title: l.label }));

  const render = (s: SubStyle) => {
    const children: (Node | null)[] = [
      row(
        'Police',
        segmented(
          'Police',
          FONTS.map((f) => ({ value: f.id, label: f.label, title: f.hint, style: `font-family: ${f.family}; font-weight: ${f.weights[1]}` })),
          s.font,
          (font) => set({ font }),
          media
        )
      ),
      row('Taille', segmented('Taille', idx(SIZE_LEVELS, compact), s.size, (size) => set({ size }), media)),
      row('Couleur', swatches('Couleur du texte', TEXT_COLORS, s.color, (color) => set({ color }))),
      row(
        'Contour',
        segmented('Contour', idx(OUTLINE_LEVELS), s.outline, (outline) => set({ outline }), media),
        !compact && s.outline > 0 ? swatches('Couleur du contour', OUTLINE_COLORS, s.outlineColor, (outlineColor) => set({ outlineColor })) : null
      ),
      compact ? null : row('Ombre', segmented('Ombre', idx(SHADOW_LEVELS), s.shadow, (shadow) => set({ shadow }), media)),
      row(
        'Fond',
        segmented('Fond', BACKGROUNDS.map((b) => ({ value: b.id, label: b.label })), s.background, (background) => set({ background }), media),
        !compact && s.background !== 'none'
          ? segmented('Opacité du fond', BG_OPACITIES.map((o) => ({ value: o, label: `${Math.round(o * 100)} %` })), s.bgOpacity, (bgOpacity) => set({ bgOpacity }), media)
          : null
      ),
      row('Position', segmented('Position', idx(POSITION_LEVELS), s.position, (position) => set({ position }), media)),
      row(
        'Gras',
        segmented(
          'Gras',
          [
            { value: true, label: 'Oui' },
            { value: false, label: 'Non' },
          ],
          s.bold,
          (bold) => set({ bold }),
          media
        )
      ),
      compact
        ? null
        : h('div', { class: 'settings-actions' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => resetSubtitleStyle() }, 'Style par défaut')),
    ];
    root.replaceChildren(...children.filter((c): c is Node => !!c));
  };
  render(subtitleStyle());
  // Menus are rebuilt often: a removed copy stops listening at the next change.
  const off = onSubtitleStyle((st) => (root.isConnected ? render(st) : off()));
  return root;
}

/** A still "scene" with two sample lines, styled live like the player. */
export function subtitlePreview() {
  const lines = h(
    'div',
    { class: 'subs subs-preview-lines' },
    h('span', { class: 'subs-cue' }, 'Tu crois qu’on arrivera à temps ?'),
    h('span', { class: 'subs-cue' }, h('i', {}, '— On n’a pas le choix.'))
  );
  const box = h('div', { class: 'subs-preview', 'aria-hidden': 'true' }, lines);
  const apply = () => {
    const height = box.clientHeight || 220;
    applyStyleVars(box, styleVars(subtitleStyle(), height, height));
  };
  const off = onSubtitleStyle(() => (box.isConnected ? apply() : off()));
  new ResizeObserver(apply).observe(box);
  apply();
  return box;
}
