/**
 * /api/debug — Endpoint temporaire pour diagnostiquer les connexions
 * À supprimer après debug.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { loadBanks } from "@/lib/kv";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const checks: Record<string, unknown> = {
    env: {
      UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
      COMPARE_KV_REST_API_URL: !!process.env.COMPARE_KV_REST_API_URL,
      UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      COMPARE_KV_REST_API_TOKEN: !!process.env.COMPARE_KV_REST_API_TOKEN,
      GOOGLE_SHEET_ID: !!process.env.GOOGLE_SHEET_ID,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
    },
  };

  try {
    const banks = await loadBanks();
    checks.banks = { ok: true, count: banks.length, first: banks[0]?.nom_banque ?? null };
  } catch (err: unknown) {
    checks.banks = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return res.status(200).json(checks);
}
