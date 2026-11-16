"use strict";

// ============================================================================
// LandCrew — Module « Cartographie et registres »
// ----------------------------------------------------------------------------
// Ordre de Maxime Villeneuve (2026-11-15) : les prix de LandCrew doivent
// partir du VRAI terrain du client, jamais d'une estimation. Ce module
// branche l'application sur les registres officiels du terrain :
//
//   (a) adresse saisie → géocodage (OpenStreetMap Nominatim, comme le
//       reste de l'application) ;
//   (b) requête au cadastre officiel de la juridiction → numéro de lot,
//       polygone du lot, superficie du lot calculée du polygone ;
//   (c) le polygone du lot est retourné au client web, qui l'affiche sur
//       la vue satellite (voir modules/client/CartographieTerrain.tsx) ;
//   (d) la surface de TRAVAIL (gazon seulement — bâtiments, béton et
//       asphalte exclus) reste délimitée par l'entrepreneur sur la vue
//       du dessus (composant TerrainMeasure existant, action
//       saveTerrainMeasurement du bundle d'origine) ;
//   (e) le temps et le prix d'une soumission se calculent à partir de la
//       surface de travail MESURÉE et des taux de l'entreprise (action
//       estimateFromTerrainMeasurement ci-dessous) — JAMAIS à partir de
//       la superficie brute du lot ni d'heures inventées.
//
// REPLI HONNÊTE : si le registre de la juridiction n'est pas interrogeable
// automatiquement (service injoignable, adresse hors Québec, aucun lot
// au point), lookupCadastralLot ne devine RIEN : il retourne found=false,
// la raison, les liens officiels (Infolot, rôle d'évaluation de la
// municipalité) et la liste des champs à saisir à la main (nº de lot,
// superficie officielle du rôle) — enregistrables par
// saveTerrainRegistryData.
//
// SOURCES OFFICIELLES : le répertoire des registres par juridiction
// vit dans modules/registres.js — chaque fournisseur y est inscrit
// seulement après une requête réelle réussie (Québec, Colombie-
// Britannique, Nouveau-Brunswick, Nouvelle-Écosse et Manitoba
// automatisés au 2026-11-15/16 ; les autres provinces et l'étranger
// retombent sur les liens officiels + la saisie manuelle).
//     ATTENTION : ne jamais utiliser le champ « aire » d'un service —
//     il est souvent exprimé en Web Mercator (EPSG:3857), qui gonfle
//     les superficies (~×2 à la latitude du Québec). La superficie
//     retournée ici est recalculée en sphérique (Chamberlain–Duquette,
//     la même formule que le client web).
//   - Géocodage : Nominatim (OpenStreetMap), déjà utilisé par l'app.
//
// INTÉGRATION : app.js fusionne ces actions avec celles du bundle
// d'origine ({ ...Actions, ...cartographie.Actions }) sans modifier le
// bundle. Les définitions suivent le même contrat que le runtime :
// { description, request: { parse }, response: { parse }, handler }.
// Les validations sont écrites à la main (le zod du bundle n'est pas
// exporté) ; elles lèvent des Error au même format que les actions
// d'origine. Aucune dépendance externe hors drizzle-orm (déjà requis
// par l'application) pour les requêtes SQL brutes.
// ============================================================================

const { sql } = require("drizzle-orm");
const {
  REGISTRIES,
  jurisdictionOfGeo,
  registryById,
  officialLinksFor,
} = require("./registres.js");

// ---------------------------------------------------------------------------
// Constantes — taux et réglages (miroirs fidèles du bundle d'origine :
// SETTINGS_DEFAULTS, TPS/TVQ de estimateServices/estimateQuote).
// ---------------------------------------------------------------------------

const TPS_RATE = 0.05;
const TVQ_RATE = 0.09975;
const M2_TO_PI2 = 10.7639;

