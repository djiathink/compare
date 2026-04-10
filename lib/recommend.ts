/**
 * lib/recommend.ts — Moteur de recommandation bancaire
 *
 * Partagé entre /api/recommend (web) et /api/whatsapp (bot).
 * Charge les données depuis Vercel KV (cache) ou Google Sheets (source).
 *
 * DATA FLOW:
 *   request(montant, duree, secteur)
 *       │
 *       ├── loadBanks() ──► KV cache hit ──► return cached
 *       │                └► KV miss ──► fetchFromSheets() ──► store KV ──► return
 *       │
 *       ├── filterBanks(montant, secteur)
 *       │       ├── exclude secteurs_exclus (hard exclusion)
 *       │       └── exclude hors montant_min/montant_max
 *       │
 *       └── scoreBanks(filtered)
 *               ├── normalize each dimension [0,1] (min-max)
 *               │   └── guard: if max === min → score = 0.5 (avoid div/0)
 *               └── composite = TEG*0.5 + delai*0.3 + docs*0.2 (higher = better)
 */

import { z } from "zod";

// ─── Schema Zod (validation du Google Sheet) ───────────────────────────────

const BankRowSchema = z.object({
  nom_banque: z.string().min(1),
  teg_min: z.preprocess(
    (v) => parseFloat(String(v).replace(",", ".")),
    z.number().min(1).max(100)
  ),
  teg_max: z.preprocess(
    (v) => parseFloat(String(v).replace(",", ".")),
    z.number().min(1).max(100)
  ),
  delai_traitement_jours: z.preprocess(
    (v) => parseInt(String(v), 10),
    z.number().int().min(1).max(365)
  ),
  montant_min_fcfa: z.preprocess(
    (v) => parseInt(String(v).replace(/\s/g, ""), 10),
    z.number().int().min(0)
  ),
  montant_max_fcfa: z.preprocess(
    (v) => parseInt(String(v).replace(/\s/g, ""), 10),
    z.number().int().min(0)
  ),
  nb_documents: z.preprocess(
    (v) => parseInt(String(v), 10),
    z.number().int().min(0).max(20)
  ),
  documents_requis: z.string(),
  contact_telephone: z.string(),
  secteurs_exclus: z.string().default(""),
  date_verification: z.string(),
});

export type BankRow = z.infer<typeof BankRowSchema>;

// ─── Types publics ──────────────────────────────────────────────────────────

export type RecommendInput = {
  montant: number;    // FCFA
  duree: number;      // mois
  secteur: string;    // "Commerce" | "BTP" | "Agriculture" | "Transport" | "Autre"
};

export type BankResult = {
  nom: string;
  teg: string;           // ex: "~12.5%"
  delai: string;         // ex: "5 jours"
  documents: string;
  telephone: string;
  dateVerification: string;
  score: number;
};

export type RecommendResult =
  | { ok: true; banks: BankResult[]; warning?: string }
  | { ok: false; error: string };

// ─── Normalisation min-max ──────────────────────────────────────────────────
// Retourne un score 0-1 où PLUS BAS = MIEUX, donc on inverse.
// Guard division par zéro : si max === min → 0.5 pour tous.

function normalizeInverted(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => 1 - (v - min) / (max - min));
}

// ─── Scoring composite ─────────────────────────────────────────────────────
// Poids : TEG 50% + délai 30% + nb_documents 20%
// Pondérations modifiables via l'onglet "config" du Sheet (voir kv.ts).

const DEFAULT_WEIGHTS = { teg: 0.5, delai: 0.3, docs: 0.2 };

export function scoreBanks(
  banks: BankRow[],
  weights = DEFAULT_WEIGHTS
): (BankRow & { score: number })[] {
  if (banks.length === 0) return [];

  const tegScores = normalizeInverted(banks.map((b) => b.teg_min));
  const delaiScores = normalizeInverted(
    banks.map((b) => b.delai_traitement_jours)
  );
  const docsScores = normalizeInverted(banks.map((b) => b.nb_documents));

  return banks
    .map((bank, i) => ({
      ...bank,
      score:
        tegScores[i] * weights.teg +
        delaiScores[i] * weights.delai +
        docsScores[i] * weights.docs,
    }))
    .sort((a, b) => b.score - a.score);
}

