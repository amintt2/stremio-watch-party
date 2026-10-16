// Terms of Service and Privacy Policy pages (Discord requires both URLs for apps).
// Rendered server-side so the operator name/contact come from the environment.

import { config } from './config.js';

export const LEGAL_UPDATED = '16 octobre 2026';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Contact as a link when it is an email or a URL, plain text otherwise. */
export function contactHtml(contact) {
  const c = String(contact || '').trim();
  if (!c) return 'les administrateurs de la communauté (via le serveur Discord où l’application est utilisée)';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return `<a href="mailto:${escapeHtml(c)}">${escapeHtml(c)}</a>`;
  if (/^https:\/\/\S+$/.test(c)) return `<a href="${escapeHtml(c)}" rel="noopener">${escapeHtml(c)}</a>`;
  return escapeHtml(c);
}

function page(title, body) {
  const app = escapeHtml(config.legal.appName);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${app}</title>
<style>
  :root {
    --bg: #0b0b0c; --bg-2: #151517; --text: #f2f2f3; --text-muted: #a3a3aa;
    --border: #2a2a2e; --accent: #f2f2f3; --radius: 10px;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --bg-2: #ffffff; --text: #111113; --text-muted: #5b5b63;
      --border: #e4e4e8; --accent: #111113; color-scheme: light; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
    border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 24px; }
  header strong { font-size: 17px; }
  nav a { margin-right: 14px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 28px 0 8px; }
  p, li { color: var(--text); }
  .muted { color: var(--text-muted); }
  a { color: var(--accent); }
  ul { padding-left: 20px; }
  .box { background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; }
</style>
</head>
<body>
<main>
<header><strong>${app}</strong><nav><a href="/conditions">Conditions d’utilisation</a><a href="/confidentialite">Confidentialité</a></nav></header>
<h1>${escapeHtml(title)}</h1>
<p class="muted">Dernière mise à jour : ${LEGAL_UPDATED}</p>
${body}
</main>
</body>
</html>`;
}

export function termsPage() {
  const app = escapeHtml(config.legal.appName);
  const operator = escapeHtml(config.legal.operator);
  const contact = contactHtml(config.legal.contact);
  return page(
    'Conditions d’utilisation',
    `
<p>Les présentes conditions encadrent l’utilisation de <strong>${app}</strong>, une Activité Discord et un site web
permettant à un groupe de personnes de regarder une vidéo ensemble, de façon synchronisée. Le service est exploité par
${operator}. En utilisant ${app}, tu acceptes ces conditions.</p>

<h2>1. Le service</h2>
<p>${app} synchronise la lecture (lecture, pause, position) entre les participants d’une même session et adapte la
qualité de la vidéo à chacun. Les titres et les sources proposés proviennent d’<strong>extensions tierces</strong>
(addons au format Stremio) configurées par l’exploitant ou par les utilisateurs. ${app} ne produit, ne publie et ne
fournit aucun catalogue de contenu, et ne contrôle pas ce que ces extensions référencent.</p>

<h2>2. Accès</h2>
<ul>
  <li>L’accès se fait avec ton compte Discord. Tu dois respecter les
    <a href="https://discord.com/terms" rel="noopener">Conditions d’utilisation de Discord</a> et ses
    <a href="https://discord.com/guidelines" rel="noopener">Règles de la communauté</a>, notamment l’âge minimum requis.</li>
  <li>Le service est destiné à un usage <strong>privé et non commercial</strong> au sein de la communauté.</li>
</ul>

<h2>3. Tes responsabilités</h2>
<ul>
  <li>Tu es seul responsable des contenus que tu lances ou proposes pendant une session, et du respect des lois de ton
    pays, en particulier du <strong>droit d’auteur</strong>. Ne lance que des contenus que tu as le droit de regarder et
    de partager.</li>
  <li>Il est interdit d’utiliser ${app} pour diffuser des contenus illégaux, haineux, à caractère sexuel impliquant
    des mineurs, ou portant atteinte aux droits d’autrui ; pour perturber le service (surcharge, contournement des
    limites, accès non autorisé) ; ou pour harceler d’autres participants (y compris via le chat et les réactions).</li>
  <li>Les extensions que tu ajoutes, et les identifiants de services tiers que tu y enregistres (par exemple un
    compte de débridage), restent sous ta responsabilité et soumis aux conditions de ces services.</li>
</ul>

<h2>4. Signalement et retrait</h2>
<p>Pour signaler un contenu ou un usage contraire à ces conditions, ou une atteinte à tes droits, contacte ${contact}.
L’exploitant peut interrompre une session, retirer une extension ou suspendre l’accès d’un utilisateur en cas de
manquement.</p>

<h2>5. Disponibilité et responsabilité</h2>
<p>Le service est fourni « en l’état », gratuitement et sans garantie de disponibilité, de qualité ou de
continuité. Dans les limites permises par la loi, l’exploitant ne peut être tenu responsable des contenus fournis par
des extensions tierces, ni des dommages indirects liés à l’utilisation du service.</p>

<h2>6. Données personnelles</h2>
<p>Le traitement de tes données est décrit dans la <a href="/confidentialite">politique de confidentialité</a>.</p>

<h2>7. Modifications</h2>
<p>Ces conditions peuvent évoluer. La date de mise à jour figure en haut de la page ; continuer à utiliser le service
après une modification vaut acceptation de la nouvelle version.</p>

<h2>8. Droit applicable</h2>
<p>Ces conditions sont régies par le droit français, sous réserve des dispositions impératives du pays de résidence
de l’utilisateur.</p>
`
  );
}

export function privacyPage() {
  const app = escapeHtml(config.legal.appName);
  const operator = escapeHtml(config.legal.operator);
  const contact = contactHtml(config.legal.contact);
  return page(
    'Politique de confidentialité',
    `
<p>Cette politique explique quelles données <strong>${app}</strong> traite, pourquoi, et quels sont tes droits.
Le responsable du traitement est ${operator}, joignable via ${contact}.</p>

<h2>1. Données traitées</h2>
<ul>
  <li><strong>Compte Discord</strong> (via la connexion Discord, autorisation <code>identify</code>) : ton identifiant
    Discord, ton nom d’utilisateur ou nom affiché, et ton avatar. Nous ne recevons ni ton adresse e-mail, ni ton mot de
    passe, ni tes messages Discord.</li>
  <li><strong>Session de visionnage</strong> : la session Discord (instance de l’Activité) ou le code de salle,
    les participants présents, le titre en cours, la position de lecture, la qualité choisie par chacun, et, si ces
    fonctions sont utilisées, les messages de chat, réactions et propositions envoyés pendant la session.</li>
  <li><strong>Préférences et historique</strong>, lorsque ces fonctions sont disponibles : progression de visionnage,
    bibliothèque, historique, extensions ajoutées (les adresses d’extensions, qui peuvent contenir des clés de services
    tiers, sont conservées côté serveur et ne sont jamais affichées en entier).</li>
  <li><strong>Données techniques</strong> : adresse IP et informations de connexion nécessaires au fonctionnement et à
    la sécurité (journaux d’erreurs). Ton navigateur conserve localement quelques préférences (qualité, thème, langue audio et sous-titres, pseudo en mode test) et, sur
    le site web, un cookie de session nécessaire à la connexion.</li>
</ul>
<p>${app} n’utilise <strong>aucun cookie publicitaire ni outil de mesure d’audience</strong>, et ne vend ni ne loue
tes données.</p>

<h2>2. Finalités et bases légales</h2>
<ul>
  <li>Fournir le service (connexion, synchronisation, reprise de lecture) : exécution du service que tu demandes.</li>
  <li>Sécurité, prévention des abus et diagnostic technique : intérêt légitime de l’exploitant.</li>
</ul>

<h2>3. Durées de conservation</h2>
<ul>
  <li>État des sessions (participants, position, chat) : en mémoire uniquement, supprimé à la fin de la session ou au
    redémarrage du serveur.</li>
  <li>Jeton de session : 24 heures. Cookie de connexion du site web : 30 jours (ou jusqu’à la déconnexion).</li>
  <li>Compte, progression, bibliothèque, historique et extensions : tant que tu utilises le service ; supprimés sur
    simple demande.</li>
  <li>Journaux techniques : quelques semaines au maximum.</li>
</ul>

<h2>4. Destinataires et services tiers</h2>
<ul>
  <li><strong>Discord</strong>, pour l’authentification et l’affichage de l’Activité (voir la
    <a href="https://discord.com/privacy" rel="noopener">politique de confidentialité de Discord</a>).</li>
  <li><strong>L’hébergeur</strong> du serveur, qui exécute l’application.</li>
  <li><strong>Les extensions tierces</strong> (catalogue, sources, sous-titres) sont interrogées par le serveur avec
    l’identifiant du titre recherché ; tes données de compte ne leur sont pas transmises. Les images (affiches, avatars)
    sont chargées via le serveur.</li>
</ul>

<h2>5. Tes droits</h2>
<p>Conformément au RGPD, tu peux demander l’accès à tes données, leur rectification, leur suppression, leur
portabilité, ou t’opposer à leur traitement, en contactant ${contact}. Tu peux aussi retirer l’accès de l’application
à ton compte depuis Discord (Paramètres utilisateur → Applications autorisées). Si tu estimes que tes droits ne sont
pas respectés, tu peux saisir la <a href="https://www.cnil.fr/fr/plaintes" rel="noopener">CNIL</a>.</p>

<h2>6. Sécurité</h2>
<p>Les échanges passent en HTTPS, les jetons de session sont signés, et les clés de services tiers ne sont jamais
envoyées au navigateur.</p>

<h2>7. Mineurs</h2>
<p>Le service s’adresse aux personnes ayant l’âge minimum requis par Discord dans leur pays.</p>

<h2>8. Modifications</h2>
<p>Cette politique peut évoluer ; la date de mise à jour figure en haut de la page.</p>
`
  );
}