const SETTINGS_DEFAULTS = {
  hourlyRate: 100,
  mowMinPer1000Pi2: 9,
  snowMinPer1000Pi2: 5,
};

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = "LandCrew/1.0 (module cartographie et registres)";

// ---------------------------------------------------------------------------
// Registres fonciers par juridiction : voir modules/registres.js (le
// répertoire documenté : fournisseurs vérifiés + liens officiels de
// repli, province par province). REGISTRY_PROVIDERS reste exposé pour
// compatibilité (tests) : c'est la liste des fournisseurs automatisés.
// ---------------------------------------------------------------------------

const REGISTRY_PROVIDERS = REGISTRIES.filter((r) => r.provider).map((r) => ({
  ...r.provider,
  id: r.id,
  jurisdiction: r.id,
}));

// Liens officiels retournés en repli quand l'automatisation ne suffit pas.
function fallbackLinks(jurisdiction) {
  return officialLinksFor(jurisdiction);
}

const MANUAL_FIELDS = [
  "lotNumber",
  "lotAreaPi2",
  "lotDimensions",
  "zoning",
];

// ---------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Aire sphérique signée d'un anneau [{lat,lng}] (Chamberlain–Duquette) —
// la même formule que le composant client TerrainMeasure.
function ringAreaM2(points) {
  if (!points || points.length < 3) return 0;
  const R = 6378137;
  const rad = (d) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    total +=
      (rad(p2.lng) - rad(p1.lng)) *
      (2 + Math.sin(rad(p1.lat)) + Math.sin(rad(p2.lat)));
  }
  return (total * R * R) / 2;
}

// Aire d'un polygone (anneau extérieur moins les trous), en m².
function polygonAreaM2(rings) {
  if (!rings || rings.length === 0) return 0;
  let area = Math.abs(ringAreaM2(rings[0]));
  for (let i = 1; i < rings.length; i++) {
    area -= Math.abs(ringAreaM2(rings[i]));
  }
  return Math.max(0, area);
}

// Convertit une géométrie GeoJSON (Polygon/MultiPolygon, coordonnées
// [lng, lat]) en polygones [{ rings: [[{lat,lng}, ...], ...], areaM2 }].
function geojsonPolygons(geometry) {
  if (!geometry) return [];
  const toRing = (ring) =>
    ring.map(([lng, lat]) => ({
      lat: Math.round(lat * 1e7) / 1e7,
      lng: Math.round(lng * 1e7) / 1e7,
    }));
  const polys = [];
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates.map(toRing);
    polys.push({ rings, areaM2: polygonAreaM2(rings) });
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      const rings = poly.map(toRing);
      polys.push({ rings, areaM2: polygonAreaM2(rings) });
    }
  }
  return polys;
}

