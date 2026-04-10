/**
 * /api/whatsapp — Webhook Meta Cloud API
 *
 * GET  : vérification du webhook (challenge Meta)
 * POST : traitement des messages entrants
 *
 * FLOW DE CONVERSATION :
 *   step 0 → envoyer Q1 (montant)
 *   step 1 → parser montant → envoyer Q2 (durée)
 *   step 2 → parser durée  → envoyer Q3 avec boutons (secteur)
 *   step 3 → secteur via bouton → recommandation finale
 *
 * ÉTAT stocké dans Vercel KV (conv:{phone}, TTL 30 min)
 * SÉCURITÉ : signature HMAC X-Hub-Signature-256 vérifiée avant tout traitement
 */

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import {
  getConvState,
  setConvState,
  deleteConvState,
  loadBanks,
} from "@/lib/kv";
import { recommend, parseMontant, parseDuree } from "@/lib/recommend";
import {
  sendText,
  sendWithButtons,
  formatRecommendation,
  Q1_TEXT,
  Q2_TEXT,
  Q3_TEXT,
  FALLBACK_TEXT,
  RESTART_CONFIRM,
  SECTEUR_BUTTONS,
} from "@/lib/whatsapp";

// Désactiver le body parser Next.js pour pouvoir lire le raw body (nécessaire pour HMAC)
export const config = { api: { bodyParser: false } };

async function getRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Vérification signature HMAC ────────────────────────────────────────────

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !process.env.WHATSAPP_WEBHOOK_SECRET) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.WHATSAPP_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Handler principal ───────────────────────────────────────────────────────

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // GET : vérification webhook Meta
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== "POST") {
    return res.status(405).end();
  }

  // Lire le raw body pour HMAC
  const rawBody = await getRawBody(req);
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Répondre 200 immédiatement (Meta exige < 20s, le traitement peut être long)
  res.status(200).json({ status: "ok" });

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return; // body invalide, déjà répondu 200
  }

  const entry = payload?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const message = value?.messages?.[0];

  if (!message) return;

  const from: string = message.from;

  // Restart explicite
  if (message.type === "text") {
    const text: string = message.text?.body ?? "";
    if (text.trim().toLowerCase() === "restart") {
      await deleteConvState(from);
      await sendText(from, RESTART_CONFIRM);
      return;
    }
  }

  await processMessage(from, message);
}

// ─── Machine d'état de conversation ─────────────────────────────────────────

async function processMessage(phone: string, message: any): Promise<void> {
  const state = (await getConvState(phone)) ?? { step: 0, attempts: 0 };

  // step 0 : nouvelle conversation ou TTL expiré → Q1
  if (state.step === 0) {
    await setConvState(phone, { step: 1, attempts: 0 });
    await sendText(phone, Q1_TEXT);
    return;
  }

  // step 1 : attente montant
  if (state.step === 1) {
    const text = message.text?.body ?? "";
    const montant = parseMontant(text);
    if (montant === null) {
      return handleParseFailure(phone, state, 1, Q1_TEXT);
    }
    await setConvState(phone, { step: 2, montant, attempts: 0 });
    await sendText(phone, Q2_TEXT);
    return;
  }

  // step 2 : attente durée
  if (state.step === 2) {
    const text = message.text?.body ?? "";
    const duree = parseDuree(text);
    if (duree === null) {
      return handleParseFailure(phone, state, 2, Q2_TEXT);
    }
    await setConvState(phone, {
      step: 3,
      montant: state.montant,
      duree,
      attempts: 0,
    });
    await sendWithButtons(phone, Q3_TEXT, SECTEUR_BUTTONS);
    return;
  }

  // step 3 : attente secteur (bouton de réponse rapide)
  if (state.step === 3) {
    const buttonId: string | undefined =
      message.interactive?.button_reply?.id;
    if (!buttonId) {
      // L'utilisateur a tapé du texte alors qu'un bouton était attendu
      await sendWithButtons(phone, Q3_TEXT, SECTEUR_BUTTONS);
      return;
    }

    const montant = state.montant!;
    const duree = state.duree!;
    const secteur = buttonId;

    await deleteConvState(phone);

    const result = await recommend({ montant, duree, secteur }, loadBanks);

    const montantLabel = `${(montant / 1_000_000).toLocaleString("fr-FR")} millions FCFA`;
    const dureeLabel = `${duree} mois`;

    if (!result.ok) {
      await sendText(phone, `⚠️ ${result.error}`);
      return;
    }

    const msg = formatRecommendation(
      result.banks,
      montantLabel,
      dureeLabel,
      result.warning
    );
    await sendText(phone, msg);
    return;
  }
}

// ─── Gestion des échecs de parsing ──────────────────────────────────────────

async function handleParseFailure(
  phone: string,
  state: NonNullable<Awaited<ReturnType<typeof getConvState>>>,
  step: 1 | 2,
  questionText: string
): Promise<void> {
  const attempts = (state.attempts ?? 0) + 1;
  if (attempts >= 2) {
    // 2ème échec → renvoyer vers le web
    await deleteConvState(phone);
    await sendText(phone, FALLBACK_TEXT);
    return;
  }
  await setConvState(phone, { ...state, step, attempts });
  await sendText(
    phone,
    `Je n'ai pas compris. ${step === 1 ? "Quel montant souhaitez-vous emprunter ?" : "Sur quelle durée ?"}\n_(ex: ${step === 1 ? "15 millions" : "24 mois"})_`
  );
}
