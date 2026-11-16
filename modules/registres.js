"use strict";

// ============================================================================
// LandCrew — Module « Cartographie et registres » : répertoire des registres
// ----------------------------------------------------------------------------
// Ordre de Maxime Villeneuve (2026-11-15) : LandCrew doit fonctionner avec
// les cadastres de ville en ville et de province en province — sinon
// l'application ne sert à rien. Ce fichier est le RÉPERTOIRE des registres
// fonciers par juridiction (province/pays) : pour chacune, soit un
// fournisseur interrogeable automatiquement (endpoint public VÉRIFIÉ par
// une requête réelle avant d'être inscrit ici), soit le REPLI HONNÊTE :
// les liens officiels du registre + la saisie manuelle du nº de lot et de
// la superficie officielle (voir cartographie.js, saveTerrainRegistryData).
//
// RÈGLE D'OR : aucun endpoint inventé. Un fournisseur n'entre dans ce
// répertoire qu'après une requête réelle réussie, consignée ci-dessous
// avec sa date et son résultat. Les superficies ne sont JAMAIS lues du
// champ « aire » du service (souvent en Web Mercator, gonflé) : elles
// sont recalculées du polygone en sphérique par cartographie.js.
//
// FOURNISSEURS VÉRIFIÉS (requêtes réelles, 2026-11-15/16) :
//   - CA-QC : ArcGIS REST « Lots du cadastre rénové » (MRNF, diffusion
//     MELCCFP) — 195 rue Marquette, Sherbrooke → lot PC-44744 ;
//     155 rue Belvédère Nord → lot 1 031 020. Champ : NO_LOT.
//   - CA-BC : WFS ouvert de ParcelMap BC (LTSA) sur openmaps.gov.bc.ca,
//     couche WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW, srsName=EPSG:4326
//     (sans srsName, la géométrie revient en BC Albers) — secteur de
//     455 W Broadway, Vancouver → PID 025-403-508 et voisins. Champs :
//     PID_FORMATTED, puis PID.
//   - CA-NB : ArcGIS REST GeoNB « GeoNB_SNB_Parcels » couche 0 (Service
//     Nouveau-Brunswick) — point à Saint John → PID 00010827. Champ : PID.
//   - CA-NS : ArcGIS REST « PLAN_NSPRD_WM84 » couche 0 (Service Nova
//     Scotia, base NSPRD) — point à Halifax → PID 40536872. Champ : PID.
//   - CA-MB : ArcGIS Online hébergé par la Province du Manitoba,
//     « ROLL_ENTRY » couche MG_ROLL_ENTRY_POLY — l'interrogation par
//     point exact retourne 0 résultat sur ce service (constaté à
//     Winnipeg et Brandon) ; avec un rayon de 25 m, la parcelle voisine
//     du point est retournée (Brandon → rôle 555276.000, 3800 Victoria
//     Ave). Le fournisseur déclare donc bufferMeters: 25 et
//     cartographie.js ne retient comme lot principal que le polygone qui
//     CONTIENT le point (calculé côté serveur) — jamais une devinette.
//     Champ : Roll_No_Txt (nº de rôle d'évaluation = identifiant du
//     terrain au Manitoba). Couverture : rôle provincial ; la Ville de
//     Winnipeg tient son propre rôle — à valider au cas par cas.
//
// JURIDICTIONS EN REPLI (aucun service public interrogeable vérifié) :
//   - CA-ON : le service officiel LIO « Assessment_Parcel_Map » exige un
//     jeton (dossier LIO = 403, vérifié 2026-11-15) ; les parcelles
//     passent par OnLand/MPAC. Repli + liens.
//   - CA-AB (titres fonciers/SPIN2, payant), CA-SK (ISC, payant),
//     CA-PE (couches téléchargeables seulement), CA-NL, CA-YT, CA-NT,
//     CA-NU : repli + liens officiels vérifiés (HTTP 200 le 2026-11-15,
//     sauf mention contraire).
//   - Hors Canada : repli générique (registre foncier du pays).
//
// POUR AJOUTER UNE JURIDICTION : une entrée dans REGISTRIES avec ses
// stateNames (formes retournées par le géocodeur, EN et FR), son
// fournisseur vérifié (kind « arcgis » générique ou nouveau kind dans
// cartographie.js) ou ses liens officiels, puis un test dans
// tests/cartographie.test.mjs.
// ============================================================================

// Fournisseur ArcGIS REST générique : interrogation spatiale par point
// (+ rayon de repli optionnel), géométrie GeoJSON en EPSG:4326, numéro
// de lot lu dans lotField. La sélection du lot qui contient le point et
// le calcul de superficie sont faits par cartographie.js.
function arcgisProvider(o) {
  return {
    kind: "arcgis",
    queryUrl: o.queryUrl,
    lotField: o.lotField,
    bufferMeters: o.bufferMeters || 0,
    // Si le service n'accepte les requêtes spatiales que dans son SR
    // natif projeté : numéro de zone UTM (le point est projeté par
    // cartographie.js et la requête part en EPSG:269xx). 0 = EPSG:4326.
    projectToUtm: o.projectToUtm || 0,
    name: o.name,
    officialUrl: o.officialUrl,
    officialLabel: o.officialLabel,
  };
}

