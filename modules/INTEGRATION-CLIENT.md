# Module « Cartographie et registres » — intégration

## Ce qui est livré et déjà branché (serveur, hôte autonome)

| Fichier | Rôle |
|---|---|
| `modules/cartographie.js` | Les 3 actions serveur : `lookupCadastralLot`, `saveTerrainRegistryData`, `estimateFromTerrainMeasurement`. Aucune dépendance hors `drizzle-orm` (déjà requis). |
| `migrations/0008_terrain_registry_data.sql` | Colonnes `terrains.lot_number`, `lot_polygon`, `lot_source`, `zoning` (les colonnes `lot_dimensions`, `lot_area_pi2`, `work_area_pi2`, `work_polygon` existaient déjà — migration 0004). Appliquée automatiquement au démarrage par `app.js`. |
| `app.js` (2 retouches) | Fusion `{ ...Actions, ...cartographieActions }` avec repli si le module échoue à charger ; `handleAction` lit `AllActions`. Le bundle d'origine n'est pas modifié. Les 3 actions ne sont PAS dans `PUBLIC_ACTIONS` : la garde de session du propriétaire s'applique, comme aux autres actions métier. |
| `modules/client/CartographieTerrain.tsx` | Panneau client (recherche au cadastre, résultat, repli manuel). À intégrer à l'écran d'évaluation du terrain — voir ci-dessous. |

## Flux complet, une fois le client intégré

1. L'entrepreneur ouvre l'évaluation d'un terrain (`TerrainMeasure`) et
   clique « Chercher le lot au cadastre » (`CartographieTerrain`).
2. `lookupCadastralLot({ address })` : géocodage Nominatim → requête au
   service cadastral du Québec (voir l'en-tête de `cartographie.js` pour
   la source vérifiée) → nº de lot, polygone, superficie calculée,
   lots voisins. Échec = `found:false` + raison + liens officiels +
   champs manuels. **Rien n'est deviné.**
3. Le polygone du lot remonte à `TerrainMeasure` (`onLotPolygon`) et se
   dessine dans le même calque SVG que le polygone de travail (voir le
   code ci-dessous), en ambre pointillé, SOUS le polygone de travail.
4. « Enregistrer les données du lot » → `saveTerrainRegistryData`
   (colonnes de la migration 0008 + `lot_area_pi2`/`lot_dimensions`).
5. L'entrepreneur délimite le **gazon seulement** dans le lot (le
   composant existant, `saveTerrainMeasurement` → `work_area_pi2`).
6. Estimation : appeler `estimateFromTerrainMeasurement({ terrainId,
   services, crewSize })` — le serveur relit `work_area_pi2` et applique
   les taux de l'entreprise. La superficie du lot n'entre jamais dans
   le calcul (test automatisé à l'appui, `tests/cartographie.test.mjs`).

## Dessin du polygone du lot dans TerrainMeasure.tsx

Dans `TerrainMeasure`, ajouter un état et le passer au panneau :

```tsx
const [lotPoints, setLotPoints] = useState<LatLng[]>([]);
// …dans le rendu, au-dessus de la carte :
<CartographieTerrain
  terrainId={terrain.id}
  address={terrain.address}
  onLotPolygon={setLotPoints}
/>
```

Dans le calque SVG existant, AVANT le polygone de travail (`pxPoints`),
ajouter le contour du lot projeté avec la même fonction que le
composant utilise déjà :

```tsx
{lotPoints.length >= 3 && (
  <polygon
    points={lotPoints
      .map((p) => {
        const px = latLngToPixel(p, size.w, size.h, center, zoom);
        return `${px.x},${px.y}`;
      })
      .join(" ")}
    fill="rgba(245, 158, 11, 0.08)"
    stroke="#f59e0b"
    strokeWidth={2}
    strokeDasharray="6 4"
    pointerEvents="none"
  />
)}
```

## Port dans l'artefact Muse (source de vérité du client compilé)

Le client web servi par l'hôte autonome est compilé depuis l'artefact
`tournees-tonte-et-deneigement`. Pour que le panneau y vive et que le
client typé connaisse les actions :

1. `server/src/schema.ts` : ajouter à `terrains` les 4 colonnes de la
   migration 0008 (`lotNumber`, `lotPolygon`, `lotSource`, `zoning`) +
   migration Drizzle équivalente dans `drizzle/`.
2. `server/src/actions.ts` : porter les 3 actions de
   `modules/cartographie.js` en `defineAction` zod (les validateurs
   manuels du module donnent les formes exactes), et ajouter les 4
   champs à la forme « terrain » des réponses (`listClients`, etc.).
3. `client/src/TerrainMeasure.tsx` : intégrer
   `modules/client/CartographieTerrain.tsx` comme ci-dessus.
4. Reconstruire l'artefact par la voie habituelle, puis régénérer le
   paquet autonome (`public/` + `actions.bundle.cjs`) et le téléverser.

## Déploiement de l'hôte autonome (WHC) — serveur seulement

1. Téléverser : `app.js`, `modules/` (nouveau dossier),
   `migrations/0008_terrain_registry_data.sql`.
2. Redémarrer l'application Node (cPanel « Setup Node.js App » →
   Restart). La migration 0008 s'applique au démarrage ; vérifier le
   journal : « migration appliquée : 0008_terrain_registry_data.sql ».
3. Vérifier `GET /healthz` → `{"ok":true,...}`, puis, connecté comme
   Tonte-O-Max, appeler `lookupCadastralLot` sur une adresse connue
   (ex. 155 rue Belvédère Nord, Sherbrooke → lot 1 031 020).
4. Le panneau client n'apparaîtra qu'après le port dans l'artefact
   (étape précédente) ; d'ici là, les actions sont appelables par
   l'API `/actions` et couvertes par les tests.

## Limites connues (assumées, documentées dans le code)

- Québec seulement pour l'automatisation ; les autres juridictions
  retombent sur le repli liens officiels + saisie manuelle.
- Le service cadastral utilisé est la diffusion ArcGIS (MELCCFP) des
  données du MRNF, mise à jour périodiquement ; Infolot reste la
  source officielle — le panneau y renvoie systématiquement.
- Un terrain peut couvrir plusieurs lots (campus) : l'action retourne
  le lot du point géocodé + les lots voisins ; le choix final du lot
  du client reste à l'entrepreneur, confirmé sur Infolot.
- La superficie retournée est calculée du polygone (sphérique) ; la
  superficie « officielle » du rôle se saisit dans le champ prévu.
