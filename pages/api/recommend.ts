/**
 * /api/recommend — Handler formulaire web
 *
 * POST { montant: number, duree: number, secteur: string }
 * → { ok: true, banks: BankResult[], warning?: string }
 * → { ok: false, error: string }
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { recommend } from "@/lib/recommend";
import { loadBanks } from "@/lib/kv";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { montant, duree, secteur } = req.body ?? {};

  if (
    typeof montant !== "number" ||
    typeof duree !== "number" ||
    typeof secteur !== "string"
  ) {
    return res.status(400).json({
      ok: false,
      error: "Paramètres manquants : montant (number), duree (number), secteur (string).",
    });
  }

  if (montant <= 0 || duree <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Le montant et la durée doivent être positifs.",
    });
  }

  const result = await recommend({ montant, duree, secteur }, loadBanks);
  return res.status(result.ok ? 200 : 503).json(result);
}