// ─── Filtrage ───────────────────────────────────────────────────────────────

export function filterBanks(
  banks: BankRow[],
  montant: number,
  secteur: string
): BankRow[] {
  const secteurNorm = secteur.trim().toLowerCase();
  return banks.filter((bank) => {
    // Exclusion par secteur (hard exclusion, virgule-séparée)
    const excluded = bank.secteurs_exclus
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (excluded.includes(secteurNorm)) return false;

    // Exclusion par montant hors plage
    if (montant < bank.montant_min_fcfa || montant > bank.montant_max_fcfa)
      return false;

    return true;
  });
}

// ─── Chargement des données (interface — implémentée dans kv.ts) ────────────

export type BankDataLoader = () => Promise<BankRow[]>;

// ─── Fonction principale ────────────────────────────────────────────────────

export async function recommend(
  input: RecommendInput,
  loadBanks: BankDataLoader
): Promise<RecommendResult> {
  let allBanks: BankRow[];

  try {
    allBanks = await loadBanks();
  } catch (err) {
    return {
      ok: false,
      error:
        "Données bancaires temporairement indisponibles. Réessayez dans quelques minutes.",
    };
  }

  const filtered = filterBanks(allBanks, input.montant, input.secteur);

  if (filtered.length === 0) {
    return {
      ok: true,
      banks: [],
      warning:
        "Peu de banques financent ce profil. Contactez l'APECCAM : +237 222 23 30 43",
    };
  }

  const scored = scoreBanks(filtered);
  const top3 = scored.slice(0, 3);

  const banks: BankResult[] = top3.map((b) => ({
    nom: b.nom_banque,
    teg: `~${b.teg_min}%`,
    delai: `${b.delai_traitement_jours} jours`,
    documents: b.documents_requis,
    telephone: b.contact_telephone,
    dateVerification: b.date_verification,
    score: b.score,
  }));

  const warning =
    filtered.length < 3
      ? `Seule${filtered.length === 1 ? "" : "s"} ${filtered.length} banque${
          filtered.length === 1 ? "" : "s"
        } correspond${
          filtered.length === 1 ? "" : "ent"
        } à votre profil.`
      : undefined;

  return { ok: true, banks, warning };
}

// ─── Parsing des inputs WhatsApp (free-text) ────────────────────────────────

/** Convertit "15 millions", "15M", "15000000" → number en FCFA. Retourne null si non reconnu. */
export function parseMontant(input: string): number | null {
  const clean = input.trim().toLowerCase().replace(/\s/g, "");
  // Millions explicites : "15millions", "15m", "15 millions"
  const millionsMatch = clean.match(/^(\d+(?:[.,]\d+)?)\s*m(?:illions?)?$/);
  if (millionsMatch) {
    const val = parseFloat(millionsMatch[1].replace(",", ".")) * 1_000_000;
    return isFinite(val) ? Math.round(val) : null;
  }
  // Nombre brut : "15000000"
  const rawMatch = clean.match(/^(\d+(?:[.,]\d+)?)$/);
  if (rawMatch) {
    const val = parseFloat(rawMatch[1].replace(",", "."));
    return isFinite(val) && val > 0 ? Math.round(val) : null;
  }
  return null;
}

/** Convertit "24 mois", "24", "2 ans" → nombre de mois. Retourne null si non reconnu. */
export function parseDuree(input: string): number | null {
  const clean = input.trim().toLowerCase().replace(/\s/g, "");
  const ansMatch = clean.match(/^(\d+)\s*ans?$/);
  if (ansMatch) return parseInt(ansMatch[1], 10) * 12;
  const moisMatch = clean.match(/^(\d+)\s*(?:mois)?$/);
  if (moisMatch) {
    const val = parseInt(moisMatch[1], 10);
    return val > 0 && val <= 360 ? val : null;
  }
  return null;
}

export { BankRowSchema };
