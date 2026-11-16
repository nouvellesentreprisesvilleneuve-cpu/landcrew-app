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
| `migrations/` | Les migrations SQL (0001 → 0008), appliquées automatiquement au premier démarrage. |
| `modules/cartographie.js` | Module « Cartographie et registres » (2026-11-15) : 3 actions fusionnées dans `app.js` sans toucher au bundle — `lookupCadastralLot` (adresse → cadastre officiel du Québec : nº de lot, polygone, superficie), `saveTerrainRegistryData`, `estimateFromTerrainMeasurement` (prix calculé sur la surface de travail MESURÉE — gazon seulement — jamais sur la superficie brute du lot). Détails et intégration client : `modules/INTEGRATION-CLIENT.md`. |
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
- **Multi-entreprise (depuis la migration 0007)** : chaque compagnie a
  son espace privé et étanche. Inscription par nom + courriel + code
  d'accès (haché SHA-256), essai gratuit de 3 jours, forfaits par
  compagnie (50 $/mois 2 équipes, 75 $/mois 4 équipes). La compagnie
  nº 1 « Tonte-O-Max » (créateur, gratuit à vie) possède toutes les
  données d'avant la migration. Les employés rejoignent leur employeur
  par son code d'entreprise ; l'espace client public route chaque
  demande vers la bonne entreprise. Sans jeton de session valide
  (en-tête `x-landcrew-session`), les actions métier sont refusées —
  seules les actions d'accès et l'espace client public sont ouverts.
- Les actions `geocodeAddress`, `optimizeRoute` et `routeLegs` appellent
  des services publics externes (OpenStreetMap / OSRM) depuis le serveur ;
  l'hébergement doit autoriser les requêtes HTTPS sortantes (cas normal
  chez WHC).
