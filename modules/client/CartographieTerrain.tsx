// ============================================================================
// LandCrew — Module « Cartographie et registres » : panneau client
// ----------------------------------------------------------------------------
// À intégrer dans l'écran d'évaluation du terrain (TerrainMeasure.tsx),
// au-dessus des champs « dimensions du lot / superficie du lot » actuels.
//
// Rôle : un bouton « Chercher le lot au cadastre » appelle l'action
// serveur lookupCadastralLot avec l'adresse du terrain et affiche le
// résultat officiel : nº de lot, polygone du lot (à dessiner en
// surimpression dans le SVG de TerrainMeasure — voir INTEGRATION-CLIENT.md),
// superficie du lot calculée du polygone. Si le registre ne répond pas
// ou si la juridiction n'est pas automatisée, le panneau bascule en
// REPLI HONNÊTE : liens officiels (Infolot, rôle d'évaluation) + champs
// de saisie manuelle, enregistrés par saveTerrainRegistryData.
//
// Le prix ne part JAMAIS d'ici : il part de la surface de travail
// (gazon seulement) délimitée dans TerrainMeasure et de l'action
// estimateFromTerrainMeasurement.
//
// Types : les trois actions sont fusionnées côté serveur (hôte
// autonome). Lors du port dans l'artefact, ajouter les mêmes actions à
// server/src/actions.ts pour que le client typé les connaisse ; en
// attendant, ce fichier déclare les formes localement et passe par un
// appel typé minimal compatible avec api.ts.
// ============================================================================

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { t } from "./i18n";

export interface LotPoint {
  lat: number;
  lng: number;
}

export interface CadastralLookup {
  found: boolean;
  address: string;
  lat: number | null;
  lng: number | null;
  displayName: string | null;
  jurisdiction: string | null;
  lotNumber: string | null;
  lotPolygon: LotPoint[];
  lotAreaM2: number | null;
  lotAreaPi2: number | null;
  neighborLots: { lotNumber: string; areaM2: number }[];
  sourceName: string | null;
  sourceUrl: string | null;
  officialUrl: string | null;
  note: string;
  fallback: {
    reason: string;
    officialLinks: { label: string; url: string }[];
    manualFields: string[];
  } | null;
}

// L'objet api typé ne connaît les nouvelles actions qu'après le port
// dans server/src/actions.ts ; cet accès étroit évite de casser la
// compilation de l'artefact en attendant.
const cartoApi = api as unknown as {
  lookupCadastralLot: (args: {
    address: string;
  }) => Promise<CadastralLookup>;
  saveTerrainRegistryData: (args: {
    terrainId: number;
    lotNumber: string;
    lotPolygon: string;
    lotAreaPi2: number | null;
    lotDimensions: string;
    lotSource: string;
    zoning: string;
  }) => Promise<{ ok: boolean }>;
};

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelCls = "block text-sm font-medium text-[var(--dim)] mb-1";
const btnPrimary =
  "rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-text)] active:opacity-80 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)] active:opacity-70 disabled:opacity-50";