const REGISTRIES = [
  {
    id: "CA-QC",
    country: "CA",
    region: "QC",
    label: "Québec",
    stateNames: ["québec", "quebec"],
    provider: arcgisProvider({
      // Interface de requête REST du service ArcGIS (couche 0 « Lots du
      // cadastre rénové »). Le service n'expose PAS de WFS (vérifié :
      // le chemin WFSServer répond « Invalid URL »).
      queryUrl:
        "https://geo.environnement.gouv.qc.ca/donnees/rest/services/Reference/Cadastre_allege/MapServer/0/query",
      lotField: "NO_LOT",
      name: "Cadastre du Québec — Lots du cadastre rénové (MRNF)",
      officialUrl: "https://appli.foncier.gouv.qc.ca/Infolot",
      officialLabel: "Infolot — Cadastre du Québec (consultation officielle)",
    }),
    officialLinks: [
      {
        label: "Infolot — Cadastre du Québec (nº de lot, plan du lot)",
        url: "https://appli.foncier.gouv.qc.ca/Infolot",
      },
      {
        label:
          "Rôle d'évaluation foncière de la municipalité du terrain (superficie officielle) — ex. Sherbrooke",
        url: "https://www.sherbrooke.ca/evaluationfonciere",
      },
    ],
  },
  {
    id: "CA-BC",
    country: "CA",
    region: "BC",
    label: "Colombie-Britannique",
    stateNames: ["british columbia", "colombie-britannique"],
    provider: {
      kind: "wfs",
      // WFS ouvert de ParcelMap BC (LTSA). srsName=EPSG:4326 est
      // obligatoire (sinon géométrie en BC Albers, EPSG:3005).
      queryUrl:
        "https://openmaps.gov.bc.ca/geo/pub/WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW/ows",
      typeName: "WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW",
      lotFields: ["PID_FORMATTED", "PID"],
      name: "ParcelMap BC — parcelles cadastrales (LTSA)",
      officialUrl: "https://parcelmapbc.ltsa.ca/pmBCV3/",
      officialLabel: "ParcelMap BC — LTSA (consultation officielle)",
    },
    officialLinks: [
      {
        label: "ParcelMap BC — LTSA (carte officielle des parcelles)",
        url: "https://parcelmapbc.ltsa.ca/pmBCV3/",
      },
      {
        label: "LTSA — Land Title and Survey Authority of BC",
        url: "https://www.ltsa.ca",
      },
    ],
  },
  {
    id: "CA-AB",
    country: "CA",
    region: "AB",
    label: "Alberta",
    stateNames: ["alberta"],
    provider: null, // Titres fonciers / SPIN2 : service payant, pas d'endpoint public vérifié.
    officialLinks: [
      {
        label: "Alberta Land Titles (titres fonciers, recherche SPIN2)",
        url: "https://www.alberta.ca/land-titles",
      },
    ],
  },
  {
    id: "CA-SK",
    country: "CA",
    region: "SK",
    label: "Saskatchewan",
    stateNames: ["saskatchewan"],
    provider: null, // ISC : registre payant, pas d'endpoint public vérifié.
    officialLinks: [
      {
        label: "ISC — Information Services Corporation (registre foncier)",
        url: "https://www.isc.ca",
      },
    ],
  },
  {
    id: "CA-MB",
    country: "CA",
    region: "MB",
    label: "Manitoba",
    stateNames: ["manitoba"],
    provider: arcgisProvider({
      // Service hébergé de la Province du Manitoba (rôle d'évaluation).
      // Constaté le 2026-11-15/16 : les requêtes spatiales en EPSG:4326
      // retournent 0 résultat sur ce service ; en UTM 14N (EPSG:26914,
      // le SR natif de la couche) avec un rayon de 25 m, la parcelle est
      // retournée. D'où projectToUtm: 14 + bufferMeters: 25, et la
      // sélection par containment côté serveur (voir registres.js).
      queryUrl:
        "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/ROLL_ENTRY/FeatureServer/0/query",
      lotField: "Roll_No_Txt",
      bufferMeters: 25,
      projectToUtm: 14,
      name: "Rôle d'évaluation du Manitoba — parcelles du rôle (Province du Manitoba)",
      officialUrl: "https://www.gov.mb.ca/assessment/",
      officialLabel: "Manitoba Property Assessment (consultation officielle)",
    }),
    officialLinks: [
      {
        label: "Manitoba Property Assessment (rôle d'évaluation provincial)",
        url: "https://www.gov.mb.ca/assessment/",
      },
      {
        label: "Teranet Manitoba (titres fonciers)",
        url: "https://www.teranetmanitoba.ca",
      },
    ],
  },
  {
    id: "CA-ON",
    country: "CA",
    region: "ON",
    label: "Ontario",
    stateNames: ["ontario"],
    provider: null, // Service LIO officiel à jeton (403 vérifié) ; parcelles via OnLand/MPAC.
    officialLinks: [
      {
        label: "OnLand — registre foncier de l'Ontario (ServiceOntario/Teraview)",
        url: "https://www.onland.ca",
      },
      {
        label: "MPAC — évaluation foncière (numéro de rôle)",
        url: "https://www.mpac.ca",
      },
    ],
  },
  {
    id: "CA-NB",
    country: "CA",
    region: "NB",
    label: "Nouveau-Brunswick",
    stateNames: ["new brunswick", "nouveau-brunswick"],
    provider: arcgisProvider({
      queryUrl:
        "https://geonb.snb.ca/arcgis/rest/services/GeoNB_SNB_Parcels/MapServer/0/query",
      lotField: "PID",
      name: "GeoNB — parcelles foncières (Service Nouveau-Brunswick)",
      officialUrl: "https://geonb.snb.ca",
      officialLabel: "GeoNB — cartographie officielle du Nouveau-Brunswick",
    }),
    officialLinks: [
      {
        label: "GeoNB — parcelles et cartographie officielle",
        url: "https://geonb.snb.ca",
      },
      {
        label: "Service Nouveau-Brunswick (évaluation foncière)",
        url: "https://www.snb.ca",
      },
    ],
  },
  {
    id: "CA-NS",
    country: "CA",
    region: "NS",
    label: "Nouvelle-Écosse",
    stateNames: ["nova scotia", "nouvelle-écosse", "nouvelle-ecosse"],
    provider: arcgisProvider({
      queryUrl:
        "https://nsgiwa2.novascotia.ca/arcgis/rest/services/PLAN/PLAN_NSPRD_WM84/MapServer/0/query",
      lotField: "PID",
      name: "NSPRD — limites de propriétés (Service Nova Scotia)",
      officialUrl:
        "https://www.novascotia.ca/sns/access/land/property-online.asp",
      officialLabel: "Property Online — Service Nova Scotia (consultation officielle)",
    }),
    officialLinks: [
      {
        label: "Property Online — Service Nova Scotia (PID, registre foncier)",
        url: "https://www.novascotia.ca/sns/access/land/property-online.asp",
      },
    ],
  },
  {
    id: "CA-PE",
    country: "CA",
    region: "PE",
    label: "Île-du-Prince-Édouard",
    stateNames: [
      "prince edward island",
      "île-du-prince-édouard",
      "ile-du-prince-edouard",
    ],
    provider: null, // Couches cadastrales en téléchargement seulement ; pas de service de requête vérifié.
    officialLinks: [
      {
        label: "Î.-P.-É. — taxe foncière et information sur les propriétés (PID)",
        url: "https://www.princeedwardisland.ca/en/information/finance/property-tax",
      },
    ],
  },
  {
    id: "CA-NL",
    country: "CA",
    region: "NL",
    label: "Terre-Neuve-et-Labrador",
    stateNames: [
      "newfoundland and labrador",
      "terre-neuve-et-labrador",
      "newfoundland",
    ],
    provider: null,
    officialLinks: [
      {
        label: "Registry of Deeds, Companies and Land Titles (T.-N.-L.)",
        url: "https://www.gov.nl.ca/dgsnl/registries/",
      },
    ],
  },
  {
    id: "CA-YT",
    country: "CA",
    region: "YT",
    label: "Yukon",
    stateNames: ["yukon"],
    provider: null, // GeoYukon expose tenure/planification, pas un tissu de parcelles civiques vérifié.
    officialLinks: [
      {
        label: "GeoYukon — services cartographiques officiels du Yukon",
        url: "https://mapservices.gov.yk.ca/arcgis/rest/services",
      },
    ],
  },
  {
    id: "CA-NT",
    country: "CA",
    region: "NT",
    label: "Territoires du Nord-Ouest",
    stateNames: ["northwest territories", "territoires du nord-ouest"],
    provider: null,
    officialLinks: [],
  },
  {
    id: "CA-NU",
    country: "CA",
    region: "NU",
    label: "Nunavut",
    stateNames: ["nunavut"],
    provider: null,
    officialLinks: [],
  },
];

// ---------------------------------------------------------------------------
// Détection de juridiction à partir du géocodage (Nominatim addressdetails :
// country_code + state). Retourne l'id du répertoire (« CA-QC », …) ou
// null hors Canada / province inconnue.
// ---------------------------------------------------------------------------

function jurisdictionOfGeo(geo) {
  if (!geo || geo.countryCode !== "ca") return null;
  const state = (geo.state || "").toLowerCase();
  for (const r of REGISTRIES) {
    if (r.stateNames.some((n) => state.includes(n))) return r.id;
  }
  return null;
}

function registryById(id) {
  return REGISTRIES.find((r) => r.id === id) || null;
}

// Liens officiels de repli pour une juridiction (ou [] si inconnue).
function officialLinksFor(id) {
  const r = registryById(id);
  return r ? r.officialLinks : [];
}

module.exports = {
  REGISTRIES,
  jurisdictionOfGeo,
  registryById,
  officialLinksFor,
};
