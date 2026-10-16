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
  - **Regarder ensemble** lance la meilleure source (**MULTI** d'abord, pour que chacun
    choisisse VF ou VO, puis débrid, puis 1080p, puis le plus de sources) **pour tout le
    salon**. Tu peux aussi cliquer une source précise. Les badges **MULTI**, **VF** et
    **VOSTFR** sont lus dans le nom de la release.
  - **Reprendre à 42:10** relance là où *tu* t'étais arrêté, pour tout le salon.
  - **Proposer** ajoute le titre à la file d'attente de la salle (votes). Si tu n'es ni
    hôte ni co-pilote, « Regarder ensemble » propose au lieu de lancer.
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
  plus). S'il revient, il retrouve le film à la bonne position. Si tout le monde part, le
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
| Le navigateur de l'ami décode le codec (H.264 partout ; HEVC, AV1 ou VP9 selon l'appareil) et la qualité choisie ≥ la source | **Copie** de la vidéo, sans transcodage (4K HEVC intacte sur Discord desktop avec un GPU récent) |
| Codec non décodable, ou qualité plus basse demandée | **Transcodage** en H.264 à 3840/1920/1280/854 px de large |
| Audio AC3, E-AC3, DTS, TrueHD… | Toujours converti en **AAC stéréo** (coûte peu) |

- **Qualité auto** : le client compare la vitesse de téléchargement de chaque segment au
  débit de la vidéo. Il descend d'un cran si ça ne suit pas, ou après 2 blocages en 1 min.
  Il remonte après 45 s stables à plus de 2,5× le débit nécessaire. Chacun peut aussi fixer
  sa qualité.
- Les amis qui finissent avec **les mêmes paramètres partagent le même transcodage**. Pour
  ton serveur, c'est 1 transcodage par qualité, pas 1 par personne.
- Pistes audio et sous-titres texte du fichier : sélectionnables par chacun.

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
  retenue pour les films suivants. Boutons **− / +** pour décaler de 0,5 s si les
  sous-titres sont en avance ou en retard.
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
- « Regarder ensemble » choisit une source tout seul ; si elle ne convient pas, choisis-en
  une autre dans le panneau. Pour reprendre, il faut relancer une source (les liens des
  addons expirent), la position, elle, est gardée.

## Structure

```
server/src/index.js    routes HTTP + WebSocket, relais HLS, proxy d'images
server/src/rooms.js    état de lecture autoritaire + hôte, demandes, votes, file, salle d'attente (testé)
server/src/roomSocket.js  messages de la salle : validation, limites (testé)
server/src/media.js    torrent (moteur Huwa ou Stremio)/débrid → session, profils de qualité, santé, playlists (testé)
server/src/addons.js   protocole des addons Stremio (catalogues, recherche, fiches, sources, langues) (testé)
server/src/subtitles.js sous-titres OpenSubtitles : liste, SRT/VTT → texte, clés opaques (testé)
server/src/db.js       SQLite : comptes, progression, historique, bibliothèque, addons perso (testé)
server/src/webauth.js  connexion Discord sur le site : state, cookies, codes de salle (testé)
client/src/main.ts     coquille : navigation, routes, lecteur plein écran / mini-lecteur
client/src/views/      Accueil, Découvrir, Fiche, Bibliothèque, Historique, Recherche, Paramètres
client/src/room.ts     bouton Salle, cartes en direct (comptes à rebours, demandes), présence
client/src/views/queue.ts  panneau Salle : contrôle, file d'attente, votes, membres
client/src/social.ts   règles côté client (droits, votes) (testé)
client/src/streams.ts  panneau des sources (filtres, tri, meilleure source, badges MULTI/VF/VOSTFR)
client/src/subtitles.ts sous-titres externes : choix par spectateur, décalage, affichage
client/src/player.ts   lecteur : synchro, détection de blocage, qualité auto
client/src/sync.ts     horloge serveur + correction de dérive (testé)
client/src/abr.ts      choix automatique de la qualité (testé)
client/src/format.ts   routes, progression, choix de la meilleure source (testé)
client/src/lists.ts    tris et filtres (bibliothèque, recherche, Découvrir), épisode suivant (testé)
client/src/style.css   tous les styles ; couleurs et tailles en variables (thèmes sombre/clair)
```

`npm test` lance les tests unitaires, `npm run build` vérifie les types et construit le
client.
