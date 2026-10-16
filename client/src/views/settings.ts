import { api, type UserAddon } from '../api.ts';
import type { App, View } from '../app.ts';
import { localStorageGet, localStorageSet } from '../auth.ts';
import { clear, h, toast } from '../dom.ts';
import { avatar, icon } from '../ui.ts';

export type Theme = 'dark' | 'light' | 'auto';
const THEME_KEY = 'wp-theme';

export function savedTheme(): Theme {
  const t = localStorageGet(THEME_KEY);
  return t === 'light' || t === 'auto' ? t : 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

function section(title: string, ...children: (HTMLElement | null)[]) {
  return h('section', { class: 'settings-section' }, h('h2', {}, title), ...children);
}

function field(label: string, control: HTMLElement, hint?: string) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function settingsView(app: App): View {
  const { me, mode, room, player } = app;

  // ---- account
  const modeText = { discord: 'Connecté via Discord (Activité)', web: 'Connecté avec Discord', guest: 'Invité · mode test local' }[mode];
  const logout =
    mode === 'web'
      ? h(
          'button',
          {
            class: 'btn btn-ghost',
            type: 'button',
            onclick: async () => {
              await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
              location.href = '/';
            },
          },
          icon('logout'),
          'Se déconnecter'
        )
      : null;
  const account = section(
    'Compte',
    h('div', { class: 'account' }, avatar(me, 'avatar avatar-lg'), h('div', {}, h('strong', {}, me.name), h('p', { class: 'muted' }, modeText)), logout)
  );

  // ---- room
  let roomSection: HTMLElement;
  if (mode === 'discord') {
    roomSection = section('Salle', h('p', { class: 'muted' }, 'Tu regardes avec les personnes qui ont rejoint cette Activité Discord.'));
  } else {
    const link = `${location.origin}/?room=${room?.code || ''}`;
    const codeInput = h('input', { class: 'input', placeholder: 'Code de salle', 'aria-label': 'Code de salle', maxlength: 64, autocomplete: 'off' });
    const join = h(
      'form',
      {
        class: 'inline-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const raw = codeInput.value.trim();
          const code = /[?&]room=([\w-]+)/.exec(raw)?.[1] || raw;
          if (!/^[\w-]{3,64}$/.test(code)) return toast('Code invalide');
          location.href = `/?room=${encodeURIComponent(code.toLowerCase())}`;
        },
      },
      codeInput,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Rejoindre')
    );
    roomSection = section(
      'Salle',
      h(
        'p',
        { class: 'muted' },
        mode === 'guest'
          ? 'Salle de test : ouvre le même lien avec un autre pseudo pour regarder ensemble.'
          : room?.personal
            ? 'Tu es dans ta salle perso. Envoie le lien à tes amis pour regarder ensemble.'
            : 'Tu as rejoint la salle de quelqu’un. Tout le monde ici voit la même chose.'
      ),
      h(
        'div',
        { class: 'room-code' },
        h('code', {}, room?.code || '—'),
        h(
          'button',
          {
            class: 'btn btn-secondary btn-sm',
            type: 'button',
            onclick: () =>
              navigator.clipboard
                .writeText(link)
                .then(() => toast('Lien copié'))
                .catch(() => toast(link)),
          },
          icon('link', 'icon icon-sm'),
          'Copier le lien'
        ),
        room && !room.personal && mode === 'web' ? h('a', { class: 'btn btn-ghost btn-sm', href: '/' }, 'Revenir à ma salle') : null
      ),
      field('Rejoindre une salle', join, 'Colle le code ou le lien reçu.')
    );
  }

  // ---- appearance & playback
  const themeSel = h(
    'select',
    {
      class: 'input',
      onchange: (e: Event) => {
        const t = (e.currentTarget as HTMLSelectElement).value as Theme;
        localStorageSet(THEME_KEY, t);
        applyTheme(t);
      },
    },
    h('option', { value: 'dark' }, 'Sombre'),
    h('option', { value: 'light' }, 'Clair'),
    h('option', { value: 'auto' }, 'Comme le système')
  );
  themeSel.value = savedTheme();

  const qualitySel = h(
    'select',
    { class: 'input', onchange: (e: Event) => player.setPreference((e.currentTarget as HTMLSelectElement).value) },
    h('option', { value: 'auto' }, 'Auto (selon ta connexion)'),
    [
      ['2160', '4K'],
      ['1080', '1080p'],
      ['720', '720p'],
      ['480', '480p'],
    ].map(([v, t]) => h('option', { value: v }, t))
  );
  qualitySel.value = player.preference;

  // ---- personal stream addons
  const addonList = h('div', { class: 'addon-list' });
  const renderAddons = (items: UserAddon[], shared: number | null) => {
    clear(
      addonList,
      shared !== null ? h('p', { class: 'muted small' }, `${shared} addon(s) partagé(s) par le serveur + les tiens :`) : null,
      items.length
        ? items.map((a) =>
            h(
              'div',
              { class: 'addon' },
              h('div', {}, h('strong', {}, a.name), h('code', { class: 'faint small' }, a.url)),
              h(
                'button',
                {
                  class: 'btn btn-ghost btn-icon',
                  type: 'button',
                  'aria-label': `Supprimer ${a.name}`,
                  onclick: async () => {
                    await api(`/api/addons/${encodeURIComponent(a.id)}`, { method: 'DELETE' }).catch((err: Error) => toast(err.message));
                    loadAddons();
                  },
                },
                icon('trash')
              )
            )
          )
        : h('p', { class: 'faint small' }, 'Aucun addon perso.')
    );
  };
  const loadAddons = () =>
    api<{ items: UserAddon[]; shared: number }>('/api/addons')
      .then((r) => renderAddons(r.items, r.shared))
      .catch((err: Error) => clear(addonList, h('p', { class: 'auth-error' }, err.message)));
  const addonInput = h('input', {
    class: 'input',
    type: 'url',
    placeholder: 'https://…/manifest.json',
    'aria-label': "URL de l'addon",
    autocomplete: 'off',
  });
  const addonForm = h(
    'form',
    {
      class: 'inline-form',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const btn = addonForm.querySelector('button')!;
        btn.disabled = true;
        try {
          const r = await api<{ items: UserAddon[] }>('/api/addons', { method: 'POST', body: JSON.stringify({ url: addonInput.value }) });
          addonInput.value = '';
          renderAddons(r.items, null);
          loadAddons();
          toast('Addon ajouté');
        } catch (err) {
          toast((err as Error).message);
        } finally {
          btn.disabled = false;
        }
      },
    },
    addonInput,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Ajouter')
  );
  loadAddons();

  const el = h(
    'div',
    { class: 'page page-settings' },
    h('h1', { class: 'page-title' }, 'Paramètres'),
    account,
    roomSection,
    section('Apparence', field('Thème', themeSel)),
    section('Lecture', field('Qualité par défaut', qualitySel, 'Auto choisit selon la vitesse de ta connexion, pendant la lecture.')),
    section(
      'Mes addons de sources',
      h(
        'p',
        { class: 'muted' },
        'Ajoute ta propre config (ex. Torrentio avec ta clé débrid). Elle reste sur le serveur : personne, pas même toi, ne revoit l’URL complète ici.'
      ),
      addonList,
      addonForm
    )
  );
  return { el };
}
