# LandCrew — application autonome (à téléverser chez WHC)

Ceci est la **vraie LandCrew** — le même code serveur que l'artefact Muse
(`tournees-tonte-et-deneigement`, 57 actions : clients, terrains,
soumissions, employés, tournées, pointages GPS, journal de temps,
abonnements) — empaquetée pour rouler sur un hébergement Node.js
ordinaire, sans Muse.

## Contenu

| Élément | Rôle |
|---|---|
| `app.js` | Fichier de démarrage (startup file) : serveur HTTP Node.js. Sert le client web et l'API `POST /actions`. |
| `actions.bundle.cjs` | Les 57 actions serveur + le schéma + zod, compilés en un seul fichier CommonJS autonome (aucun `require` externe). Reconstruisible via `../build/build.sh`. |
| `public/` | Le client web compilé (le même que celui de l'artefact) + `manifest.webmanifest`, `sw.js`, icônes et `.well-known/assetlinks.json`. |
| `migrations/` | Les migrations SQL (0001 → 0006), appliquées automatiquement au premier démarrage. |
| `data/` | Emplacement du fichier SQLite `landcrew.db` (créé au premier démarrage). Jamais exposé par le serveur web. |
| `package.json` | Dépendances d'exécution : `drizzle-orm` et `@libsql/client` (versions épinglées, identiques à celles de l'artefact). |

## Démarrage

```sh
npm install        # ou le bouton « Run NPM Install » de cPanel
node app.js        # PORT depuis l'environnement (Passenger) ou 3000
```

Au premier démarrage, le serveur crée `data/landcrew.db` et applique les
migrations. Vérification : `GET /healthz` répond `{"ok":true,...}`.

## Comportement

- Protocole identique au runtime Muse : `POST /actions` avec
  `{ "action": "<nom>", "args": { ... } }` → `{ "data": ... }` ou
  `{ "error": "..." }`. Validation des entrées et des sorties par les
  mêmes schémas zod que dans Muse.
- L'application est mono-entreprise et sans mot de passe, comme dans
  Muse : l'accès se fait par l'adresse. Voir `../rapport-deploiement.md`
  pour les implications et les recommandations (test fermé).
- Les actions `geocodeAddress`, `optimizeRoute` et `routeLegs` appellent
  des services publics externes (OpenStreetMap / OSRM) depuis le serveur ;
  l'hébergement doit autoriser les requêtes HTTPS sortantes (cas normal
  chez WHC).
