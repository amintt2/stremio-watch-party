# Watch Party — Stremio dans une Activité Discord

Regarde un film ou une série **ensemble, synchronisés**, directement dans un salon vocal
Discord, comme l'activité YouTube. Les vidéos viennent de tes **addons Stremio**
(Torrentio, avec ou sans débrid, ou n'importe quel autre addon), et chaque ami reçoit une
**qualité adaptée** à sa connexion et à ce que son appareil sait décoder.

Contrairement au partage d'écran (Go Live), personne ne réencode son écran : chaque ami lit
le fichier depuis ton serveur, et seule la position de lecture est synchronisée.

L'interface ressemble à une app de streaming : barre de navigation à gauche (Accueil,
Découvrir, Bibliothèque, Historique, Paramètres), affiches partout, fiche détaillée avec
saisons et épisodes, et **un compte par personne** (son compte Discord) qui garde sa
progression, son historique et sa bibliothèque. Ça marche dans l'Activité Discord **et**
directement sur le site, dans un navigateur.

## Ce que tu peux faire

- **Accueil** : « Continuer à regarder » (avec ta progression ; sur chaque affiche, ✓
  marque comme vu et ✕ retire de la liste sans toucher à l'historique), puis les
  catalogues de l'addon de métadonnées (films et séries populaires, à la une…), lus depuis
  son manifest.
- **Découvrir** : grille d'affiches par type, **triée par popularité, année ou note**
  (les catalogues de l'addon), filtrable par genre et par **année**, avec le nombre de
  titres chargés. Les filtres sont dans l'URL, et le bouton retour revient au même
  endroit de la liste.
- **Recherche** : la barre du haut (raccourci **/**, Échap pour vider) ; résultats en
  grille, filtrables Films / Séries (avec le nombre de chaque) et triables (pertinence,
  année, note).
- **Fiche** : fond, logo, année, durée, note, genres (cliquables → Découvrir), résumé,
  casting (cliquable → Recherche) ; **Bande-annonce** (YouTube), **IMDb**, **Partager**
  (copie le lien de la fiche), **Marquer comme vu / non vu**. Pour une série, la fiche
  s'ouvre sur **le prochain épisode à voir** (celui en cours, sinon celui après le dernier
  vu), avec un raccourci **Épisode suivant** ; chaque épisode a sa date de sortie (« À
  venir » s'il n'est pas sorti) et un bouton ✓ vu / non vu, et toute une saison peut être
  marquée d'un coup. Les
  sources sont dans le panneau de droite, avec les mêmes infos qu'avant (qualité,
  👤 sources, taille, HDR/DV/HEVC, ⚡ débrid, filtres et tri).
  - **Lire** (en haut de la fiche, ou le gros bouton du panneau ; un clic sur un épisode fait
    pareil) choisit la source **tout seul**, comme Huwa : les sources sont
    classées (ta langue — VF ou VO selon ton choix audio, **MULTI** toujours bien placé —,
    puis débrid instantané, puis 1080p, puis le plus de sources), puis les meilleurs
    torrents sont **testés en parallèle** par le moteur Huwa (métadonnées et pairs qui
    répondent, sans rien télécharger) : le premier essaim en bonne santé gagne, en ~2 s au
    plus. Les liens débrid sont vérifiés d'un octet. Si la source gagnante ne s'ouvre pas, la
    suivante est essayée toute seule (les torrents morts en dernier). Le lecteur affiche
    « Source : 1080p · MULTI (la plus rapide parmi 5 testées) ». La liste des sources est
    repliée sous « Choisir une source moi-même », pour qui veut en choisir une précise. Les
    badges **MULTI**, **VF** et **VOSTFR** sont lus dans le nom de la release.
  - **Obligations sous « Lire »** : des pastilles à cocher (**VF + VO**, **VF**, **ST FR**,
    **1080p+**, **4K**, **⚡ Débrid**). « Lire » ne met en course que les sources qui les
    remplissent toutes ; s'il n'y en a aucune, il le dit et propose de décocher. Gardées
    d'une fiche à l'autre, sur cet appareil. Les sources qui ne les remplissent pas sont
    grisées dans la liste.
  - **Tes réglages par défaut** : tes derniers choix dans le lecteur (VF ou VO, langue des
    sous-titres, y compris une piste du fichier, qualité) s'appliquent tout seuls au film
    suivant ; la ligne « Pour toi : VO · sous-titres français · 1080p » sous « Lire » les
    rappelle. Une piste de sous-titres du fichier dans ta langue passe avant OpenSubtitles.
  - **Écran qui reste noir** : le lecteur affiche « Chargement de la vidéo… N s » avec ce qui
    se passe, « Réessayer » et « Statistiques » ; sans rien reçu au bout de 30 s il recharge,
    puis passe à la qualité en dessous. Au changement de film, le serveur arrête les
    conversions de l'ancien (elles prenaient le processeur du nouveau).
  - **Préparé avant le clic** : dès que la fiche (ou l'épisode sélectionné) reste affichée
    1,5 s, le serveur fait déjà la course et ouvre la source gagnante (torrent, analyse du
    fichier) ; « Lire » trouve le travail fait et démarre tout de suite. Préparation gardée
    3 min, une course par jeu de sources.
  - **Reprendre à 42:10** relance là où *tu* t'étais arrêté, pour tout le salon.
  - **Proposer** ajoute le titre à la file d'attente de la salle (votes). Si tu n'es ni
    hôte ni co-pilote, « Lire » propose au lieu de lancer.
  - **Ajouter à la bibliothèque**.
- **Bibliothèque** : tes titres, filtrables (tout / films / séries, avec le nombre de
  chaque), triables (ajout récent, dernière lecture, A → Z, année, note) et une recherche
  dans la bibliothèque.
- **Historique** : ce que tu as regardé, du plus récent au plus ancien, avec ta
  progression ; reprendre, marquer comme vu, retirer, ou **tout effacer** (deux clics pour
  confirmer : Discord bloque les fenêtres de confirmation).
- **Lecteur** : synchro, qualité auto et pistes comme avant. Le bouton ← (ou Échap) réduit
  le film en **mini-lecteur** : tu peux continuer à chercher pendant que ça joue, et ce que
  tu lances démarre toujours pour tout le monde.
  - Clic sur l'image = pause / lecture pour la salle, double-clic = plein écran. Sur
    téléphone : un tap affiche les commandes, double-tap à gauche / à droite = −10 s / +10 s.
  - Volume jusqu'à **130 %** (le tien seulement), réglages ⚙ (qualité, audio, sous-titres,
    décalage et taille des sous-titres), image dans l'image, temps restant (clic sur la durée).
  - Clavier : Espace/K, ←/→ ou J/L (±10 s), ↑/↓ (volume), M, F, C (sous-titres), ? (aide).
  - Le point de couleur indique ta connexion (vert, orange, rouge). Si ta vidéo prend du
    retard, la barre montre **ta** position (le trait blanc = la salle) et « Rattrapage de la
    salle… » s'affiche ; si ça risque de couper, le lecteur propose une qualité plus basse.
- **Paramètres** : thème (sombre, clair, système), qualité par défaut, **langue audio**
  (VF / VO) et **sous-titres par défaut**, réinitialiser ces préférences, code de la salle
  et lien d'invitation (hors Discord), **tes propres addons de sources** (ex. ton
  Torrentio avec ta clé débrid : l'URL reste sur le serveur et n'est jamais réaffichée en
  entier), et **Mes données** : exporter (fichier JSON), effacer l'historique, ou tout
  supprimer (historique, bibliothèque, addons perso ; le compte reste).
- Une adresse inconnue affiche « Page introuvable » ; un lien de fiche partagé ouvre la
  bonne fiche même après la connexion Discord sur le site.

## Regarder ensemble : propositions, votes, hôte

Le bouton **Salle** (barre du haut, et en haut du lecteur) ouvre un panneau (à droite sur
ordinateur, en bas sur téléphone) avec la vidéo en cours, le contrôle, la file d'attente et
les personnes présentes (👑 hôte, co-pilotes, et l'état de chacun : *en train de regarder*,
*en chargement*, *parcourt le catalogue*).

- **Personne n'est indispensable.** Celui qui a lancé l'Activité ou le film peut partir :
  le film continue pour les autres (s'il était le seul à charger, la salle ne l'attend
  plus). S'il revient, il retrouve le film à la bonne position. À 3 ou plus, dès que la
  majorité est prête, les derniers ont 8 s au plus (au lieu de 20) : un appareil lent ne
  bloque plus tout le monde, il rattrape tout seul. Si tout le monde part, le
  film est mis en pause et reprend quand quelqu'un revient (la salle est gardée 10 min).
- **Salle protégée par défaut.** Seuls l'**hôte** (le premier arrivé) et les
  **co-pilotes** qu'il nomme mettent en pause, avancent, arrêtent ou lancent un titre. Les
  autres **demandent** (une pause, de reprendre, d'aller à 42:10, de lancer une
  proposition) : l'hôte ou un co-pilote accepte ou refuse, la demande expire au bout de
  20 s. Un clic sur pause ou sur la barre de progression devient automatiquement une
  demande. L'hôte peut passer en **Tout le monde contrôle**.
- **Votes** : sans l'hôte, la salle décide à la **majorité des présents, 2 votes minimum** :
  *Voter pause*, *Voter pour passer* (épisode suivant, sinon la proposition en tête).
- **Propositions** : sur une fiche, **Proposer** ajoute le titre ou l'épisode à la file
  d'attente (avec la source choisie si tu as mis « Clic = proposer » au-dessus des
  sources ; sinon le serveur prend la meilleure au lancement, avec les addons de celui qui
  a proposé : MULTI, puis débrid, puis 1080p, puis le plus de sources). Chacun vote 👍
  (une fois, on peut retirer son vote) ; la file est triée par votes puis par ancienneté.
  **Lancer quand la majorité est d'accord** : quand rien ne joue (ou que la vidéo est
  finie), la proposition en tête démarre après un compte à rebours de 5 s si plus de la
  moitié de la salle a voté pour ; l'hôte ou un co-pilote peut annuler.
- **Épisode suivant** : à la fin d'un épisode, « Épisode suivant dans 10 s » pour tout le
  monde, avec Annuler pour ceux qui contrôlent.
- **Qui a fait quoi** : un petit message pour les autres à chaque action (« Bob a mis en
  pause », « Zoé a avancé à 42:10 », « Amin a lancé « Série · S1E04 » », « La salle a
  voté pour … »).
- **Si l'hôte part**, il garde sa place 15 s (le temps d'une reconnexion), puis la couronne
  passe au co-pilote présent depuis le plus longtemps, sinon à la personne présente depuis
  le plus longtemps ; l'ancien hôte revient comme co-pilote. L'hôte peut aussi passer la
  couronne lui-même.
- **Contre les trolls** :
  - sur le **site**, les nouveaux venus attendent en **salle d'attente** jusqu'à ce que
    l'hôte ou un co-pilote les fasse entrer (option « Accepter tout le monde
    automatiquement », désactivée par défaut). Le propriétaire d'une salle perso entre
    toujours et reprend la couronne. Dans **Discord**, les gens viennent du salon vocal :
    pas de salle d'attente, mais ils entrent sans le contrôle ;
  - l'hôte peut **exclure** quelqu'un (il ne peut plus revenir dans cette salle), nommer
    ou retirer des co-pilotes ;
  - chaque action est limitée par personne (ex. 3 demandes / 10 s) : au-delà, la personne
    est ignorée 30 s et l'hôte est prévenu. Quelqu'un qui bloque la lecture plus de 4 fois
    par minute (mauvaise connexion ou exprès) ne fait plus attendre la salle ;
  - tout est vérifié par le serveur (`server/src/rooms.js`, `roomSocket.js`) : l'interface
    ne fait qu'afficher ce qui est permis.

## Comment ça marche

```
Discord (chaque ami)                   Ton serveur (PC ou VPS)
┌─────────────────────────┐  proxy   ┌────────────────────────────┐
│ Activité (iframe)       │ Discord  │ Backend Node (ce dépôt)     │
│  · recherche / sources  │◄────────►│  · connexion Discord        │
│  · lecteur hls.js       │          │  · salles de synchro (WS)   │──► addons Stremio
│  · qualité auto         │          │  · relais HLS + images      │      (Cinemeta, Torrentio…)
└─────────────────────────┘          └─────────────┬──────────────┘
                                                   ▼
                                     Serveur de streaming Stremio
                                      · télécharge le torrent (1 fois)
                                      · /hlsv2 : copie ou transcode par qualité
```

1. **Recherche** via l'addon de métadonnées (Cinemeta par défaut).
2. **Sources** via tes addons de streams. Tu choisis toi-même (👤 nombre de sources,
   taille, HDR/DV, ⚡ débrid…). Les URL et clés débrid **restent sur le serveur** : le
   navigateur ne reçoit qu'un identifiant opaque.
3. **Lecture pour tout le monde** : le backend ouvre le torrent sur le serveur Stremio
   (ou suit le lien débrid), analyse le fichier, puis chaque ami charge le flux HLS de
   *sa* qualité.
4. **Synchro** : le serveur garde l'état de référence (position, pause). Chaque client
   estime l'horloge du serveur, se recale en accélérant ou ralentissant de ±5 % pour les
   petits écarts, et saute à la bonne position au-delà de 1 s. Au lancement et quand
   quelqu'un charge (ou après un déplacement), la salle **attend tout le monde**, 10 s
   maximum.

### Qualité et codecs, par ami

| Situation | Ce qui se passe |
|---|---|
| L'appareil de l'ami décode **vraiment** le codec (H.264 partout ; HEVC, AV1 ou VP9 s'il a passé le test ci-dessous) et la qualité choisie ≥ la source | **Copie** de la vidéo, sans transcodage (4K HEVC intacte sur Discord desktop avec un GPU récent) |
| Codec non décodable, ou qualité plus basse demandée | **Transcodage** en H.264 à 3840/1920/1280/854 px de large |
| Audio AC3, E-AC3, DTS, TrueHD… | Toujours converti en **AAC stéréo** (coûte peu) |

- **Qualité auto** : le client compare la vitesse de téléchargement de chaque segment au
  débit de la vidéo. Il descend d'un cran si ça ne suit pas, ou après 2 blocages en 1 min.
  Il remonte après 45 s stables à plus de 2,5× le débit nécessaire. Chacun peut aussi fixer
  sa qualité.
- Les amis qui finissent avec **les mêmes paramètres partagent le même transcodage**. Pour
  ton serveur, c'est 1 transcodage par qualité, pas 1 par personne.
- Pistes audio et sous-titres texte du fichier : sélectionnables par chacun.

### Pas d'écran noir

Un appareil peut annoncer qu'il lit le HEVC (ou l'AV1, le VP9) sans l'afficher : c'est le
cas de Discord sur certains PC Windows. Le temps avance, l'image reste noire. Watch Party ne
se fie plus à cette annonce :

- **Test réel au démarrage** (`client/src/codecprobe.ts`) : un minuscule extrait de chaque
  codec (256×144, 10 bits, une couleur connue) est décodé dans une vidéo cachée ; le codec
  compte seulement si la bonne couleur sort. Résultat gardé 7 jours par navigateur.
- **Garde-fou pendant la lecture** : si le temps avance sans nouvelle image (4 s), ou si le
  décodeur refuse la piste vidéo, le lecteur repasse tout seul en H.264 au même instant et
  ne recopie plus ce codec sur cet appareil.
- Ce qui s'est passé est écrit dans les **statistiques** (ligne « Compatibilité »).

### Statistiques du lecteur

Comme dans Stremio, un panneau donne les **pairs**, la **vitesse** et le **pourcentage
téléchargé** du torrent, plus ce que Watch Party ajoute : l'état (lecture, chargement depuis
N s, erreur et sa cause), la source (moteur Huwa / Stremio, lien direct), la vidéo d'origine,
ce que tu reçois (telle quelle ou convertie, et par qui), l'**accélération GPU** (active avec
son nombre d'images/s, prête, en pause après une erreur et pourquoi, ou absente), le tampon,
les images affichées / perdues et les codecs que ton appareil lit. Touche **I**, le point de
connexion dans la barre, ou Réglages → Statistiques.

### VF, VO et sous-titres : chacun les siens

Dans un même salon, **une personne peut regarder en VF et une autre en VO sous-titrée**,
au même moment, synchronisées.

- **Audio** : avec une source **MULTI** (VF + VO dans le même fichier), chacun choisit sa
  piste dans le lecteur. Chaque piste audio a son propre convertisseur sur le serveur Stremio,
  partagé par tous ceux qui l'écoutent : la VF de l'un ne coupe plus la VO de l'autre. Le
  choix (VF ou VO) est retenu et appliqué tout seul au film suivant.
- **Sous-titres** : en plus de ceux du fichier, le menu **Sous-titres** propose ceux
  d'**OpenSubtitles** (addon Stremio OpenSubtitles v3), dans toutes les langues, français
  en premier. Chacun choisit les siens (ou aucun) ; les autres ne voient rien. La langue est
  retenue pour les films suivants.
- **Synchro** : le serveur calcule l'empreinte OpenSubtitles du fichier joué et l'envoie
  avec son nom à l'addon. Les sous-titres **faits pour ce fichier** (« Fait pour ce
  fichier ») ou pour la même version sortent en premier, déjà synchronisés. Les autres sont
  calés automatiquement sur un sous-titre fait pour le fichier (même dans une autre langue,
  avec correction 25 ↔ 23,976 images/s), sinon sur les voix du film mesurées pendant la
  lecture (rien n'est enregistré ni envoyé). Réglage à la main : ±0,1 s / ±1 s, touches
  **G / H**, ou « Caler sur une réplique entendue ». Le calage est retenu par fichier.
- **Style** (Paramètres → Sous-titres, ou ⚙ → Style des sous-titres) : police, taille
  (relative à l'image), couleur, contour, ombre, fond (boîte ou bande), position, gras, avec
  un aperçu. Les sous-titres intégrés au fichier prennent le même style.
- Les sous-titres sont téléchargés et convertis (SRT → texte) par le serveur : le navigateur
  ne voit jamais l'adresse des fichiers. Une seule recherche par épisode pour tout le salon.
- `SUBTITLE_ADDON_URLS` : addons de sous-titres (OpenSubtitles v3 par défaut ; `none`
  pour désactiver).

### Comptes, progression et bibliothèque

- **Un compte = une identité Discord.** Il est créé à la première connexion (id Discord,
  pseudo, avatar), puis mis à jour à chaque connexion. Pas de mot de passe, pas d'e-mail.
- Dans l'Activité, la connexion reste celle du SDK Discord (rien à faire). Sur le site, le
  bouton **Se connecter avec Discord** utilise OAuth2 (scope `identify`), avec un `state`
  anti-CSRF et un cookie de session `httpOnly` + `Secure` valable 30 jours.
- Chaque spectateur envoie **sa propre** position au serveur toutes les 15 s, et quand il
  met en pause, arrête ou quitte. Au-delà de 90 % de la durée, la vidéo est marquée **vue**.
- Tout est stocké dans un fichier **SQLite** (`DATA_DIR`, volume Docker
  `watch-party-data`). Le schéma se met à jour tout seul au démarrage.

### Hors de Discord (navigateur)

Ouvre simplement `https://ton-domaine/` et connecte-toi avec Discord. Comme il n'y a pas
d'Activité, chacun a **sa salle perso**. Pour regarder ensemble, envoie le lien de ta salle
(**Paramètres → Salle → Copier le lien**, ou le badge en haut à droite) : tes amis
l'ouvrent, se connectent, et vous êtes synchronisés. On peut aussi coller un code dans
**Rejoindre une salle**.

### Lecteur externe (VLC, Infuse, MX Player…) et « Ouvrir sur le site »

Sur téléphone, surtout dans l'app Discord, le lecteur intégré n'est pas idéal. Dans le
lecteur, **Réglages → Ouvrir dans…** (ou le bouton ↗ en haut, sur téléphone) envoie le film
dans une vraie appli :

- **Android** : VLC, MX Player (gratuit ou Pro), qui démarrent **au moment où en est la
  salle**, ou « Autre lecteur… » (le choix d'appli d'Android).
- **iPhone / iPad** : VLC, Infuse, Outplayer, nPlayer (à recaler à la main).
- **Ordinateur** : « Ouvrir dans VLC » télécharge une petite playlist `.m3u` qui démarre au
  bon moment.
- Partout : **Copier le lien**, à coller dans n'importe quel lecteur (« Ouvrir un flux
  réseau »).

C'est le **fichier d'origine** : qualité d'origine, toutes les pistes audio, sous-titres
intégrés, aucune conversion sur le serveur. Le lien est **personnel** et privé : signé pour
toi et ce film, valable 12 h, il ne révèle jamais la vraie source (lien débrid, moteur
torrent) ; un membre exclu de la salle perd le sien.

Pendant ce temps, ta page devient une **télécommande** : lecture, pause et déplacements
pilotent toujours la salle (selon tes droits), et la salle **ne t'attend plus** quand elle
charge (ta pastille est en pointillés, « lecteur externe »). Ton lecteur, lui, ne suit pas
les pauses et les sauts des autres : **Recaler** le rouvre au bon moment (Android, `.m3u`)
ou t'indique l'heure de la salle. **Revenir au lecteur intégré** reprend la lecture dans la
page.

Dans l'Activité Discord, les autres applis ne peuvent pas s'ouvrir (Discord n'ouvre que des
liens web). Le premier choix y est donc **Ouvrir sur le site** (aussi dans **Paramètres →
Salle → Continuer dans le navigateur**) : un lien à usage unique, valable 5 minutes, ouvre
le site dans ton navigateur avec **le même compte et la même salle**, sans te reconnecter.
De là, « Ouvrir dans… » propose VLC & co. L'onglet garde la salle de l'Activité même s'il
est rechargé ; « Revenir à ma salle » dans les Paramètres le ramène à ta salle perso.

Pense à définir `PUBLIC_URL` : c'est l'adresse donnée aux lecteurs externes et au navigateur.

### Piste audio et sous-titres en un geste

Dans la barre du lecteur, deux pastilles comme sur Huwa : **🎧 VF** (un toucher = piste
audio suivante, « Audio : English ») et **CC** (un toucher = sous-titres oui / non, en
reprenant les derniers ou ta langue). La petite flèche ouvre la liste complète. Touches
**A** (audio) et **C** (sous-titres).

### Moteur torrent Huwa

Par défaut (docker-compose), les torrents sont téléchargés par le **moteur Huwa**
(`ghcr.io/amintt2/huwa`, version épinglée par `HUWA_IMAGE_TAG`, `sha-0968fdf` par défaut, librqbit avec des priorités de streaming, une lecture anticipée, la
surveillance de la santé du swarm et la reprise automatique quand il cale). Le serveur Stremio
ne fait plus que **convertir** : il lit le fichier chez Huwa en HTTP, comme un lien débrid.
Les qualités par spectateur, VF/VO et sous-titres restent identiques.

```
addon → infoHash → Huwa (/{infoHash}/create, puis /{infoHash}/{fichier} en Range)
                    ↑ lit le fichier
        serveur Stremio /hlsv2 → relais HLS de Watch Party → chaque ami
```

- `TORRENT_ENGINE=huwa` (défaut du compose) ou `stremio` (l'ancien moteur, dans le serveur Stremio).
- **Repli automatique** : si Huwa ne répond pas (redémarrage, image sans les routes Stremio…),
  le torrent part sur le moteur Stremio, avec un avertissement dans les logs.
- `HUWA_ENGINE_URL` (`http://huwa:8080` dans le compose) : où le backend et le convertisseur
  joignent Huwa (`HUWA_MEDIA_URL` si le convertisseur doit passer par une autre adresse).
- Le service `huwa` est privé (aucun port, aucun domaine), sans app web, sans relais P2P et sans
  transcodage : seulement le moteur. Son cache (`HUWA_CACHE_GB`, 20 Go) est dans le volume
  `huwa-cache`. Comme Stremio, il ne partage rien (envoi désactivé à la compilation).
- `GET /api/media/{sid}/health` (connecté) : pairs, débit, progression et verdict (`ok`,
  `slow` si le débit est sous celui de la vidéo, `searching`, `stalled`, `done`), pour
  l'indicateur « risque de coupure » du lecteur.

### Serveur de streaming pour tes apps Stremio

Le site sert aussi de **serveur de streaming Stremio** pour tes propres apps (Stremio Web, PC,
Android, TV), **à la même adresse** : `https://watch.mciut.fr`. Les torrents passent par le
moteur Huwa (démarrage plus rapide, lecture anticipée, reprise quand le swarm cale). La
conversion (MKV, HEVC…), les sous-titres et le casting passent par le serveur Stremio privé,
qui lit le fichier chez Huwa. Si Huwa ne répond pas, le torrent part sur le moteur Stremio.

Actif par défaut, sans clé. Dans Stremio → **Paramètres → Streaming → URL du serveur de
streaming** : ajoute `https://watch.mciut.fr` et sélectionne-la. Rien à changer dans Coolify.

Les routes de Stremio (`/settings`, `/hlsv2/…`, `/{infoHash}/…`, `/subtitles.vtt`…) vivent à la
racine, à côté de celles du site : le site n'utilise que `/api/…` et des liens `#/…`, donc
elles ne se gênent pas. Ce qu'il refuse, puisqu'il n'y a pas de clé : changer ses réglages
depuis Stremio (le cache et la conversion restent ceux de Watch Party), les routes que Stremio
n'utilise pas, et toute adresse du réseau privé (le convertisseur ne peut pas servir à joindre
les autres conteneurs). Il ne donne pas accès aux conversions des salles (`/hlsv2/status`,
`/hlsv2/wp-…`, `destroy`) : elles restent réservées au site. Les lectures Stremio partagent les `HUWA_STREAMS` (6) torrents
simultanés avec les salles. `STREMIO_GATEWAY=0` le coupe.

```
App Stremio ──https──▶ watch.mciut.fr
   /{infoHash}/create, /{infoHash}/{fichier} ──▶ Huwa (repli : moteur Stremio)
   /hlsv2, /settings, /subtitles.vtt, … ──▶ serveur Stremio privé ──lit──▶ Huwa
```

### Encodeur GPU de l'hôte

Au lieu de faire transcoder le serveur, l'hôte peut lancer l'**Encodeur Watch Party** sur son
PC : sa carte graphique prépare les qualités (4K, 1080p, 720p, 480p) pour toute la salle.

- **Installation** : sur ordinateur, l'hôte voit une carte « Accélère la salle avec ton
  GPU » (ou Paramètres → Encodeur GPU). Le fichier téléchargé est **déjà jumelé** à son
  compte : un `.exe` sous Windows (réglages glissés à la fin du fichier), un `.zip` sous
  macOS / Linux (réglages dans `watchparty-encoder.json`). Lien à usage unique, 10 min.
- **Au lancement**, comme Sunshine, il essaie les encodeurs dans l'ordre avec un vrai
  encodage de test : NVIDIA NVENC, Intel Quick Sync, AMD AMF, Media Foundation (Windows),
  VideoToolbox (macOS), VA-API (Linux), sinon le processeur (x264, 1080p au plus). Sous
  Windows, il télécharge ffmpeg la première fois (~100 Mo) ; ailleurs, ffmpeg doit être
  installé.
- **Fonctionnement** : il ouvre une connexion WebSocket **sortante** vers le site (aucun port
  à ouvrir), lit le film par le serveur (`/api/encoder/source`, Range) et renvoie des
  segments MPEG-TS de 4 s (H.264 + AAC) sur une grille fixe : le segment *n* commence à
  *n* × 4 s, donc un saut = « repars du segment *n* ». Un seul processus encode toutes les
  qualités regardées (un seul décodage), 80 s d'avance au plus.
- **Le serveur** garde ce qui est léger : le torrent, la **copie** quand le navigateur lit
  déjà la source, et le relais. Les segments reçus restent en RAM (`GPU_CACHE_MB`, 768 par
  défaut), rien sur le disque.
- **Repli** : si l'encodeur se ferme ou prend trop de retard, le convertisseur Stremio
  reprend tout seul et chaque lecteur recharge au même instant. L'app reçoit la raison et le
  film lui revient après 1 min (puis 2, 4… 10 min si ça recommence) ; relancer l'app le lui
  rend tout de suite.
- **L'app** n'a plus de console : une petite fenêtre (une page servie sur le PC seulement,
  `127.0.0.1:47470`, ouverte dans le navigateur) montre la connexion, la carte graphique, le
  film en cours (segment, images/s, pipeline GPU ou processeur), le journal, et les options.
  Sous Windows, une icône près de l'horloge la rouvre. Une seule copie tourne à la fois.
  La page ne s'ouvre que par le lien à usage unique que l'app donne au navigateur : un autre
  programme ou un site ne peut ni la lire ni appuyer sur ses boutons.
- **Sécurité de l'app** : la clé n'apparaît pas dans la ligne de commande de ffmpeg (le
  serveur donne pour chaque film un lien à jeton, `?t=…`) ; ce que le serveur envoie (film,
  qualités, pistes) est vérifié avant de servir ; ffmpeg s'arrête avec l'app même tuée
  (objet job Windows, signal Linux) ; l'adresse du serveur doit être en `https` (sauf
  `localhost`). Une clé déjà utilisée sur un autre PC : l'app attend 5 min et réessaie,
  sans se croire retirée.
- **Lancement avec l'ordinateur** (activé au premier lancement, désactivable) : clé `Run` de
  Windows, LaunchAgent sur macOS, autostart XDG sur Linux. Il démarre sans fenêtre.
- **Mises à jour automatiques**, entre deux films : depuis le **site** (par défaut : toujours
  la version compilée avec ton serveur, `GET /api/encoder/latest` et `/api/encoder/update/…`
  avec la clé de l'app) ou depuis les **releases GitHub** (`encoder-v<version>`, publiées par
  `.github/workflows/encoder-release.yml` quand `encoder/VERSION` change). Le fichier est
  vérifié par son SHA-256 avant de remplacer l'app, qui redémarre seule. Les réglages restent
  à côté (dossier de configuration), pas dans le fichier.
- Les builds sans numéro de version (avant la 1.1.0) ne savent pas se mettre à jour :
  retélécharge l'encodeur une fois depuis Paramètres → Encodeur GPU.
- **Débit** : l'envoi de la box de l'hôte est la limite (≈ 6 Mb/s en 1080p, 3 en 720p,
  16 en 4K, seulement pour les qualités regardées).
- Clés : seule une empreinte est gardée en base ; « Retirer » dans Paramètres coupe le PC.
- Le `Dockerfile` compile l'encodeur (`encoder/build.sh`, Go) pour Windows, macOS
  (Apple Silicon et Intel) et Linux, avec `VERSION` et `SHA256SUMS` ; `ENCODER_DIST_DIR`
  pour servir d'autres builds. Monte `encoder/VERSION` à chaque changement de l'app.

### Combien de personnes ?

Aucune limite dans la salle. Ce qui coûte, ce sont les **transcodages différents**, pas
les spectateurs : 10 amis sur 2 qualités = 2 transcodages. Sans accélération matérielle, le
plus léger est une source **H.264 1080p** : elle est copiée sans conversion pour tous ceux
qui sont en 1080p. Côté connexion, compte environ le débit de la source × le nombre de
spectateurs en upload (10 × 8 Mb/s ≈ 80 Mb/s en 1080p).

## Installation

### 1. Application Discord

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** : note le *Client ID* et le *Client Secret*. Dans **Redirects**, ajoute
   `https://<ton-domaine>/api/auth/discord/callback` (ex.
   `https://watch.mciut.fr/api/auth/discord/callback`) : c'est ce qui permet de se
   connecter sur le site, hors de Discord. L'Activité, elle, n'en a pas besoin.
3. **Activities → Settings** : active les Activités.
4. **Activities → URL Mappings** : `/` → ton domaine, sans `https://`
   (ex. `watch.mciut.fr`). Toutes les requêtes de l'Activité, WebSocket compris, passent
   par `https://<client_id>.discordsays.com` puis par ce mapping. C'est pour ça que le
   backend relaie la vidéo et les images.
5. **General Information** : *Terms of Service URL* = `https://<ton-domaine>/conditions`,
   *Privacy Policy URL* = `https://<ton-domaine>/confidentialite`. Les deux pages sont servies
   par l'app ; règle `LEGAL_OPERATOR` (qui exploite le service) et `LEGAL_CONTACT` (e-mail
   ou lien d'invitation) pour qu'elles affichent les bonnes infos.
6. Garde l'app **non publiée** : elle est alors utilisable par toi et par les testeurs que
   tu ajoutes dans le portail (App Testers). Lance-la depuis un salon vocal → 🚀
   Activités.

### 2. Configuration

```bash
cp .env.example .env
# remplis DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / SESSION_SECRET / STREAM_ADDON_URLS
```

`STREAM_ADDON_URLS` = l'URL de manifest de ton Torrentio configuré, celle que tu colles dans
Stremio (`https://torrentio.strem.fun/<ta-config>/manifest.json`). Tu peux en mettre
plusieurs, séparées par des virgules. Ces addons sont partagés par tout le monde ; chacun
peut en plus ajouter les siens dans **Paramètres**.

- `DATA_DIR` : dossier de la base SQLite (`./data` par défaut, `/app/data` dans Docker).
- `PUBLIC_URL` (facultatif) : `https://watch.mciut.fr`. Sert à construire l'URL de retour
  de la connexion Discord ; sans elle, elle est déduite de la requête.
- `ALLOW_PRIVATE_SOURCES` (facultatif, `1`) : par défaut, les liens venus de l'extérieur
  (addons ajoutés dans Paramètres, liens de stream, redirections) ne peuvent pas viser une
  adresse privée (autres conteneurs, box, `localhost`) : le serveur vérifie l'adresse
  résolue à chaque redirection. Les addons de `STREAM_ADDON_URLS` restent permis où qu'ils
  soient. Mets `1` seulement si tes sources sont sur ton réseau local.

### 3. Lancer

**Coolify (le plus simple)** :

1. **+ New Resource → Public/Private Repository** → `amintt2/stremio-watch-party`,
   branche `main`, *Build Pack* : **Docker Compose**.
2. Onglet **Environment Variables** : remplis `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
   `SESSION_SECRET` (une longue chaîne aléatoire) et `STREAM_ADDON_URLS`.
   Stockage : voir « Peu de place sur le disque » plus bas. Mets aussi `PUBLIC_URL`
   (`https://watch.mciut.fr`) pour la connexion sur le site.
3. Sur le service **watch-party**, mets le domaine **avec le port 3001** :
   `https://watch.mciut.fr:3001`. Coolify gère le HTTPS. Ne donne **aucun** domaine au
   service `stremio`.
4. **Deploy**. Dans les logs du service `watch-party`, tu dois voir
   `Stremio streaming server reachable`, puis `Stremio server settings updated`.
5. Dans Discord → **Activities → URL Mappings** : `/` → `watch.mciut.fr`, et dans
   **OAuth2 → Redirects** : `https://watch.mciut.fr/api/auth/discord/callback`.

Les comptes, la progression et les bibliothèques sont dans le volume `watch-party-data` :
ils survivent aux redéploiements. Garde le même `SESSION_SECRET` (le changer déconnecte
tout le monde du site, sans perdre les données).

Le serveur Stremio de cette stack est privé et réglé automatiquement : plusieurs qualités
en même temps et un grand cache. Ton ancien `stremio.mciut.fr` public n'est plus
nécessaire.

**Docker Compose à la main** (Linux) :

```bash
cp .env.example .env   # puis remplis-le
docker compose --env-file .env up -d --build
```

**Sans Docker** (le serveur Stremio tourne déjà ailleurs, ex. ton Stremio desktop ou
`stremio.mciut.fr`) :

```bash
npm install
npm run build
STREMIO_SERVER_URL=http://127.0.0.1:11470 npm start   # écoute sur :3001
```

Mets ensuite un reverse proxy HTTPS devant le port 3001. Par exemple avec Caddy :

```
watch.mciut.fr {
  reverse_proxy 127.0.0.1:3001
}
```

**Tester sans Discord** (mode test local uniquement, jamais en production) :
`ALLOW_BROWSER_MODE=1 npm start`, puis ouvre `http://localhost:3001/?room=test&name=Alice`
dans un onglet et `?room=test&name=Bob` dans un autre. Ce sont des comptes **invités**
(marqués comme tels dans la base), identifiés par leur pseudo. Ajoute `&lobby=1` (dans
tous les onglets) pour tester la salle d'attente du site.

**Développement** : `npm run dev` (Vite sur :5173 avec rechargement, backend sur :3001).
Pour l'ouvrir dans Discord pendant le dev, mappe `/` vers un tunnel HTTPS qui pointe sur
`:5173`.

### 4. Régler le serveur de streaming Stremio

Au démarrage, le backend règle lui-même le serveur Stremio (`STREMIO_AUTO_TUNE=0` pour
désactiver) :

- **`transcodeConcurrency` = 8** (`STREMIO_TRANSCODE_CONCURRENCY`) : par défaut à 1, ce qui
  détruit le transcodage des autres qualités, donc un ami en 720p coupe celui en 1080p. Un
  film utilise au plus 1 copie + 4 tailles de transcodage + 1 conversion par piste audio
  écoutée (souvent 2 : VF et VO), quel que soit le nombre de spectateurs : 8 couvre donc
  10 personnes et plus.
- **Peu de place sur le disque** : seuls les **torrents** prennent de la place (le fichier
  téléchargé reste en cache). Le HLS n'est pas stocké, les liens **débrid** n'utilisent pas de
  disque. Trois réglages :
  - `MAX_TORRENT_GB` (15) : taille max d'un fichier torrent. Les sources plus grosses (un remux
    4K fait 50 à 80 Go) sont grisées « Trop gros » et refusées, même quand l'addon n'annonce
    pas la taille (vérifiée une fois le torrent ouvert). 0 = pas de limite.
  - `HUWA_CACHE_GB` (20) : cache du moteur Huwa ; les torrents inactifs les plus anciens sont
    effacés au-delà.
  - `STREMIO_CACHE_GB` (5) : cache du serveur Stremio, qui ne télécharge plus qu'en secours.
  Prévois au moins `HUWA_CACHE_GB` + `STREMIO_CACHE_GB` + quelques Go de libre.
- **Accélération matérielle (RX 6650 XT)** : le serveur Stremio sait utiliser une carte AMD
  **sous Linux** (profil `vaapi-renderD128` : décommente `devices` dans
  `docker-compose.yml`). Sous
  Windows, il ne propose que NVIDIA (NVENC) et Intel (QSV) : avec une carte AMD, le
  transcodage se fera au processeur. Les amis dont le Discord décode le HEVC reçoivent la
  4K sans transcodage dans tous les cas.
- ⚠️ **Ne laisse pas le serveur Stremio public.** `/settings` est lisible **et modifiable**
  sans authentification, et n'importe qui peut lancer des torrents avec ta connexion.
  Seul le backend doit pouvoir le joindre (réseau Docker interne, ou authentification sur
  ton reverse proxy).

## Dépannage

`https://<ton-domaine>/api/health/details` vérifie depuis le serveur le serveur Stremio,
l'addon de métadonnées et chaque addon de sources, avec l'erreur exacte. Les URL d'addon
sont masquées. Le même diagnostic apparaît dans les logs (`diag: …`) 15 s après le
démarrage.

- **`HTTP 403 (cloudflare)` sur `torrentio.strem.fun`** : Torrentio bloque beaucoup d'IP
  de serveurs (VPS, hébergeurs). Utilise un addon qui répond depuis un serveur, par exemple
  **TorrentsDB** (`https://torrentsdb.com/manifest.json`, configurable sur
  `https://torrentsdb.com/configure` : langue, débrid…), même format de résultats que
  Torrentio. Si un addon ne donne pas de trackers, le serveur ajoute des trackers publics
  en plus du DHT.

## Limites connues

- **Pas de conversion HDR → SDR** dans le transcodeur Stremio : une source HDR ou Dolby
  Vision transcodée en H.264 aura des couleurs ternes ou fausses. L'app prévient. Préfère
  une release SDR pour les amis qui ne décodent pas le HEVC, et évite le Dolby Vision seul.
- **Sous-titres image** (PGS des Blu-ray) : ignorés. Utilise ceux d'OpenSubtitles à la
  place.
- **VF / VO** : il faut une source **MULTI** (les deux langues dans le fichier). Avec une
  release VF seule ou VOSTFR, tout le monde a la même piste audio.
- **Sous-titres OpenSubtitles** : ils correspondent au film, pas forcément à la release
  exacte ; un petit décalage est possible (boutons − / +).
- **Torrents en direct** : ton serveur partage aussi des morceaux avec les autres pairs,
  depuis ton IP. Avec un débrid (Real-Debrid, AllDebrid…), rien ne passe en P2P chez toi.
  Comme c'est le backend (une seule IP) qui lit le lien et le relaie, ça respecte aussi la
  règle « une IP par compte » de ces services.
- Le salon (`room`) est l'instance d'activité Discord : tous ceux qui ont rejoint la même
  activité regardent ensemble. Sur le site, c'est la salle perso de quelqu'un (ou celle
  qu'on a rejointe avec un code). L'hôte et les co-pilotes pilotent la lecture (voir
  « Regarder ensemble »).
- « Regarder ensemble » choisit et teste la source tout seul (course des torrents par le
  moteur Huwa, `TORRENT_ENGINE=huwa`) ; avec le moteur Stremio, pas de test, seulement le
  classement. Si elle ne convient pas, choisis-en une autre dans le panneau. Pour reprendre, il faut relancer une source (les liens des
  addons expirent), la position, elle, est gardée.

## Structure

```
server/src/index.js    routes HTTP + WebSocket, relais HLS, proxy d'images
server/src/rooms.js    état de lecture autoritaire + hôte, demandes, votes, file, salle d'attente (testé)
server/src/roomSocket.js  messages de la salle : validation, limites (testé)
server/src/race.js     choix automatique de la source : classement, course des torrents (sondes Huwa), liens directs (testé)
server/src/media.js    torrent (moteur Huwa ou Stremio)/débrid → session, profils de qualité, santé, playlists (testé)
server/src/addons.js   protocole des addons Stremio (catalogues, recherche, fiches, sources, langues) (testé)
server/src/subtitles.js sous-titres OpenSubtitles : liste, SRT/VTT → texte, clés opaques (testé)
server/src/db.js       SQLite : comptes, progression, historique, bibliothèque, addons perso (testé)
server/src/webauth.js  connexion Discord sur le site : state, cookies, codes de salle (testé)
server/src/encoder.js  encodeur GPU : clés, playlists sur grille fixe, file de travail, cache des segments (testé)
server/src/encoderRoutes.js jumelage, téléchargement, socket de l'encodeur, envoi des segments, HLS GPU (testé)
server/src/gateway.js  serveur de streaming pour les apps Stremio : torrents vers Huwa, le reste vers Stremio (testé)
server/src/external.js lecteurs externes (lien de fichier signé, proxy Range) + « Ouvrir sur le site » (testé)
client/src/main.ts     coquille : navigation, routes, lecteur plein écran / mini-lecteur
client/src/views/      Accueil, Découvrir, Fiche, Bibliothèque, Historique, Recherche, Paramètres
client/src/room.ts     bouton Salle, cartes en direct (comptes à rebours, demandes), présence
client/src/views/queue.ts  panneau Salle : contrôle, file d'attente, votes, membres
client/src/social.ts   règles côté client (droits, votes) (testé)
client/src/streams.ts  panneau des sources (filtres, tri, meilleure source, badges MULTI/VF/VOSTFR)
client/src/subtitles.ts sous-titres externes : choix par spectateur, calage, affichage
client/src/subsync.ts  synchro auto des sous-titres (corrélation, ratios d'images/s) (testé)
client/src/speech.ts   niveau des voix pendant la lecture (pour la synchro audio)
client/src/substyle.ts / subcontrols.ts  style des sous-titres et ses réglages (testé)
client/src/encoder.ts  Paramètres → Encodeur GPU, suggestion à l'hôte
client/src/player.ts   lecteur : synchro, détection de blocage, qualité auto, garde-fou écran noir
client/src/codecprobe.ts vrai test de décodage HEVC / AV1 / VP9 (extraits dans codecsamples.ts) (testé)
client/src/stats.ts    panneau Statistiques : pairs, vitesse, GPU, compatibilité (testé)
client/src/external.ts liens vers VLC, Infuse, MX Player… (intent Android, schémas iOS, .m3u) (testé)
client/src/externalPlayer.ts « Ouvrir dans… », télécommande pendant la lecture externe
client/src/sync.ts     horloge serveur + correction de dérive (testé)
client/src/abr.ts      choix automatique de la qualité (testé)
client/src/format.ts   routes, progression, choix de la meilleure source (testé)
client/src/lists.ts    tris et filtres (bibliothèque, recherche, Découvrir), épisode suivant (testé)
encoder/               Encodeur Watch Party (Go) : sonde GPU, ffmpeg, segments, fenêtre locale,
                       icône Windows, démarrage auto, mises à jour vérifiées (go test)
client/src/style.css   tous les styles ; couleurs et tailles en variables (thèmes sombre/clair)
```

`npm test` lance les tests unitaires, `npm run build` vérifie les types et construit le
client.
