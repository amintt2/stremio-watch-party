import { api, type UserAddon } from '../api.ts';
import type { App, View } from '../app.ts';
import { localStorageGet, localStorageRemove, localStorageSet } from '../auth.ts';
import { clear, h, toast } from '../dom.ts';
import { languageName } from '../format.ts';
import { avatar, confirmButton, copyText, icon, legalFooter } from '../ui.ts';

export type Theme = 'dark' | 'light' | 'auto';
const THEME_KEY = 'wp-theme';
// Same keys as player.ts (quality, audio language) and subtitles.ts (subtitle language).
const QUALITY_KEY = 'wp-quality';
const AUDIO_KEY = 'wp-audio';
const SUBS_KEY = 'wp-subs';
/** Subtitle languages offered by default (others can be picked in the player). */
const SUB_LANGS = ['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'ar', 'tr', 'pl', 'ru', 'ja', 'ko', 'zh'];

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
            onclick: () => copyText(link, 'Lien copié'),
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

  // Audio language: the player picks the French track ("fr") or the original one ("vo")
  // when a file has several; empty = the file's default track.
  const audioSel = h(
    'select',
    {
      class: 'input',
      onchange: (e: Event) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        if (v) localStorageSet(AUDIO_KEY, v);
        else localStorageRemove(AUDIO_KEY);
        player.audioPref = v || null;
        toast('Langue audio enregistrée');
      },
    },
    h('option', { value: '' }, 'Piste par défaut du fichier'),
    h('option', { value: 'fr' }, 'Français (VF) si disponible'),
    h('option', { value: 'vo' }, 'Version originale (VO)')
  );
  audioSel.value = localStorageGet(AUDIO_KEY) === 'fr' || localStorageGet(AUDIO_KEY) === 'vo' ? localStorageGet(AUDIO_KEY)! : '';

  const savedSubs = localStorageGet(SUBS_KEY) || '';
  const subsSel = h(
    'select',
    {
      class: 'input',
      onchange: (e: Event) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        if (v) localStorageSet(SUBS_KEY, v);
        else localStorageRemove(SUBS_KEY);
        toast(v ? `Sous-titres en ${languageName(v).toLowerCase()} par défaut` : 'Pas de sous-titres par défaut');
      },
    },
    h('option', { value: '' }, 'Aucun'),
    [...new Set([...SUB_LANGS, ...(savedSubs ? [savedSubs] : [])])].map((code) => h('option', { value: code }, languageName(code)))
  );
  subsSel.value = savedSubs;

  const resetPrefs = confirmButton(
    { class: 'btn btn-ghost btn-sm', label: 'Réinitialiser les préférences', confirmLabel: 'Réinitialiser ? Clique encore', icon: 'reset' },
    () => {
      for (const key of [THEME_KEY, QUALITY_KEY, AUDIO_KEY, SUBS_KEY]) localStorageRemove(key);
      applyTheme(savedTheme());
      player.setPreference('auto');
      localStorageRemove(QUALITY_KEY);
      player.audioPref = null;
      themeSel.value = savedTheme();
      qualitySel.value = 'auto';
      audioSel.value = '';
      subsSel.value = '';
      toast('Préférences réinitialisées');
    }
  );

  // ---- my data
  const exportBtn = h(
    'button',
    {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        try {
          const data = await api<unknown>('/api/me/export');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = h('a', { href: url, download: `watch-party-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          toast(mode === 'discord' ? 'Export prêt (si rien ne se télécharge, ouvre le site dans un navigateur)' : 'Export téléchargé');
        } catch (err) {
          toast((err as Error).message);
        } finally {
          b.disabled = false;
        }
      },
    },
    icon('download', 'icon icon-sm'),
    'Exporter mes données'
  );
  const clearHistoryBtn = confirmButton(
    { class: 'btn btn-ghost btn-sm btn-danger', label: 'Effacer l’historique', confirmLabel: 'Effacer tout l’historique ? Clique encore', icon: 'history' },
    async () => {
      const r = await api<{ count: number }>('/api/history', { method: 'DELETE' });
      toast(r.count ? 'Historique effacé' : 'Historique déjà vide');
    }
  );
  const eraseBtn = confirmButton(
    { class: 'btn btn-ghost btn-sm btn-danger', label: 'Supprimer toutes mes données', confirmLabel: 'Tout supprimer ? Clique encore', icon: 'trash' },
    async () => {
      await api('/api/me/data', { method: 'DELETE' });
      toast('Historique, bibliothèque et addons perso supprimés');
      loadAddons();
    }
  );

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
              confirmButton(
                { class: 'btn btn-ghost btn-sm', label: 'Supprimer', confirmLabel: 'Confirmer ?', icon: 'trash', title: `Supprimer ${a.name}` },
                async () => {
                  await api(`/api/addons/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
                  toast(`${a.name} supprimé`);
                  loadAddons();
                }
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
    section(
      'Lecture',
      h('p', { class: 'muted small' }, 'Ces choix sont propres à cet appareil, et chacun a les siens dans la salle.'),
      field('Qualité par défaut', qualitySel, 'Auto choisit selon la vitesse de ta connexion, pendant la lecture.'),
      field('Langue audio', audioSel, 'Quand un fichier a plusieurs pistes (MULTI). Changer de piste dans le lecteur met aussi à jour ce choix.'),
      field('Sous-titres par défaut', subsSel, 'Chargés automatiquement quand ils existent dans cette langue.'),
      h('div', { class: 'settings-actions' }, resetPrefs)
    ),
    section(
      'Mes addons de sources',
      h(
        'p',
        { class: 'muted' },
        'Ajoute ta propre config (ex. Torrentio avec ta clé débrid). Elle reste sur le serveur : personne, pas même toi, ne revoit l’URL complète ici.'
      ),
      addonList,
      addonForm
    ),
    section(
      'Mes données',
      h(
        'p',
        { class: 'muted' },
        'Ta progression, ton historique, ta bibliothèque et tes addons perso sont liés à ton compte. Tu peux les récupérer ou les effacer.'
      ),
      h('div', { class: 'settings-actions' }, exportBtn, clearHistoryBtn, eraseBtn),
      h('p', { class: 'field-hint' }, 'La suppression est définitive. Ton compte reste (il sert à te connecter).')
    ),
    section(
      'Raccourcis clavier',
      h(
        'dl',
        { class: 'shortcuts' },
        [
          ['/', 'Rechercher'],
          ['Échap', 'Vider la recherche · réduire le lecteur'],
          ['Espace ou K', 'Lecture / pause (lecteur)'],
          ['← →', 'Reculer / avancer de 10 s (lecteur)'],
        ].flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)])
      )
    ),
    legalFooter()
  );
  return { el };
}
