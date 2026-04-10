/**
 * lib/whatsapp.ts — Client Meta Cloud API
 *
 * Envoie des messages texte et des messages avec boutons (réponse rapide).
 * Utilisé uniquement par /api/whatsapp.
 */

const WA_API_VERSION = "v19.0";

function apiUrl(phoneNumberId: string, endpoint: string): string {
  return `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/${endpoint}`;
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` };
}

// ─── Envoi texte simple ──────────────────────────────────────────────────────

export async function sendText(to: string, body: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  await fetch(apiUrl(phoneNumberId, "messages"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
}

// ─── Envoi avec boutons de réponse rapide ────────────────────────────────────
// Utilisé pour Q3 (secteur d'activité) — enum fixé, pas de free-text.

export type QuickReplyButton = { id: string; title: string };

export async function sendWithButtons(
  to: string,
  bodyText: string,
  buttons: QuickReplyButton[]
): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  await fetch(apiUrl(phoneNumberId, "messages"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    }),
  });
}

// ─── Questions prédéfinies ───────────────────────────────────────────────────

export const SECTEUR_BUTTONS: QuickReplyButton[] = [
  { id: "Commerce", title: "🛒 Commerce" },
  { id: "BTP", title: "🏗️ BTP" },
  { id: "Agriculture", title: "🌾 Agriculture" },
  { id: "Transport", title: "🚛 Transport" },
  { id: "Autre", title: "⚙️ Autre" },
];

export const Q1_TEXT =
  "Bonjour ! Je suis votre assistant de crédit bancaire 🏦\n\n*Quel montant souhaitez-vous emprunter ?*\n_(ex: 5 millions, 20 millions FCFA)_";

export const Q2_TEXT =
  "✅ Montant noté.\n\n*Sur quelle durée souhaitez-vous rembourser ?*\n_(ex: 12 mois, 24 mois, 3 ans)_";

export const Q3_TEXT =
  "✅ Durée notée.\n\n*Quel est votre secteur d'activité ?*\nChoisissez une option :";

export const FALLBACK_TEXT =
  "Je n'ai pas compris votre réponse. Essayez notre outil web : https://comparer.cm\nOu tapez *restart* pour recommencer.";

export const RESTART_CONFIRM =
  "🔄 Conversation réinitialisée. " + Q1_TEXT;

// ─── Formater la recommandation finale ──────────────────────────────────────

import type { BankResult } from "./recommend";

export function formatRecommendation(
  banks: BankResult[],
  montantLabel: string,
  dureeLabel: string,
  warning?: string
): string {
  if (banks.length === 0) {
    return (
      "⚠️ Aucune banque ne correspond exactement à votre profil.\n\n" +
      "Contactez l'APECCAM pour une orientation :\n📞 +237 222 23 30 43"
    );
  }

  const lines: string[] = [
    `✅ *Top ${banks.length} pour ${montantLabel} sur ${dureeLabel} :*\n`,
  ];

  banks.forEach((b, i) => {
    lines.push(
      `*${i + 1}. ${b.nom}*\n` +
        `   TEG ${b.teg} — dossier en ${b.delai}\n` +
        `   📄 ${b.documents}\n` +
        `   📞 ${b.telephone}\n`
    );
  });

  if (warning) lines.push(`ℹ️ ${warning}\n`);

  lines.push(
    `📌 Apportez votre RCCM à jour dans tous les cas.`,
    `⚠️ _Données vérifiées le ${banks[0].dateVerification}. Confirmez les conditions auprès de la banque._`
  );

  return lines.join("\n");
}