// Borne le nombre de sommets retournés (les lots complexes peuvent en
// compter des milliers) par décimation régulière ; l'aire est calculée
// AVANT décimation, donc elle n'est pas affectée.
function capVertices(ring, max = 1000) {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Session et réglages — miroirs des helpers du bundle (sessionOf,
// assertOwnerRole, loadSettings) en SQL brut via drizzle.
// ---------------------------------------------------------------------------

async function sessionOf(ctx) {
  const token =
    typeof ctx.sessionToken === "string" && ctx.sessionToken
      ? ctx.sessionToken
      : null;
  if (!token) return null;
  const db = ctx.db();
  const rows = await db.all(
    sql`SELECT company_id, role, employee_id, expires_at FROM sessions WHERE token = ${token}`,
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at != null && Number(row.expires_at) <= Date.now()) {
    return null;
  }
  return {
    companyId: Number(row.company_id),
    role: row.role,
    employeeId: row.employee_id == null ? null : Number(row.employee_id),
  };
}

// Même garde que le bundle : propriétaire seulement ; sur l'hôte
// autonome, pas de session = refus (le repli « compagnie 1 » du runtime
// historique ne s'applique pas ici, car app.js pose hostStandalone).
async function ownerCompanyId(ctx) {
  const session = await sessionOf(ctx);
  if (session) {
    if (session.role !== "proprietaire") {
      throw new Error("Action réservée au propriétaire de l'entreprise.");
    }
    return session.companyId;
  }
  if (ctx.hostStandalone === true) {
    throw new Error("Session requise — connectez-vous à votre entreprise.");
  }
  return 1;
}

async function loadSettings(ctx, companyId) {
  const db = ctx.db();
  const rows = await db.all(sql`SELECT key, value FROM settings`);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...SETTINGS_DEFAULTS };
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    const raw =
      map.get(`co:${companyId}:${key}`) ??
      (companyId === 1 ? map.get(key) : undefined);
    if (raw !== undefined) {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (a) Géocodage — Nominatim avec détails d'adresse (pour la juridiction).
// ---------------------------------------------------------------------------

async function geocode(address) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=" +
    encodeURIComponent(address);
  const data = await fetchJson(url);
  const first = Array.isArray(data) ? data[0] : null;
  if (!first) return null;
  const lat = Number(first.lat);
  const lng = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const addr = first.address || {};
  return {
    lat,
    lng,
    displayName: first.display_name || "",
    boundingbox: Array.isArray(first.boundingbox)
      ? first.boundingbox.map(Number)
      : null,
    state: addr.state || "",
    countryCode: (addr.country_code || "").toLowerCase(),
  };
}

// Détection de juridiction : déléguée au répertoire (registres.js) —
// retourne « CA-QC », « CA-ON », … pour le Canada, null ailleurs. Une
// juridiction détectée n'est pas forcément automatisée : c'est le
// fournisseur du répertoire qui le décide (repli honnête sinon).
function jurisdictionOf(geo) {
  return jurisdictionOfGeo(geo);
}

// Le point {lat,lng} est-il dans l'anneau [{lat,lng}] ? (ray casting)
// Sert à ne retenir comme lot principal, parmi des candidates, que le
// polygone qui CONTIENT le point géocodé — jamais une devinette.
function pointInRing(lat, lng, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng;
    const yi = ring[i].lat;
    const xj = ring[j].lng;
    const yj = ring[j].lat;
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// (b) Registres — requêtes spatiales. Deux familles de fournisseurs
// (voir registres.js) : « arcgis » (REST, GeoJSON) et « wfs »
// (ParcelMap BC). Dans tous les cas, la superficie est recalculée du
// polygone par geojsonPolygons — jamais lue du champ « aire » du service.
// ---------------------------------------------------------------------------

async function cadastreQuery(provider, geometry, geometryType, extra = {}, inSR = "4326") {
  const params = new URLSearchParams({
    geometry: geometry.join(","),
    geometryType,
    inSR,
    spatialRel: "esriSpatialRelIntersects",
    outFields: provider.lotField || "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
    resultRecordCount: "100",
    ...extra,
  });
  const data = await fetchJson(`${provider.queryUrl}?${params.toString()}`);
  return Array.isArray(data.features) ? data.features : [];
}

// Projection WGS84 → UTM (séries de Snyder, ellipsoïde WGS84) — pour
// les services qui n'acceptent les requêtes spatiales que dans leur SR
// natif projeté (Manitoba : EPSG:26914). Vérifiée contre le service de
// projection d'Esri : Winnipeg → (633613.40, 5529104.53), écart < 1 m.
function latLngToUtm(lat, lng, zone) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const latR = (lat * Math.PI) / 180;
  const lngR = (lng * Math.PI) / 180;
  const lng0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const T = Math.tan(latR) ** 2;
  const C = ep2 * cosLat * cosLat;
  const A = cosLat * (lngR - lng0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * latR -
      (3 * e2 / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) *
        Math.sin(2 * latR) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latR) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * latR));
  const x =
    k0 *
      N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000;
  const y =
    k0 *
    (M +
      N *
        Math.tan(latR) *
        (A ** 2 / 2 +
          ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
          ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { x, y };
}

// lotField : nom du champ identifiant, ou liste de champs par priorité.
function featureToLot(feature, lotField) {
  const polys = geojsonPolygons(feature.geometry);
  if (polys.length === 0) return null;
  polys.sort((a, b) => b.areaM2 - a.areaM2);
  const main = polys[0];
  const totalM2 = polys.reduce((s, p) => s + p.areaM2, 0);
  const fields = Array.isArray(lotField) ? lotField : [lotField];
  let lotNumber = "";
  for (const f of fields) {
    const v = feature.properties && feature.properties[f];
    if (v != null && String(v).trim() !== "") {
      lotNumber = String(v).trim();
      break;
    }
  }
  return {
    lotNumber,
    polygon: capVertices(main.rings[0] || []),
    areaM2: round1(totalM2),
  };
}

async function lookupQuebecLot(provider, geo) {
  // 1) Le lot qui contient le point géocodé.
  const atPoint = await cadastreQuery(
    provider,
    [geo.lng, geo.lat],
    "esriGeometryPoint",
  );
  let primary = atPoint.length ? featureToLot(atPoint[0], "NO_LOT") : null;

  // 2) Les lots voisins dans l'emprise du site (un campus peut couvrir
  //    plusieurs lots ; l'entrepreneur choisit celui du terrain).
  let envelope;
  if (geo.boundingbox && geo.boundingbox.length === 4) {
    const [south, north, west, east] = geo.boundingbox;
    envelope = [west, south, east, north];
  } else {
    const d = 0.0015;
    envelope = [geo.lng - d, geo.lat - d, geo.lng + d, geo.lat + d];
  }
  let neighbors = [];
  try {
    const feats = await cadastreQuery(
      provider,
      envelope,
      "esriGeometryEnvelope",
    );
    neighbors = feats
      .map((f) => featureToLot(f, "NO_LOT"))
      .filter(Boolean)
      .filter((l) => !primary || l.lotNumber !== primary.lotNumber)
      .sort((a, b) => b.areaM2 - a.areaM2)
      .slice(0, 20)
      .map((l) => ({ lotNumber: l.lotNumber, areaM2: l.areaM2 }));
  } catch {
    neighbors = [];
  }

  // 3) Aucun lot au point : on retourne les candidats de l'emprise en
  //    repli plutôt que de deviner.
  if (!primary && neighbors.length) {
    return { primary: null, neighbors };
  }
  return { primary, neighbors };
}

// Fournisseur ArcGIS générique (NB, NS, MB) : requête par point ; si le
// service l'exige (bufferMeters — constaté au Manitoba), seconde requête
// avec un rayon autour du point. Dans ce cas, seul le polygone qui
// CONTIENT le point devient le lot principal ; les autres parcelles
// touchées par le rayon sont des candidates, jamais un choix deviné.
async function lookupArcgisLot(provider, geo) {
  // Certains services (Manitoba) n'acceptent les requêtes spatiales
  // que dans leur SR natif projeté : on projette le point en UTM et la
  // requête part en EPSG:269xx (la géométrie revient en 4326, outSR).
  let point = [geo.lng, geo.lat];
  let inSR = "4326";
  if (provider.projectToUtm > 0) {
    const p = latLngToUtm(geo.lat, geo.lng, provider.projectToUtm);
    point = [p.x, p.y];
    inSR = String(26900 + provider.projectToUtm);
  }
  let feats = await cadastreQuery(
    provider,
    point,
    "esriGeometryPoint",
    {},
    inSR,
  );
  let fromIntersect = feats.length > 0;
  if (!feats.length && provider.bufferMeters > 0) {
    feats = await cadastreQuery(
      provider,
      point,
      "esriGeometryPoint",
      { distance: String(provider.bufferMeters), units: "esriSRUnit_Meter" },
      inSR,
    );
    fromIntersect = false;
  }
  const lots = feats
    .map((f) => featureToLot(f, provider.lotField))
    .filter(Boolean);
  let primary = null;
  if (fromIntersect) {
    primary = lots[0] || null;
  } else if (lots.length) {
    primary =
      lots.find((l) => pointInRing(geo.lat, geo.lng, l.polygon)) || null;
  }
  const neighbors = lots
    .filter((l) => !primary || l.lotNumber !== primary.lotNumber)
    .sort((a, b) => b.areaM2 - a.areaM2)
    .slice(0, 20)
    .map((l) => ({ lotNumber: l.lotNumber, areaM2: l.areaM2 }));
  return { primary, neighbors };
}

// Fournisseur WFS (ParcelMap BC) : GetFeature sur une petite emprise
// autour du point (srsName=EPSG:4326 — sinon géométrie en BC Albers),
// puis sélection du polygone qui contient le point.
async function lookupWfsLot(provider, geo) {
  // Petite emprise (±0,0006° ≈ 65 m) et plafond élevé : dans les
  // secteurs denses (strates), un plafond bas tronque le résultat avant
  // la parcelle qui contient le point (constaté à Vancouver).
  const d = 0.0006;
  const bbox = [geo.lng - d, geo.lat - d, geo.lng + d, geo.lat + d].join(",");
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: provider.typeName,
    bbox: `${bbox},EPSG:4326`,
    outputFormat: "application/json",
    count: "500",
    srsName: "EPSG:4326",
  });
  const data = await fetchJson(`${provider.queryUrl}?${params.toString()}`);
  const feats = Array.isArray(data.features) ? data.features : [];
  const lots = feats
    .map((f) => featureToLot(f, provider.lotFields))
    .filter(Boolean);
  const primary =
    lots.find((l) => pointInRing(geo.lat, geo.lng, l.polygon)) || null;
  const neighbors = lots
    .filter((l) => !primary || l.lotNumber !== primary.lotNumber)
    .sort((a, b) => b.areaM2 - a.areaM2)
    .slice(0, 20)
    .map((l) => ({ lotNumber: l.lotNumber, areaM2: l.areaM2 }));
  return { primary, neighbors };
}

