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

- **Accueil** : « Continuer à regarder » (avec ta progression), puis les catalogues de
  l'addon de métadonnées (films et séries populaires, à la une…), lus depuis son manifest.
- **Découvrir** : grille d'affiches filtrable par type, catalogue et genre, qui se charge
  au fur et à mesure qu'on descend.
- **Fiche** : fond, logo, année, durée, note, genres, résumé, casting ; pour une série,
  le choix de la saison et la liste des épisodes (✓ vus, barre de progression). Les
  sources sont dans le panneau de droite, avec les mêmes infos qu'avant (qualité,
  👤 sources, taille, HDR/DV/HEVC, ⚡ débrid, filtres et tri).
  - **Regarder ensemble** lance la meilleure source (**MULTI** d'abord, pour que chacun
    choisisse VF ou VO, puis débrid, puis 1080p, puis le plus de sources) **pour tout le
    salon**. Tu peux aussi cliquer une source précise. Les badges **MULTI**, **VF** et
    **VOSTFR** sont lus dans le nom de la release.
  - **Reprendre à 42:10** relance là où *tu* t'étais arrêté, pour tout le salon.
  - **Ajouter à la bibliothèque**.
- **Bibliothèque** : tes titres, filtrables (films/séries) et triables (récents, A → Z).
- **Historique** : ce que tu as regardé, du plus récent au plus ancien, avec ta
  progression ; reprendre ou retirer.
- **Lecteur** : synchro, qualité auto et pistes comme avant. Le bouton ← (ou Échap) réduit
  le film en **mini-lecteur** : tu peux continuer à chercher pendant que ça joue, et ce que
  tu lances démarre toujours pour tout le monde.
- **Paramètres** : thème (sombre, clair, système), qualité par défaut, code de la salle et
  lien d'invitation (hors Discord), **tes propres addons de sources** (ex. ton Torrentio
  avec ta clé débrid : l'URL reste sur le serveur et n'est jamais réaffichée en entier).

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
   `STREMIO_CACHE_GB` vaut 100 par défaut. Mets aussi `PUBLIC_URL`
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
(marqués comme tels dans la base), identifiés par leur pseudo.

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
- **Cache de `STREMIO_CACHE_GB` Go** (100 dans le compose) : un remux 4K fait 50 à 80 Go ;
  avec 5 Go, revenir en arrière retélécharge.
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
  qu'on a rejointe avec un code). Tout le monde peut piloter la lecture.
- « Regarder ensemble » choisit une source tout seul ; si elle ne convient pas, choisis-en
  une autre dans le panneau. Pour reprendre, il faut relancer une source (les liens des
  addons expirent), la position, elle, est gardée.

## Structure

```
server/src/index.js    routes HTTP + WebSocket, relais HLS, proxy d'images
server/src/rooms.js    état de lecture autoritaire (testé)
server/src/media.js    torrent/débrid → session, profils de qualité, réécriture des playlists (testé)
server/src/addons.js   protocole des addons Stremio (catalogues, recherche, fiches, sources, langues) (testé)
server/src/subtitles.js sous-titres OpenSubtitles : liste, SRT/VTT → texte, clés opaques (testé)
server/src/db.js       SQLite : comptes, progression, historique, bibliothèque, addons perso (testé)
server/src/webauth.js  connexion Discord sur le site : state, cookies, codes de salle (testé)
client/src/main.ts     coquille : navigation, routes, lecteur plein écran / mini-lecteur
client/src/views/      Accueil, Découvrir, Fiche, Bibliothèque, Historique, Recherche, Paramètres
client/src/streams.ts  panneau des sources (filtres, tri, meilleure source, badges MULTI/VF/VOSTFR)
client/src/subtitles.ts sous-titres externes : choix par spectateur, décalage, affichage
client/src/player.ts   lecteur : synchro, détection de blocage, qualité auto
client/src/sync.ts     horloge serveur + correction de dérive (testé)
client/src/abr.ts      choix automatique de la qualité (testé)
client/src/format.ts   routes, progression, choix de la meilleure source (testé)
client/src/style.css   tous les styles ; couleurs et tailles en variables (thèmes sombre/clair)
```

`npm test` lance les tests unitaires, `npm run build` vérifie les types et construit le
client.
