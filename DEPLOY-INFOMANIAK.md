# Déployer le jeu sur l'hébergement Web Infomaniak

Ce document décrit le déploiement de **Devine la chanson** sur un hébergement
Web mutualisé Infomaniak, sous forme de **site Node.js**.

Il est écrit après lecture de la documentation officielle Infomaniak
(septembre 2026) et après vérification locale de tout ce qui pouvait l'être.
Chaque affirmation est marquée :

- **CONFIRMÉ LOCALEMENT** — testé sur ce projet, la preuve est reproductible.
- **CONFIRMÉ (doc)** — écrit noir sur blanc dans la documentation Infomaniak,
  avec le lien.
- **À VÉRIFIER SUR L'HÉBERGEMENT** — la documentation ne le dit pas ; il faut
  le tester une fois le site en ligne.

---

## 1. Pourquoi Node.js et pas PHP

Le jeu est déjà une application Node.js : un serveur Express qui sert
l'interface, l'API, l'audio et un serveur WebSocket (`ws`) qui tient les salles
de jeu en mémoire.

Le multijoueur repose sur **un état partagé en mémoire et des connexions
ouvertes en permanence** : qui est dans la salle, à quel palier chacun en est,
quand la manche se termine. En PHP, chaque requête HTTP repart de zéro : il
faudrait réécrire tout ça avec une base de données et un polling, c'est-à-dire
perdre le temps réel, la latence actuelle et la simplicité du code — pour aucun
gain.

**Infomaniak permet bel et bien Node.js sur l'hébergement mutualisé** (voir
§2). Il n'y a donc aucune raison de réécrire quoi que ce soit.

Références : <https://faq.infomaniak.com/2537>, <https://faq.infomaniak.com/1988>

> ⚠️ La page FAQ 2019 dit encore, dans sa partie Cloud Server, que Node.js
> n'est « pas disponible sur l'hébergement Web mutualisé ». C'est un texte
> obsolète : la même FAQ décrit ailleurs la création d'un site Node.js sur
> l'hébergement mutualisé. Se fier à la FAQ 2537.

---

## 2. Ce que la documentation Infomaniak dit vraiment