async function lookupLot(provider, geo, jurisdictionId) {
  if (provider.kind === "wfs") return lookupWfsLot(provider, geo);
  if (jurisdictionId === "CA-QC") return lookupQuebecLot(provider, geo);
  return lookupArcgisLot(provider, geo);
}

// ---------------------------------------------------------------------------
// Validations d'entrée (équivalent minimal des schémas zod du bundle :
// mêmes messages d'erreur explicites, aucune valeur inventée).
// ---------------------------------------------------------------------------

function bad(msg) {
  throw new Error(`cartographie: ${msg}`);
}

function parseLookupArgs(a) {
  if (!a || typeof a !== "object") bad("arguments manquants");
  if (typeof a.address !== "string" || a.address.trim().length < 3) {
    bad("address doit contenir au moins 3 caractères");
  }
  return {
    address: a.address.trim(),
    includeNeighbors: a.includeNeighbors !== false,
  };
}

function parseSaveRegistryArgs(a) {
  if (!a || typeof a !== "object") bad("arguments manquants");
  if (!Number.isInteger(a.terrainId) || a.terrainId <= 0) {
    bad("terrainId doit être un entier positif");
  }
  const str = (v, name) => {
    if (v == null) return "";
    if (typeof v !== "string") bad(`${name} doit être une chaîne`);
    return v;
  };
  const lotPolygon = str(a.lotPolygon, "lotPolygon");
  if (lotPolygon) {
    let parsed;
    try {
      parsed = JSON.parse(lotPolygon);
    } catch {
      bad("lotPolygon doit être un JSON valide");
    }
    if (!Array.isArray(parsed)) bad("lotPolygon doit être un tableau");
    for (const p of parsed) {
      if (
        !p ||
        typeof p.lat !== "number" ||
        typeof p.lng !== "number" ||
        !Number.isFinite(p.lat) ||
        !Number.isFinite(p.lng)
      ) {
        bad("lotPolygon doit contenir des points {lat, lng} numériques");
      }
    }
  }
  let lotAreaPi2 = null;
  if (a.lotAreaPi2 != null) {
    if (
      typeof a.lotAreaPi2 !== "number" ||
      !Number.isFinite(a.lotAreaPi2) ||
      a.lotAreaPi2 <= 0
    ) {
      bad("lotAreaPi2 doit être un nombre positif ou null");
    }
    lotAreaPi2 = a.lotAreaPi2;
  }
  return {
    terrainId: a.terrainId,
    lotNumber: str(a.lotNumber, "lotNumber"),
    lotPolygon,
    lotAreaPi2,
    lotDimensions: str(a.lotDimensions, "lotDimensions"),
    lotSource: str(a.lotSource, "lotSource"),
    zoning: str(a.zoning, "zoning"),
  };
}