export function CartographieTerrain({
  terrainId,
  address,
  onLotPolygon,
}: {
  terrainId: number;
  address: string;
  // Le polygone du lot remonte à TerrainMeasure, qui le dessine dans
  // son calque SVG (même projection que le polygone de travail).
  onLotPolygon: (points: LotPoint[]) => void;
}) {
  const qc = useQueryClient();
  const [result, setResult] = useState<CadastralLookup | null>(null);
  const [error, setError] = useState("");
  // Saisie manuelle (repli ou correction).
  const [lotNumber, setLotNumber] = useState("");
  const [lotArea, setLotArea] = useState("");
  const [lotDimensions, setLotDimensions] = useState("");
  const [zoning, setZoning] = useState("");

  const lookup = useMutation({
    mutationFn: () => cartoApi.lookupCadastralLot({ address }),
    onSuccess: (res) => {
      setResult(res);
      setError("");
      if (res.found) {
        setLotNumber(res.lotNumber ?? "");
        setLotArea(res.lotAreaPi2 != null ? String(res.lotAreaPi2) : "");
        onLotPolygon(res.lotPolygon);
      } else {
        onLotPolygon([]);
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const save = useMutation({
    mutationFn: () =>
      cartoApi.saveTerrainRegistryData({
        terrainId,
        lotNumber: lotNumber.trim(),
        lotPolygon:
          result?.found && result.lotPolygon.length >= 3
            ? JSON.stringify(result.lotPolygon)
            : "",
        lotAreaPi2: lotArea ? Number(lotArea) : null,
        lotDimensions: lotDimensions.trim(),
        lotSource: result?.found
          ? (result.sourceName ?? "cadastre")
          : "saisie manuelle (registre officiel)",
        zoning: zoning.trim(),
      }),
    onSuccess: () => void qc.invalidateQueries(),
  });

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {t("Cartographie et registres — le vrai lot")}
        </p>
        <button
          type="button"
          className={btnPrimary}
          disabled={lookup.isPending}
          onClick={() => lookup.mutate()}
        >
          {lookup.isPending
            ? t("Recherche au cadastre…")
            : t("Chercher le lot au cadastre")}
        </button>
      </div>
      <p className="text-sm text-[var(--dim)]">
        {t(
          "LandCrew interroge le cadastre officiel de l'adresse : numéro de lot, contour du lot et superficie. La surface de travail (gazon seulement) se délimite ensuite sur la vue du dessus, à l'intérieur du lot — c'est elle, et elle seule, qui sert au prix.",
        )}
      </p>

      {error && (
        <p className="text-sm text-red-600">
          {t("La recherche a échoué :")} {error}
        </p>
      )}

      {result?.found && (
        <div className="space-y-1 text-sm">
          <p>
            <strong>{t("Lot")} :</strong> {result.lotNumber} —{" "}
            {result.lotAreaM2 != null
              ? `${result.lotAreaM2.toLocaleString("fr-CA")} m² (${Math.round(result.lotAreaPi2 ?? 0).toLocaleString("fr-CA")} pi²)`
              : ""}
          </p>
          <p className="text-[var(--dim)]">
            {t("Source :")} {result.sourceName}. {result.note}
          </p>
          {result.neighborLots.length > 0 && (
            <p className="text-[var(--dim)]">
              {t(
                "Lots voisins dans l'emprise du site (si le terrain du client couvre un autre lot, vérifiez sur Infolot) :",
              )}{" "}
              {result.neighborLots
                .map((l) => `${l.lotNumber} (${Math.round(l.areaM2).toLocaleString("fr-CA")} m²)`)
                .join(", ")}
            </p>
          )}
          {result.officialUrl && (
            <p>
              <a
                className="underline"
                href={result.officialUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("Vérifier sur Infolot (source officielle)")}
              </a>
            </p>
          )}
        </div>
      )}

      {result && !result.found && (
        <div className="space-y-2 text-sm">
          <p>{result.note}</p>
          {result.fallback && result.fallback.officialLinks.length > 0 && (
            <ul className="list-disc pl-5">
              {result.fallback.officialLinks.map((l) => (
                <li key={l.url}>
                  <a
                    className="underline"
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[var(--dim)]">
            {t(
              "Saisissez ci-dessous le nº de lot et la superficie officielle relevés au registre, puis enregistrez.",
            )}
          </p>
        </div>
      )}

      {(result || lotNumber) && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>{t("Numéro de lot")}</label>
            <input
              className={inputCls}
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>
              {t("Superficie officielle du lot (pi²)")}
            </label>
            <input
              className={inputCls}
              inputMode="decimal"
              value={lotArea}
              onChange={(e) => setLotArea(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>{t("Dimensions du lot")}</label>
            <input
              className={inputCls}
              value={lotDimensions}
              onChange={(e) => setLotDimensions(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>{t("Zonage")}</label>
            <input
              className={inputCls}
              value={zoning}
              onChange={(e) => setZoning(e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <button
              type="button"
              className={btnGhost}
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("Enregistrement…")
                : t("Enregistrer les données du lot")}
            </button>
            {save.isSuccess && (
              <span className="ml-2 text-sm text-green-700">
                {t("Données du lot enregistrées.")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
