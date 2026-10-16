# Watch Party — Stremio dans une Activité Discord

Regarde un film ou une série **ensemble, synchronisés**, directement dans un salon vocal
Discord, comme l'activité YouTube. Les vidéos viennent de tes **addons Stremio**
(Torrentio, avec ou sans débrid, ou n'importe quel autre addon), et chaque ami reçoit une
**qualité adaptée** à sa connexion et à ce que son appareil sait décoder.

Contrairement au partage d'écran (Go Live), personne ne réencode son écran : chaque ami lit
le fichier depuis ton serveur, et seule la position de lecture est synchronisée.

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

## Installation

### 1. Application Discord

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** : note le *Client ID* et le *Client Secret*. Ajoute une redirection
   (`https://127.0.0.1` suffit, Discord en exige une).
3. **Activities → Settings** : active les Activités.
4. **Activities → URL Mappings** : `/` → ton domaine, sans `https://`
   (ex. `watch.mciut.fr`). Toutes les requêtes de l'Activité, WebSocket compris, passent
   par `https://<client_id>.discordsays.com` puis par ce mapping. C'est pour ça que le
   backend relaie la vidéo et les images.
5. Garde l'app **non publiée** : elle est alors utilisable par toi et par les testeurs que
   tu ajoutes dans le portail (App Testers). Lance-la depuis un salon vocal → 🚀
   Activités.

### 2. Configuration

```bash
cp .env.example .env
# remplis DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / SESSION_SECRET / STREAM_ADDON_URLS
```

`STREAM_ADDON_URLS` = l'URL de manifest de ton Torrentio configuré, celle que tu colles dans
Stremio (`https://torrentio.strem.fun/<ta-config>/manifest.json`). Tu peux en mettre
plusieurs, séparées par des virgules.

### 3. Lancer

**Docker (recommandé, Linux)** : backend et serveur Stremio privé, avec l'accélération AMD :

```bash
docker compose up -d --build
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

**Tester sans Discord** : `ALLOW_BROWSER_MODE=1 npm start`, puis ouvre
`http://localhost:3001/?room=test&name=Alice` dans un onglet et `?room=test&name=Bob`
dans un autre.

**Développement** : `npm run dev` (Vite sur :5173 avec rechargement, backend sur :3001).
Pour l'ouvrir dans Discord pendant le dev, mappe `/` vers un tunnel HTTPS qui pointe sur
`:5173`.

### 4. Régler le serveur de streaming Stremio

Le backend affiche un avertissement au démarrage si quelque chose cloche. Points importants :

```bash
# Plusieurs qualités en même temps (sinon un ami en 720p coupe celui en 1080p)
curl -X POST -H 'content-type: application/json' \
  -d '{"transcodeConcurrency":4,"cacheSize":107374182400}' http://<serveur-stremio>:11470/settings
```

- **`transcodeConcurrency` ≥ 3–4** : par défaut à 1, ce qui détruit le transcodage des
  autres qualités.
- **Cache ≥ 100 Go pour la 4K** : un remux 4K fait 50 à 80 Go ; avec 5 Go, revenir en
  arrière retélécharge.
- **Accélération matérielle (RX 6650 XT)** : le serveur Stremio sait utiliser une carte AMD
  **sous Linux** (profil `vaapi-renderD128`, avec `/dev/dri` passé au conteneur). Sous
  Windows, il ne propose que NVIDIA (NVENC) et Intel (QSV) : avec une carte AMD, le
  transcodage se fera au processeur. Les amis dont le Discord décode le HEVC reçoivent la
  4K sans transcodage dans tous les cas.
- ⚠️ **Ne laisse pas le serveur Stremio public.** `/settings` est lisible **et modifiable**
  sans authentification, et n'importe qui peut lancer des torrents avec ta connexion.
  Seul le backend doit pouvoir le joindre (réseau Docker interne, ou authentification sur
  ton reverse proxy).

## Limites connues

- **Pas de conversion HDR → SDR** dans le transcodeur Stremio : une source HDR ou Dolby
  Vision transcodée en H.264 aura des couleurs ternes ou fausses. L'app prévient. Préfère
  une release SDR pour les amis qui ne décodent pas le HEVC, et évite le Dolby Vision seul.
- **Sous-titres image** (PGS des Blu-ray) : ignorés. Seuls les sous-titres texte du
  fichier sont proposés.
- **Pistes audio** : deux amis sur la même qualité qui choisissent deux pistes audio
  différentes se gênent (une seule piste audio convertie à la fois par transcodage).
- **Torrents en direct** : ton serveur partage aussi des morceaux avec les autres pairs,
  depuis ton IP. Avec un débrid (Real-Debrid, AllDebrid…), rien ne passe en P2P chez toi.
  Comme c'est le backend (une seule IP) qui lit le lien et le relaie, ça respecte aussi la
  règle « une IP par compte » de ces services.
- Le salon (`room`) est l'instance d'activité Discord : tous ceux qui ont rejoint la même
  activité regardent ensemble. Tout le monde peut piloter la lecture.

## Structure

```
server/src/index.js    routes HTTP + WebSocket, relais HLS, proxy d'images
server/src/rooms.js    état de lecture autoritaire (testé)
server/src/media.js    torrent/débrid → session, profils de qualité, réécriture des playlists (testé)
server/src/addons.js   protocole des addons Stremio (recherche, fiches, sources)
client/src/player.ts   lecteur : synchro, détection de blocage, qualité auto
client/src/sync.ts     horloge serveur + correction de dérive (testé)
client/src/abr.ts      choix automatique de la qualité (testé)
client/src/browse.ts   recherche → épisode → choix de la source
```

`npm test` lance les tests unitaires, `npm run build` vérifie les types et construit le
client.
