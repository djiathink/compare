/**
 * lib/kv.ts — Cache Vercel KV + état de conversation WhatsApp
 *
 * DOUBLE USAGE :
 *   1. Cache données bancaires (TTL 15 min, key: "banks:data")
 *   2. État de conversation WhatsApp (TTL 30 min, key: "conv:{phone}")
 *
 * ARCHITECTURE :
 *   WhatsApp msg ──► /api/whatsapp ──► kv.getConvState(phone)
 *                                   └──► kv.getBanks() ──► Google Sheets (miss)
 *   Web form    ──► /api/recommend ──► kv.getBanks()
 */

import { kv } from "@vercel/kv";
import { BankRow, BankRowSchema } from "./recommend";

// ─── Clés KV ────────────────────────────────────────────────────────────────

const BANKS_CACHE_KEY = "banks:data";
const BANKS_TTL_SECONDS = 15 * 60; // 15 minutes

const convKey = (phone: string) => `conv:${phone}`;
const CONV_TTL_SECONDS = 30 * 60; // 30 minutes

// ─── État de conversation ────────────────────────────────────────────────────

export type ConvState = {
  step: 0 | 1 | 2 | 3; // 0=initial, 1=montant reçu, 2=duree reçue, 3=complet
  montant?: number;
  duree?: number;
  attempts: number; // nb de tentatives de parsing sur la question en cours
};

export async function getConvState(phone: string): Promise<ConvState | null> {
  return kv.get<ConvState>(convKey(phone));
}

export async function setConvState(
  phone: string,
  state: ConvState
): Promise<void> {
  await kv.set(convKey(phone), state, { ex: CONV_TTL_SECONDS });
}

export async function deleteConvState(phone: string): Promise<void> {
  await kv.del(convKey(phone));
}

// ─── Cache données bancaires ─────────────────────────────────────────────────

export async function getCachedBanks(): Promise<BankRow[] | null> {
  return kv.get<BankRow[]>(BANKS_CACHE_KEY);
}

export async function setCachedBanks(banks: BankRow[]): Promise<void> {
  await kv.set(BANKS_CACHE_KEY, banks, { ex: BANKS_TTL_SECONDS });
}

// ─── Chargement depuis Google Sheets ────────────────────────────────────────
// Utilise la Google Sheets API v4 avec Service Account.
// Les données sont validées via Zod avant mise en cache.

export async function fetchBanksFromSheet(): Promise<BankRow[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!sheetId || !serviceEmail || !privateKey) {
    throw new Error("Variables d'environnement Google Sheets manquantes.");
  }

  // Obtenir un token d'accès via JWT (Service Account)
  const token = await getGoogleAccessToken(serviceEmail, privateKey);

  const range = "Banques!A2:K100"; // header en ligne 1, données à partir de 2
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Google Sheets API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const rows: string[][] = data.values ?? [];

  const headers = [
    "nom_banque",
    "teg_min",
    "teg_max",
    "delai_traitement_jours",
    "montant_min_fcfa",
    "montant_max_fcfa",
    "nb_documents",
    "documents_requis",
    "contact_telephone",
    "secteurs_exclus",
    "date_verification",
  ];

  const parsed: BankRow[] = [];
  for (const row of rows) {
    if (!row[0]) continue; // ligne vide
    const obj = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]));
    const result = BankRowSchema.safeParse(obj);
    if (!result.success) {
      console.error(
        `[kv] Ligne invalide (${obj.nom_banque}):`,
        result.error.flatten()
      );
      continue; // ignorer la ligne invalide, pas crash
    }
    parsed.push(result.data);
  }

  if (parsed.length === 0) {
    throw new Error("Aucune donnée bancaire valide dans le Sheet.");
  }

  return parsed;
}

// ─── Loader combiné (cache → Sheet) ─────────────────────────────────────────

export async function loadBanks(): Promise<BankRow[]> {
  const cached = await getCachedBanks();
  if (cached) return cached;

  const fresh = await fetchBanksFromSheet();
  await setCachedBanks(fresh);
  return fresh;
}

// ─── JWT pour Google Service Account ────────────────────────────────────────
// Implémentation minimale sans dépendance externe (google-auth-library est 2MB).

async function getGoogleAccessToken(
  email: string,
  privateKey: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const header = { alg: "RS256", typ: "JWT" };
  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const unsigned = `${encode(header)}.${encode(payload)}`;

  // Signer avec PKCS#8 (format Service Account Google)
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${Buffer.from(signature)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const json = await res.json();
  if (!json.access_token) throw new Error("Échec auth Google: " + JSON.stringify(json));
  return json.access_token;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = Buffer.from(b64, "base64");
  return binary.buffer.slice(
    binary.byteOffset,
    binary.byteOffset + binary.byteLength
  );
}
