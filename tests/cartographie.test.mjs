// ============================================================================
// LandCrew — Module « Cartographie et registres » : tests
// ----------------------------------------------------------------------------
// Usage : node tests/cartographie.test.mjs
//   - démarre l'application (app.js) sur un port de test avec une base
//     SQLite TEMPORAIRE (aucune donnée de production touchée) ;
//   - tests unitaires : aire de polygone, détection de juridiction ;
//   - tests de bout en bout via POST /actions : inscription d'une
//     entreprise de test, création d'un client et de terrains, recherche
//     cadastrale RÉELLE pour les deux adresses du Séminaire de
//     Sherbrooke, enregistrement des données du lot, puis estimation —
//     y compris la preuve que le prix ne dépend JAMAIS de la superficie
//     du lot, seulement de la surface de travail mesurée.
// Requiert le réseau (Nominatim + service cadastral du Québec).
// ============================================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { _internals } = require(path.join(appDir, "modules", "cartographie.js"));

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------- unitaires
console.log("— Tests unitaires —");
{
  // Carré de 100 m × 100 m à la latitude de Sherbrooke ≈ 10 000 m².
  const lat0 = 45.4028;
  const mToDegLat = 100 / 111_320;
  const mToDegLng = 100 / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const lng0 = -71.8948;
  const square = [
    { lat: lat0, lng: lng0 },
    { lat: lat0, lng: lng0 + mToDegLng },
    { lat: lat0 + mToDegLat, lng: lng0 + mToDegLng },
    { lat: lat0 + mToDegLat, lng: lng0 },
  ];
  const area = _internals.polygonAreaM2([square]);
  check("aire d'un carré 100 m × 100 m ≈ 10 000 m²", near(area, 10_000, 60), `obtenu ${area.toFixed(1)}`);

  const qc = _internals.jurisdictionOf({ countryCode: "ca", state: "Québec" });
  const on = _internals.jurisdictionOf({ countryCode: "ca", state: "Ontario" });
  const us = _internals.jurisdictionOf({ countryCode: "us", state: "Vermont" });
  check("juridiction Québec détectée", qc === "CA-QC");
  check(
    "Ontario détectée, sans fournisseur (repli)",
    on === "CA-ON" && _internals.registryById("CA-ON").provider === null,
  );
  check("É.-U. non automatisée (repli)", us === null);

  // Généralisation par juridiction (registres.js) : détection EN + FR
  // et fournisseurs automatisés vérifiés.
  const bc = _internals.jurisdictionOf({ countryCode: "ca", state: "British Columbia" });
  const nb = _internals.jurisdictionOf({ countryCode: "ca", state: "Nouveau-Brunswick" });
  const ns = _internals.jurisdictionOf({ countryCode: "ca", state: "Nova Scotia" });
  const mb = _internals.jurisdictionOf({ countryCode: "ca", state: "Manitoba" });
  check("C.-B. détectée + fournisseur WFS", bc === "CA-BC" && _internals.registryById("CA-BC").provider?.kind === "wfs");
  check("N.-B. détecté + fournisseur ArcGIS", nb === "CA-NB" && _internals.registryById("CA-NB").provider?.kind === "arcgis");
  check("N.-É. détectée + fournisseur ArcGIS", ns === "CA-NS" && _internals.registryById("CA-NS").provider?.kind === "arcgis");
  check("Manitoba détecté + rayon de repli 25 m", mb === "CA-MB" && _internals.registryById("CA-MB").provider?.bufferMeters === 25);
  check(
    "fournisseurs automatisés = QC, BC, MB, NB, NS",
    _internals.REGISTRY_PROVIDERS.map((p) => p.jurisdiction).sort().join(",") === "CA-BC,CA-MB,CA-NB,CA-NS,CA-QC",
  );
  check(
    "pointInRing : dedans/dehors",
    _internals.pointInRing(lat0 + 0.0005, lng0 + 0.0005, square) === true &&
      _internals.pointInRing(lat0 + 0.01, lng0 + 0.01, square) === false,
  );
  // Projection UTM (Manitoba) : référence du service de projection
  // d'Esri pour le centre-ville de Winnipeg, écart < 1 m.
  const utm = _internals.latLngToUtm(49.8994015, -97.1394715, 14);
  check(
    "latLngToUtm : Winnipeg ≈ (633613.40, 5529104.53)",
    near(utm.x, 633613.4, 1) && near(utm.y, 5529104.53, 1),
    `obtenu (${utm.x.toFixed(2)}, ${utm.y.toFixed(2)})`,
  );

  const polys = _internals.geojsonPolygons({
    type: "Polygon",
    coordinates: [
      square.map((p) => [p.lng, p.lat]),
    ],
  });
  check("GeoJSON → polygone + aire", polys.length === 1 && near(polys[0].areaM2, 10_000, 60));
}