| Question | Réponse | Source |
|---|---|---|
| Node.js sur mutualisé ? | Oui — **site Node.js**, créé depuis le Manager | [2537](https://faq.infomaniak.com/2537) |
| Création | Hébergement → **Ajouter** → « projet avec technologies avancées » → Node.js | [1988](https://faq.infomaniak.com/1988) |
| Champs de configuration | Dossier d'exécution, **Commande de build**, **Commande de lancement**, **Port d'écoute**, version de Node | [2535](https://faq.infomaniak.com/2535) |
| Port | La plateforme **impose** un port et le transmet via `process.env.PORT` ; le champ du Manager doit correspondre | [2535](https://faq.infomaniak.com/2535), [2171](https://faq.infomaniak.com/2171) |
| `npm install` | **Pas automatique** — à mettre dans la commande de build | [2535](https://faq.infomaniak.com/2535) |
| Déploiement | ZIP, SSH, SFTP, ou dépôt Git. **FTP non disponible** pour un site Node.js | [2537](https://faq.infomaniak.com/2537) |
| HTTPS | Terminaison TLS par un **proxy inverse** en amont ; certificat Let's Encrypt gratuit | [2130](https://faq.infomaniak.com/2130), [2171](https://faq.infomaniak.com/2171) |
| IP du visiteur | Le proxy transmet `X-Forwarded-For` (sinon on lit l'IP du proxy) | [2171](https://faq.infomaniak.com/2171) |
| Limite de fichiers | **Aucune limite d'inodes** ; stockage de l'ordre de 250 Go | [2158](https://faq.infomaniak.com/2158) |
| Domaines | Domaine ou **sous-domaine** choisi à la création, modifiable ensuite | [2537](https://faq.infomaniak.com/2537) |
| Logs | Console d'exécution par site + logs de build en direct dans le Manager | [2536](https://faq.infomaniak.com/2536) |
| Redémarrage | Nécessaire après un changement de version de Node, de port ou de commande | [2535](https://faq.infomaniak.com/2535) |
| Tâches planifiées | Fréquence minimale de 15 min sur mutualisé ; `node-cron` suggéré pour Node | [2161](https://faq.infomaniak.com/2161) |

### Ce que la documentation ne dit PAS

- **WebSocket / `wss://`** : aucune page officielle ne l'affirme ni ne
  l'infirme. La documentation cite Socket.IO parmi les frameworks supportés,
  et la page produit parle d'« interactions instantanées » — c'est un indice,
  pas une preuve. **C'est LE point à tester en ligne en premier** (§9).
- Les versions de Node.js disponibles (au moins 22 et 24 existent, d'après les
  guides Ghost et n8n).
- Le répertoire d'exécution est-il persistant et inscriptible, et où.
- L'adresse d'écoute attendue (`0.0.0.0`, une IP précise, un socket Unix).
- Les quotas mémoire / CPU, et l'arrêt éventuel du process après inactivité.
- L'existence d'une interface Manager pour des variables d'environnement
  personnalisées (le guide n8n les passe **en ligne dans la commande de
  lancement** — c'est la méthode retenue ici).

---

## 3. Vérifier la production en local, avant tout

```bash
npm install
npm run build      # produit dist/
npm run qa:prod    # 39 vérifications : un seul process, PORT, TLS, wss, MUSIC_DIR…
```

`npm run qa:prod` monte un **vrai proxy inverse TLS** devant l'application et
joue une manche à travers lui. C'est le même montage qu'Infomaniak, et c'est
ce qui rend crédible le reste de ce document :

- **CONFIRMÉ LOCALEMENT** — l'application démarre avec un seul process, sert
  l'interface, l'API, l'audio et le WebSocket sur **un seul port** fourni par
  `PORT`.
- **CONFIRMÉ LOCALEMENT** — une page chargée en `https://` demande d'elle-même
  un socket `wss://` sur sa propre origine (aucune URL en dur).
- **CONFIRMÉ LOCALEMENT** — une manche démarre et se résout à travers le proxy.
- **CONFIRMÉ LOCALEMENT** — les endpoints publics ne divulguent aucun chemin
  de fichier ; les tentatives de traversée de répertoire sont refusées.

---

## 4. Créer le site Node.js dans le Manager

1. **Manager Infomaniak** → *Hébergement Web* → cliquer sur le **nom** de
   l'hébergement (pas sur « Gérer »).
2. Bouton bleu **Ajouter** → *« Choisir un projet avec des technologies
   avancées »* → **Node.js**.
3. Choisir le **domaine** : un domaine existant, un **sous-domaine**, ou un
   domaine à commander. (Le sous-domaine suffit très bien pour un premier
   test.)
4. Méthode **Personnalisée** (pas « Rapide »), puis renseigner :

| Champ (Manager) | Valeur pour ce projet |
|---|---|
| **Dossier d'exécution** *(Run folder)* | `./` — le dossier qui contient `package.json` |
| **Commande de build** *(Build command)* | `npm install && npm run build` |
| **Commande de lancement** *(Launch command)* | `NODE_ENV=production node server/index.js --prod` |
| **Port d'écoute** *(Listening port)* | le port affiché par le Manager — **le même** que `PORT` |
| **Version de Node.js** | la plus récente LTS proposée (22 ou plus) |

> Le port est **imposé par la plateforme**. Le serveur lit `process.env.PORT`
> et écoute dessus : il n'a pas besoin qu'on lui dise lequel. Le champ du
> Manager sert à déclarer le même port à la plateforme.
> **CONFIRMÉ (doc)** : <https://faq.infomaniak.com/2535>

`package.json` déclare `"engines": { "node": ">=20" }`.

**CONFIRMÉ LOCALEMENT** : `node server/index.js --prod` sert l'interface
construite, l'API et les WebSockets sur un seul port, sans serveur Vite.

---

## 5. Envoyer le code

Trois méthodes sont supportées. **FTP ne l'est pas** pour un site Node.js.

### Recommandé : Git pour le code, SFTP pour la musique

Le dépôt Git contient le code ; les chansons sont envoyées à part, en SFTP.
C'est déjà ce que prévoit `.gitignore` : `songs/*` est ignoré, donc **votre
collection ne partira jamais dans un dépôt**.

1. Pousser le projet sur GitHub / GitLab (privé si vous voulez).
2. Dans le Manager, indiquer l'URL du dépôt. Pour un dépôt privé, la
   documentation accepte des identifiants dans l'URL :
   `https://utilisateur:motdepasse@github.com/…`
3. Mettre `git pull && npm install && npm run build` en **commande de build** :
   c'est la méthode de mise à jour recommandée par Infomaniak.

Référence : <https://faq.infomaniak.com/2537>

### Alternative : ZIP

Utile pour un premier essai. Zipper le projet **sans** `node_modules`, sans
`dist`, sans `songs`, sans `.cache`, puis importer l'archive.

### Alternative : SSH / SFTP

Le seul accès à l'environnement pour un site Node.js. Pratique pour corriger
un fichier ou envoyer une poignée de morceaux.

---

## 6. Envoyer la musique

Le serveur lit la variable `MUSIC_DIR` ; à défaut, le dossier `songs/` du
projet.

```bash
# Par défaut : ./songs à la racine du projet
# Sinon, en ligne dans la commande de lancement :
MUSIC_DIR=/srv/customer/musique NODE_ENV=production node server/index.js --prod
```

**CONFIRMÉ LOCALEMENT** : `MUSIC_DIR` (chemin absolu ou relatif) est respecté,
les sous-dossiers deviennent des catégories, les accents dans les noms de
dossier survivent, et `WATCH=0` désactive la surveillance du dossier.
Couvert par `npm run qa:prod`.

Conseils :

- Envoyer les fichiers en **SFTP** dans `songs/` (ou dans le dossier pointé par
  `MUSIC_DIR`).
- Éviter de les versionner : Git n'est pas fait pour quelques Go d'audio.
- Compter environ **250 Go** de stockage selon l'offre, et **aucune limite
  d'inodes** — mais rester raisonnable : chaque fichier est lu une fois pour en
  extraire les métadonnées.
- Après l'envoi, cliquer sur la pastille de bibliothèque en haut à droite
  (« Analyser à nouveau ») ou redémarrer le site.

---

## 7. Variables d'environnement

Aucune interface Manager pour des variables personnalisées n'est documentée ;
le guide officiel n8n les passe **en ligne dans la commande de lancement**.
C'est la méthode utilisée ici.

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute — **fourni par la plateforme**, ne pas le fixer | `8787` |
| `NODE_ENV` | `production` : mode production | — |
| `MUSIC_DIR` | Dossier des chansons (relatif au projet ou absolu) | `songs` |
| `DATA_DIR` | Cache de métadonnées et pochettes extraites | `.cache` |
| `WATCH` | `0` désactive la surveillance du dossier | `1` |
| `HOST` | Interface d'écoute ; par défaut Node écoute partout | *(toutes)* |
| `GTS_MP_ROUND_SECONDS` | Fige la durée de manche (tests, démonstration) | — |
| `GTS_MP_INTERMISSION_SECONDS` | Durée de l'entracte entre deux manches | `6` |
| `GTS_MP_IDLE_SECONDS` | Délai avant suppression d'une salle vide | `60` |
| `GTS_MAX_ROOMS` | Plafond de salles en mémoire | `500` |
| `GTS_ALLOWED_ORIGINS` | Liste d'origines autorisées pour le WebSocket, séparées par des virgules. Vide = tout accepté | *(vide)* |

Commande de lancement complète, si vous voulez tout préciser :

```bash
NODE_ENV=production MUSIC_DIR=./songs WATCH=0 node server/index.js --prod
```

> `GTS_ALLOWED_ORIGINS` est **désactivé par défaut** volontairement : derrière
> un proxy d'hébergement, l'en-tête `Origin` du navigateur et l'en-tête `Host`
> ne coïncident pas toujours, et un mauvais réglage casserait le jeu au lieu de
> le protéger. Renseignez-le seulement si vous savez quel domaine sert le site —
> et retirez-le au moindre doute.

---

## 8. Domaine et HTTPS

- Le domaine (ou sous-domaine) se choisit à la création, et se change ensuite
  depuis le tableau de bord du site.
- Installer le **certificat Let's Encrypt gratuit** depuis le menu d'actions du
  site.
- **Ne pas** gérer de certificat dans Node : la plateforme termine le TLS et
  transmet en clair au process. L'application reste compatible (`app.set('trust
  proxy', true)` pour lire la vraie IP via `X-Forwarded-For`).
- Forcer HTTPS : la documentation ne décrit que `.htaccess`, destiné à Apache.
  On ne sait pas s'il est honoré sur un site Node.js — **À VÉRIFIER SUR
  L'HÉBERGEMENT**. Le jeu fonctionne de toute façon en HTTPS, c'est simplement
  HTTP qui ne redirige pas tout seul.

Références : <https://faq.infomaniak.com/2130>, <https://faq.infomaniak.com/2171>

---

## 9. Vérifier le déploiement pour de vrai

```bash
npm run qa:production -- https://votre-domaine
# ou : node tools/prod-smoke.mjs https://votre-domaine
```

Le script ouvre deux navigateurs sur le site public et fait ce que fait un
joueur : charger la page, écouter un extrait, créer une salle, la rejoindre,
jouer une manche jusqu'au dévoilement, lire le classement, fermer un onglet. Il
ne laisse rien derrière lui. **CONFIRMÉ LOCALEMENT** : 32/32 à travers un proxy
TLS local.

Checklist manuelle, pour ce que le script ne peut pas faire :

- [ ] **`wss://` fonctionne** — c'est le point critique. Ouvrir la console du
      navigateur (F12 → Réseau → WS) et vérifier une connexion `wss://` en
      `101 Switching Protocols`. Si le WebSocket est bloqué par le proxy,
      **aucun autre test multijoueur n'a de sens** : ouvrir un ticket au
      support Infomaniak en citant ce besoin précis.
- [ ] Deux joueurs de **réseaux différents** (téléphone en 4G / ordinateur en
      Wi-Fi) se voient dans la même salle.
- [ ] La bibliothèque est indexée : la pastille en haut à droite affiche le bon
      nombre de titres.
- [ ] Le **premier extrait** se lance sans délai anormal (le serveur doit
      répondre vite ; le décodage se fait côté navigateur).
- [ ] Le bouton « Écouter plus » allonge bien l'extrait.
- [ ] « Créer la partie » donne un code, « Rejoindre » fonctionne avec ce code.
- [ ] Les réglages de l'hôte (manches, essais, temps, catégorie) arrivent chez
      les autres joueurs.
- [ ] Tout le monde entend **le même extrait** au même moment.
- [ ] Le **classement** apparaît après la première manche et se réordonne.
- [ ] La manche suivante démarre, puis une **revanche** depuis le classement
      final remet les scores à zéro.
- [ ] Le jeu fonctionne sur téléphone.
- [ ] **Redémarrer le site** depuis le Manager pendant une partie : les joueurs
      doivent voir « Le serveur a redémarré : la partie est fermée. » et non un
      écran figé.

---

## 10. Logs, redémarrage, mises à jour

- **Logs** : console d'exécution du site dans le Manager. Les erreurs de
  lancement (mauvaise commande, port incorrect, exception au démarrage) y
  apparaissent. `GET /api/health` donne aussi `version`, `uptimeSeconds`,
  `library.tracks` et le nombre de salles — sans jamais révéler de chemin.
- **Build** : les logs de build s'affichent en direct dans le Manager.
- **Redémarrer** : bouton *Start / Restart* du tableau de bord. Obligatoire
  après un changement de version de Node, de port ou de commande de lancement ;
  en cas de conflit de port, changer temporairement la version de Node force
  l'arrêt complet des process.
- **Mettre à jour** : pousser sur Git, puis relancer le build (ou *Restart* si
  la commande de build fait déjà `git pull && npm install && npm run build`).

---

## 11. Limites à connaître

### Les salles vivent en mémoire

Chaque salle de jeu existe uniquement dans le process Node. Un redémarrage les
efface : les parties en cours s'arrêtent.

- **CONFIRMÉ LOCALEMENT** : après redémarrage, `rooms` repart à 0 et le
  processus réécoute sur le même port.
- L'application ne laisse pas pour autant les joueurs devant un écran mort :
  à l'arrêt (SIGTERM/SIGINT), elle envoie `server-restart` à chaque client
  **avant** de fermer les sockets, et le navigateur affiche « Le serveur a
  redémarré : la partie est fermée. »
- Aucune base de données n'a été ajoutée : elle n'apporterait rien à un jeu
  dont les parties durent dix minutes.

### Une seule instance

Rien n'indique qu'Infomaniak répartisse un site Node.js sur plusieurs process.
Si cela arrivait, deux joueurs pourraient atterrir sur deux process différents
et ne plus se voir : l'état des salles n'est pas partagé. Ce serait le signal
qu'il faut un stockage partagé (Redis) — mais **il n'y a aucune preuve que ce
soit nécessaire**, donc rien de tel n'a été ajouté. **À VÉRIFIER SUR
L'HÉBERGEMENT** : si deux joueurs ne se rejoignent jamais alors que le
WebSocket fonctionne, c'est le premier suspect.

### Surveillance du dossier

Chokidar utilise inotify sous Linux ; certains systèmes de fichiers mutualisés
ne transmettent pas ces événements. La surveillance est donc un confort, jamais
une dépendance : le bouton « Analyser le dossier » reste toujours disponible, et
`WATCH=0` la désactive proprement.

### Contenu des chansons

L'audio est servi par `GET /api/audio/:id` et, en multijoueur, par un code de
salle opaque. Les identifiants sont des empreintes, jamais des chemins : pas de
traversée de répertoire, pas de listing, pas de métadonnées avant le
dévoilement. **Ce n'est pas de la DRM** : le navigateur doit bien finir par
recevoir le fichier. L'objectif est d'éviter qu'on devine la réponse depuis
l'URL, pas d'empêcher le téléchargement.

---

## 12. Ce qui reste à vérifier une fois en ligne

| Point | Statut |
|---|---|
| Node.js sur mutualisé, champs du Manager, `PORT`, TLS, Git/SFTP | **CONFIRMÉ (doc)** |
| Un seul process sert tout, `wss://` dérivé de la page, `MUSIC_DIR`, absence de fuite de chemins, traversée refusée, redémarrage propre | **CONFIRMÉ LOCALEMENT** (`npm run qa:prod`) |
| Proxy WebSocket (`wss://`) réel | **À VÉRIFIER SUR L'HÉBERGEMENT** |
| Deux joueurs sur deux réseaux | **À VÉRIFIER SUR L'HÉBERGEMENT** |
| Répertoire inscriptible et persistant (`.cache/`) | **À VÉRIFIER SUR L'HÉBERGEMENT** |
| Une seule instance applicative | **À VÉRIFIER SUR L'HÉBERGEMENT** |
| Quotas mémoire / arrêt après inactivité | **À VÉRIFIER SUR L'HÉBERGEMENT** |

Tant que le premier point de cette seconde liste n'est pas vert, le multijoueur
n'est **pas** validé en production — même si tout le reste l'est.

---

## 13. Revenir en arrière

Le site Node.js est une entrée parmi les autres dans le Manager : on peut
l'arrêter, le supprimer, ou changer son domaine sans toucher au reste de
l'hébergement. En local, `npm run dev` reste le mode de développement habituel
(Vite + l'API sur deux ports) — rien de ce déploiement ne le casse.

Pour tester le mode production sur votre machine :

```bash
npm run serve      # build puis démarrage en production, sur le port 8787
```