function parseEstimateArgs(a) {
  if (!a || typeof a !== "object") bad("arguments manquants");
  if (!Number.isInteger(a.terrainId) || a.terrainId <= 0) {
    bad("terrainId doit être un entier positif");
  }
  if (
    !Array.isArray(a.services) ||
    a.services.length === 0 ||
    !a.services.every((s) => s === "tonte" || s === "deneigement")
  ) {
    bad("services doit contenir « tonte » et/ou « deneigement »");
  }
  const crewSize = a.crewSize == null ? 1 : a.crewSize;
  if (!Number.isInteger(crewSize) || crewSize < 1) {
    bad("crewSize doit être un entier positif");
  }
  return {
    terrainId: a.terrainId,
    services: [...new Set(a.services)],
    crewSize,
  };
}

// Réponse : le runtime appelle response.parse(result) ; on retourne le
// résultat tel quel (les handlers construisent exactement la forme
// documentée ci-dessous).
const identity = { parse: (r) => r };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const Actions = {
  // (a)+(b)+(c) Adresse → lot cadastral officiel (ou repli honnête).
  lookupCadastralLot: {
    description:
      "Cartographie et registres : géocode une adresse puis interroge le cadastre officiel de la juridiction (répertoire modules/registres.js — Québec, Colombie-Britannique, Nouveau-Brunswick, Nouvelle-Écosse et Manitoba automatisés et vérifiés) pour retourner le numéro de lot, le polygone du lot et sa superficie calculée. En cas d'échec, retourne found=false avec les liens officiels et les champs à saisir à la main — ne devine jamais un lot.",
    request: { parse: parseLookupArgs },
    response: identity,
    async handler(ctx, args) {
      await ownerCompanyId(ctx); // garde propriétaire + session
      const base = {
        found: false,
        address: args.address,
        lat: null,
        lng: null,
        displayName: null,
        jurisdiction: null,
        lotNumber: null,
        lotPolygon: [],
        lotAreaM2: null,
        lotAreaPi2: null,
        neighborLots: [],
        sourceName: null,
        sourceUrl: null,
        officialUrl: null,
        officialLabel: null,
        note: "",
        fallback: null,
      };

      let geo = null;
      try {
        geo = await geocode(args.address);
      } catch {
        geo = null;
      }
      if (!geo) {
        return {
          ...base,
          note: "Adresse introuvable au géocodage (OpenStreetMap).",
          fallback: {
            reason: "geocodage_sans_resultat",
            officialLinks: fallbackLinks(null),
            manualFields: MANUAL_FIELDS,
          },
        };
      }
      base.lat = geo.lat;
      base.lng = geo.lng;
      base.displayName = geo.displayName;

      const jurisdiction = jurisdictionOf(geo);
      base.jurisdiction = jurisdiction;
      const registry = registryById(jurisdiction);
      const provider = registry ? registry.provider : null;
      if (!provider) {
        return {
          ...base,
          note: registry
            ? `Le registre foncier de cette juridiction (${registry.label}) n'est pas encore interrogeable automatiquement par LandCrew. Consultez le registre officiel de la province/du pays du terrain, puis saisissez le nº de lot et la superficie officielle.`
            : "Le registre foncier de cette juridiction n'est pas encore interrogeable automatiquement par LandCrew. Consultez le registre officiel de la province/du pays du terrain, puis saisissez le nº de lot et la superficie officielle.",
          fallback: {
            reason: "juridiction_non_automatisee",
            officialLinks: fallbackLinks(jurisdiction),
            manualFields: MANUAL_FIELDS,
          },
        };
      }

      let result;
      try {
        result = await lookupLot(provider, geo, jurisdiction);
      } catch (e) {
        return {
          ...base,
          sourceName: provider.name,
          sourceUrl: provider.queryUrl,
          officialUrl: provider.officialUrl,
          officialLabel: provider.officialLabel,
          note: `Le service cadastral n'a pas répondu (${e && e.message ? e.message : "erreur réseau"}). Réessayez ou consultez le registre officiel (${provider.officialLabel}), puis saisissez les données à la main.`,
          fallback: {
            reason: "registre_injoignable",
            officialLinks: fallbackLinks(jurisdiction),
            manualFields: MANUAL_FIELDS,
          },
        };
      }

      const { primary, neighbors } = result;
      const out = {
        ...base,
        sourceName: provider.name,
        sourceUrl: provider.queryUrl,
        officialUrl: provider.officialUrl,
        officialLabel: provider.officialLabel,
        neighborLots: args.includeNeighbors ? neighbors : [],
      };
      if (!primary) {
        return {
          ...out,
          note:
            "Aucun lot cadastral ne contient le point géocodé de cette adresse. Les lots voisins sont listés à titre de candidats — vérifiez au registre officiel lequel couvre le terrain du client, puis saisissez-le.",
          fallback: {
            reason: "aucun_lot_au_point",
            officialLinks: fallbackLinks(jurisdiction),
            manualFields: MANUAL_FIELDS,
          },
        };
      }
      return {
        ...out,
        found: true,
        lotNumber: primary.lotNumber,
        lotPolygon: primary.polygon,
        lotAreaM2: primary.areaM2,
        lotAreaPi2: round1(primary.areaM2 * M2_TO_PI2),
        note:
          "Superficie du lot calculée du polygone cadastral (sphérique). La superficie OFFICIELLE reste celle du rôle d'évaluation / du registre officiel de la juridiction ; la surface de travail (gazon seulement) se délimite sur la vue du dessus et seule elle sert au prix.",
      };
    },
  },

  // Enregistre les données du registre sur un terrain (automatiques ou
  // saisies à la main en repli). N'écrit QUE les colonnes du registre —
  // ne touche ni aux soumissions ni à la surface de travail.
  saveTerrainRegistryData: {
    description:
      "Saves a terrain's registry data (lot number, lot polygon, official lot surface, dimensions, source, zoning) from the cadastral lookup or from manual entry via the official registry links.",
    request: { parse: parseSaveRegistryArgs },
    response: identity,
    async handler(ctx, args) {
      const companyId = await ownerCompanyId(ctx);
      const db = ctx.db();
      const rs = await db.run(sql`
        UPDATE terrains
        SET lot_number = ${args.lotNumber},
            lot_polygon = ${args.lotPolygon},
            lot_area_pi2 = ${args.lotAreaPi2},
            lot_dimensions = ${args.lotDimensions},
            lot_source = ${args.lotSource},
            zoning = ${args.zoning}
        WHERE id = ${args.terrainId} AND company_id = ${companyId}
      `);
      // libsql rapporte le nombre de lignes touchées ; 0 = terrain
      // introuvable dans l'espace de l'entreprise.
      if (rs.rowsAffected != null && Number(rs.rowsAffected) === 0) {
        throw new Error("saveTerrainRegistryData: terrain introuvable");
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  },

  // (e) Temps + prix à partir de la surface de travail MESURÉE du
  // terrain (gazon seulement) et des taux de l'entreprise. La superficie
  // du lot n'entre JAMAIS dans le calcul — elle n'est retournée que pour
  // affichage/contraste.
  estimateFromTerrainMeasurement: {
    description:
      "Estimates time and price for a terrain from its MEASURED work surface only (workAreaPi2 — lawn only, delimited on the top-down view) and the company's rates. The lot surface is never used in the math. Throws when no work surface has been measured yet.",
    request: { parse: parseEstimateArgs },
    response: identity,
    async handler(ctx, args) {
      const companyId = await ownerCompanyId(ctx);
      const db = ctx.db();
      const rows = await db.all(sql`
        SELECT id, address, work_area_pi2, lot_area_pi2
        FROM terrains
        WHERE id = ${args.terrainId} AND company_id = ${companyId}
      `);
      const terrain = rows[0];
      if (!terrain) {
        throw new Error("estimateFromTerrainMeasurement: terrain introuvable");
      }
      const surfacePi2 =
        terrain.work_area_pi2 == null ? null : Number(terrain.work_area_pi2);
      if (surfacePi2 == null || !(surfacePi2 > 0)) {
        throw new Error(
          "Aucune surface de travail mesurée pour ce terrain : délimitez d'abord le gazon seulement sur la vue du dessus (bâtiments, béton et asphalte exclus). Le prix ne se calcule jamais sur la superficie brute du lot.",
        );
      }

      const s = await loadSettings(ctx, companyId);
      // Même moteur que estimateServices/estimateQuote du bundle.
      let minutes = 0;
      const lines = [];
      for (const svc of args.services) {
        const rate =
          svc === "tonte" ? s.mowMinPer1000Pi2 : s.snowMinPer1000Pi2;
        const m = (surfacePi2 / 1000) * rate;
        minutes += m;
        const hours = round2(m / 60);
        lines.push({
          description:
            svc === "tonte"
              ? `Tonte de pelouse — ${Math.round(surfacePi2).toLocaleString("fr-CA")} pi² mesurés (gazon seulement)`
              : `Déneigement — ${Math.round(surfacePi2).toLocaleString("fr-CA")} pi² mesurés (surface de travail)`,
          qty: hours,
          unitPrice: s.hourlyRate,
        });
      }
      minutes = Math.round(minutes);
      const manMinutes = minutes * args.crewSize;
      const billedLines =
        args.crewSize === 1
          ? lines
          : lines.map((l) => ({
              ...l,
              description: `${l.description} — équipe de ${args.crewSize}`,
              qty: round2(l.qty * args.crewSize),
            }));
      const subtotal = round2(
        billedLines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0),
      );
      const tps = round2(subtotal * TPS_RATE);
      const tvq = round2(subtotal * TVQ_RATE);
      return {
        terrainId: terrain.id,
        address: terrain.address,
        surfacePi2,
        lotAreaPi2:
          terrain.lot_area_pi2 == null ? null : Number(terrain.lot_area_pi2),
        basedOnMeasuredWorkArea: true,
        minutes,
        manMinutes,
        lines: billedLines,
        subtotal,
        tps,
        tvq,
        grandTotal: round2(subtotal + tps + tvq),
      };
    },
  },
};

module.exports = {
  Actions,
  // Exposés pour les tests (tests/cartographie.test.mjs).
  _internals: {
    ringAreaM2,
    polygonAreaM2,
    geojsonPolygons,
    jurisdictionOf,
    pointInRing,
    latLngToUtm,
    REGISTRY_PROVIDERS,
    REGISTRIES,
    registryById,
    fallbackLinks,
  },
};