// ------------------------------------------------------------- bout en bout
console.log("— Tests de bout en bout (serveur local, base temporaire) —");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landcrew-carto-test-"));
const dbPath = path.join(tmp, "test.db");
const server = spawn("node", [path.join(appDir, "app.js")], {
  env: { ...process.env, PORT: String(PORT), LANDCREW_DB_PATH: dbPath },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let token = null;
async function call(action, args) {
  const res = await fetch(`${BASE}/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-landcrew-session": token } : {}),
    },
    body: JSON.stringify({ action, args }),
  });
  return res.json();
}

try {
  check("serveur démarré (/healthz)", await waitHealth(), serverLog.slice(-400));

  const reg = await call("registerCompany", {
    companyName: "Test Cartographie",
    ownerEmail: "test-carto@example.com",
    accessCode: "test1234",
    planKey: "forfait_2_equipes",
  });
  check("registerCompany → session", Boolean(reg.data && reg.data.token), JSON.stringify(reg).slice(0, 200));
  token = reg.data.token;

  const client = await call("createClient", { name: "Séminaire de Sherbrooke" });
  const clientId = client.data.id;

  const t1 = await call("createTerrain", {
    clientId,
    address: "195 rue Marquette, Sherbrooke, Québec",
    service: "tonte",
  });
  const t2 = await call("createTerrain", {
    clientId,
    address: "155 rue Belvédère Nord, Sherbrooke, Québec",
    service: "tonte",
  });
  check("terrains créés", Boolean(t1.data?.id && t2.data?.id));

  // --- Recherche cadastrale réelle : 195 rue Marquette
  const look1 = await call("lookupCadastralLot", {
    address: "195 rue Marquette, Sherbrooke, Québec",
  });
  const d1 = look1.data || {};
  check("Marquette : lot trouvé", d1.found === true, JSON.stringify(look1).slice(0, 300));
  check("Marquette : nº de lot PC-44744", d1.lotNumber === "PC-44744", `obtenu ${d1.lotNumber}`);
  check(
    "Marquette : superficie du lot ≈ 22 534 m² (±5 %)",
    d1.lotAreaM2 != null && near(d1.lotAreaM2, 22_534, 1_200),
    `obtenu ${d1.lotAreaM2}`,
  );
  check(
    "Marquette : polygone ≥ 3 points",
    Array.isArray(d1.lotPolygon) && d1.lotPolygon.length >= 3,
    `obtenu ${d1.lotPolygon?.length}`,
  );
  check("Marquette : lots voisins listés", Array.isArray(d1.neighborLots) && d1.neighborLots.length > 0);

  // --- Recherche cadastrale réelle : 155 rue Belvédère Nord
  const look2 = await call("lookupCadastralLot", {
    address: "155 rue Belvédère Nord, Sherbrooke, Québec",
  });
  const d2 = look2.data || {};
  check("Belvédère : lot trouvé", d2.found === true, JSON.stringify(look2).slice(0, 300));
  check("Belvédère : nº de lot 1 031 020", d2.lotNumber === "1 031 020", `obtenu ${d2.lotNumber}`);
  check(
    "Belvédère : superficie du lot ≈ 4 530 m² (±5 %)",
    d2.lotAreaM2 != null && near(d2.lotAreaM2, 4_530, 250),
    `obtenu ${d2.lotAreaM2}`,
  );

  // --- Généralisation : Nouveau-Brunswick (GeoNB, PID)
  const lookNb = await call("lookupCadastralLot", {
    address: "49 Charlotte Street, Saint John, New Brunswick",
  });
  const dNb = lookNb.data || {};
  check("N.-B. : juridiction CA-NB", dNb.jurisdiction === "CA-NB", JSON.stringify(lookNb).slice(0, 200));
  check(
    "N.-B. : lot trouvé (PID numérique)",
    dNb.found === true && /^\d+$/.test(dNb.lotNumber || "") && dNb.lotAreaM2 > 0,
    JSON.stringify(lookNb).slice(0, 300),
  );

  // --- Généralisation : Nouvelle-Écosse (NSPRD, PID)
  const lookNs = await call("lookupCadastralLot", {
    address: "1741 Hollis Street, Halifax, Nova Scotia",
  });
  const dNs = lookNs.data || {};
  check("N.-É. : juridiction CA-NS", dNs.jurisdiction === "CA-NS", JSON.stringify(lookNs).slice(0, 200));
  check(
    "N.-É. : lot trouvé (PID numérique)",
    dNs.found === true && /^\d+$/.test(dNs.lotNumber || "") && dNs.lotAreaM2 > 0,
    JSON.stringify(lookNs).slice(0, 300),
  );

  // --- Généralisation : Colombie-Britannique (ParcelMap BC, WFS)
  // 453 W 12th Ave = hôtel de ville de Vancouver, grande parcelle :
  // le point géocodé tombe dedans (PID 014-570-505 constaté).
  const lookBc = await call("lookupCadastralLot", {
    address: "453 West 12th Avenue, Vancouver, British Columbia",
  });
  const dBc = lookBc.data || {};
  check("C.-B. : juridiction CA-BC", dBc.jurisdiction === "CA-BC", JSON.stringify(lookBc).slice(0, 200));
  check(
    "C.-B. : lot trouvé (PID)",
    dBc.found === true && /[\d-]/.test(dBc.lotNumber || "") && dBc.lotAreaM2 > 0,
    JSON.stringify(lookBc).slice(0, 300),
  );

  // --- Généralisation : Manitoba (rôle provincial, rayon de repli) —
  // le service ne répond pas au point exact : soit un lot contient le
  // point, soit le repli « aucun lot au point » liste les candidates.
  const lookMb = await call("lookupCadastralLot", {
    address: "1000 Victoria Avenue, Brandon, Manitoba",
  });
  const dMb = lookMb.data || {};
  check("MB : juridiction CA-MB + source nommée", dMb.jurisdiction === "CA-MB" && Boolean(dMb.sourceName), JSON.stringify(lookMb).slice(0, 200));
  check(
    "MB : lot contenant le point OU candidates listées (jamais deviné)",
    (dMb.found === true && Boolean(dMb.lotNumber)) ||
      (dMb.found === false && dMb.fallback?.reason === "aucun_lot_au_point" && dMb.neighborLots.length > 0),
    JSON.stringify(lookMb).slice(0, 300),
  );

  // --- Repli par province : Ontario (registre à jeton — liens officiels)
  const lookOn = await call("lookupCadastralLot", {
    address: "100 Queen Street West, Toronto, Ontario",
  });
  const dOn = lookOn.data || {};
  check(
    "Ontario : repli propre (liens officiels, aucun lot inventé)",
    dOn.found === false &&
      dOn.jurisdiction === "CA-ON" &&
      dOn.fallback?.reason === "juridiction_non_automatisee" &&
      dOn.fallback.officialLinks.some((l) => l.url.includes("onland")),
    JSON.stringify(lookOn).slice(0, 300),
  );

  // --- Repli honnête : adresse hors Québec (aucun lot inventé)
  const lookUs = await call("lookupCadastralLot", {
    address: "100 Main Street, Burlington, Vermont, USA",
  });
  const dUs = lookUs.data || {};
  check(
    "Hors Québec : found=false + repli avec liens/champs",
    dUs.found === false && dUs.fallback && Array.isArray(dUs.fallback.manualFields),
    JSON.stringify(lookUs).slice(0, 200),
  );

  // --- Enregistrement des données du lot sur le terrain 1
  const save = await call("saveTerrainRegistryData", {
    terrainId: t1.data.id,
    lotNumber: d1.lotNumber,
    lotPolygon: JSON.stringify(d1.lotPolygon),
    lotAreaPi2: d1.lotAreaPi2,
    lotDimensions: "",
    lotSource: d1.sourceName,
    zoning: "",
  });
  check("saveTerrainRegistryData → ok", save.data?.ok === true, JSON.stringify(save).slice(0, 200));

  // --- Estimation refusée tant qu'aucune surface de travail n'est mesurée
  const est0 = await call("estimateFromTerrainMeasurement", {
    terrainId: t1.data.id,
    services: ["tonte"],
    crewSize: 1,
  });
  check(
    "sans mesure de gazon : estimation refusée avec explication",
    typeof est0.error === "string" && est0.error.includes("surface de travail"),
    JSON.stringify(est0).slice(0, 200),
  );

  // --- Mesure de travail : 1 000 pi² de gazon seulement (action d'origine)
  const meas = await call("saveTerrainMeasurement", {
    terrainId: t1.data.id,
    lotDimensions: "",
    lotAreaPi2: d1.lotAreaPi2 ?? 242556,
    workAreaPi2: 1000,
    workPolygon: "[]",
  });
  check("saveTerrainMeasurement (bundle) → ok", meas.data?.ok === true, JSON.stringify(meas).slice(0, 200));

  // Défauts : 9 min/1000 pi², 100 $/h → 0,15 h × 100 $ = 15,00 $
  const est1 = await call("estimateFromTerrainMeasurement", {
    terrainId: t1.data.id,
    services: ["tonte"],
    crewSize: 1,
  });
  const e1 = est1.data || {};
  check("estimation : minutes = 9", e1.minutes === 9, JSON.stringify(est1).slice(0, 250));
  check("estimation : sous-total = 15,00 $", e1.subtotal === 15, `obtenu ${e1.subtotal}`);
  check(
    "estimation : total = 17,25 $ (TPS 0,75 + TVQ 1,50)",
    e1.grandTotal === 17.25,
    `obtenu ${e1.grandTotal} (tps ${e1.tps}, tvq ${e1.tvq})`,
  );

  // Équipe de 4 : les heures facturées quadruplent, pas le temps écoulé.
  const est4 = await call("estimateFromTerrainMeasurement", {
    terrainId: t1.data.id,
    services: ["tonte"],
    crewSize: 4,
  });
  check(
    "équipe de 4 : sous-total = 60,00 $, minutes inchangées (9)",
    est4.data?.subtotal === 60 && est4.data?.minutes === 9,
    JSON.stringify(est4).slice(0, 200),
  );

  // --- PREUVE CENTRALE : gonfler la superficie du lot ne change RIEN au prix
  await call("saveTerrainRegistryData", {
    terrainId: t1.data.id,
    lotNumber: d1.lotNumber,
    lotPolygon: JSON.stringify(d1.lotPolygon),
    lotAreaPi2: 999_999,
    lotDimensions: "",
    lotSource: "test invariance",
    zoning: "",
  });
  const est2 = await call("estimateFromTerrainMeasurement", {
    terrainId: t1.data.id,
    services: ["tonte"],
    crewSize: 1,
  });
  check(
    "superficie du lot ×41 → prix IDENTIQUE (15,00 $)",
    est2.data?.subtotal === 15 && est2.data?.surfacePi2 === 1000,
    JSON.stringify(est2).slice(0, 200),
  );

  // --- Sans session : refusé (garde de l'hôte)
  token = null;
  const noSess = await call("lookupCadastralLot", {
    address: "195 rue Marquette, Sherbrooke, Québec",
  });
  check(
    "sans session : action refusée",
    typeof noSess.error === "string" && noSess.error.includes("Session requise"),
    JSON.stringify(noSess).slice(0, 150),
  );
} finally {
  server.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nTOUS LES TESTS PASSENT" : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
