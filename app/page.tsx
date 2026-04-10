"use client";

/**
 * Page principale — Formulaire de comparaison de crédit PME
 *
 * Mobile-first. Trois champs (montant, durée, secteur) → appel /api/recommend → résultats.
 */

import { useState } from "react";
import type { BankResult } from "@/lib/recommend";

const SECTEURS = ["Commerce", "BTP", "Agriculture", "Transport", "Autre"];

type FormState = {
  montantStr: string;
  dureeStr: string;
  secteur: string;
};

type Result =
  | { ok: true; banks: BankResult[]; warning?: string }
  | { ok: false; error: string }
  | null;

// ─── Parsing côté client (identique au bot) ──────────────────────────────────

function parseMontantClient(str: string): number | null {
  const clean = str.trim().toLowerCase().replace(/\s/g, "");
  const m = clean.match(/^(\d+(?:[.,]\d+)?)\s*m(?:illions?)?$/);
  if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 1_000_000);
  const r = clean.match(/^(\d+(?:[.,]\d+)?)$/);
  if (r) {
    const v = parseFloat(r[1].replace(",", "."));
    return isFinite(v) && v > 0 ? Math.round(v) : null;
  }
  return null;
}

function parseDureeClient(str: string): number | null {
  const clean = str.trim().toLowerCase().replace(/\s/g, "");
  const a = clean.match(/^(\d+)\s*ans?$/);
  if (a) return parseInt(a[1], 10) * 12;
  const mo = clean.match(/^(\d+)\s*(?:mois)?$/);
  if (mo) {
    const v = parseInt(mo[1], 10);
    return v > 0 && v <= 360 ? v : null;
  }
  return null;
}

// ─── Composant formulaire ────────────────────────────────────────────────────

export default function Home() {
  const [form, setForm] = useState<FormState>({
    montantStr: "",
    dureeStr: "",
    secteur: "",
  });
  const [errors, setErrors] = useState<Partial<FormState>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result>(null);

  function validate(): boolean {
    const errs: Partial<FormState> = {};
    if (!parseMontantClient(form.montantStr))
      errs.montantStr = "Format invalide. Ex : 15 millions ou 15000000";
    if (!parseDureeClient(form.dureeStr))
      errs.dureeStr = "Format invalide. Ex : 24 mois ou 2 ans";
    if (!form.secteur) errs.secteur = "Sélectionnez un secteur";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setResult(null);

    try {
      const montant = parseMontantClient(form.montantStr)!;
      const duree = parseDureeClient(form.dureeStr)!;
      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ montant, duree, secteur: form.secteur }),
      });
      setResult(await res.json());
    } catch {
      setResult({ ok: false, error: "Erreur réseau. Vérifiez votre connexion." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="max-w-lg mx-auto px-4 py-8">
      {/* En-tête */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          Trouvez votre banque PME
        </h1>
        <p className="text-gray-500 text-sm">
          Comparaison de crédit professionnel au Cameroun — résultat en 30 secondes
        </p>
      </div>

      {/* Formulaire */}
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
        {/* Montant */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Montant souhaité
          </label>
          <input
            type="text"
            inputMode="numeric"
            placeholder="ex : 15 millions ou 15 000 000"
            value={form.montantStr}
            onChange={(e) => setForm({ ...form, montantStr: e.target.value })}
            className={`w-full rounded-lg border px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${
              errors.montantStr ? "border-red-400" : "border-gray-200"
            }`}
          />
          {errors.montantStr && (
            <p className="text-red-500 text-xs mt-1">{errors.montantStr}</p>
          )}
        </div>

        {/* Durée */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Durée de remboursement
          </label>
          <input
            type="text"
            inputMode="numeric"
            placeholder="ex : 24 mois ou 2 ans"
            value={form.dureeStr}
            onChange={(e) => setForm({ ...form, dureeStr: e.target.value })}
            className={`w-full rounded-lg border px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${
              errors.dureeStr ? "border-red-400" : "border-gray-200"
            }`}
          />
          {errors.dureeStr && (
            <p className="text-red-500 text-xs mt-1">{errors.dureeStr}</p>
          )}
        </div>

        {/* Secteur */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Secteur d&apos;activité
          </label>
          <div className="grid grid-cols-3 gap-2">
            {SECTEURS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setForm({ ...form, secteur: s })}
                className={`rounded-lg border py-2 px-3 text-sm font-medium transition-colors ${
                  form.secteur === s
                    ? "bg-green-600 text-white border-green-600"
                    : "bg-white text-gray-700 border-gray-200 hover:border-green-400"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          {errors.secteur && (
            <p className="text-red-500 text-xs mt-1">{errors.secteur}</p>
          )}
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white font-semibold py-3 rounded-lg transition-colors"
        >
          {loading ? "Recherche en cours…" : "Comparer les banques →"}
        </button>
      </form>

      {/* Résultats */}
      {result && (
        <div className="mt-6 space-y-4">
          {!result.ok ? (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-red-700 text-sm">
              {result.error}
            </div>
          ) : result.banks.length === 0 ? (
            <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4 text-yellow-800 text-sm">
              {result.warning ?? "Aucune banque ne correspond à ce profil."}
              <p className="mt-2 font-medium">APECCAM : +237 222 23 30 43</p>
            </div>
          ) : (
            <>
              {result.warning && (
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-blue-700 text-sm">
                  ℹ️ {result.warning}
                </div>
              )}
              {result.banks.map((bank, i) => (
                <BankCard key={bank.nom} rank={i + 1} bank={bank} />
              ))}
              <p className="text-xs text-gray-400 text-center mt-4">
                Données vérifiées le {result.banks[0].dateVerification}. Confirmez les conditions auprès de la banque.
              </p>
            </>
          )}
        </div>
      )}

      {/* WhatsApp CTA */}
      <div className="mt-8 text-center">
        <p className="text-sm text-gray-500 mb-2">Préférez WhatsApp ?</p>
        <a
          href="https://wa.me/+237XXXXXXXXX"
          className="inline-flex items-center gap-2 bg-[#25D366] text-white text-sm font-semibold px-5 py-2.5 rounded-full hover:bg-[#20b958] transition-colors"
        >
          <span>🟢</span> Comparer via WhatsApp
        </a>
      </div>
    </main>
  );
}

// ─── Carte banque ────────────────────────────────────────────────────────────

function BankCard({ rank, bank }: { rank: number; bank: BankResult }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
            #{rank}
          </span>
          <h2 className="font-semibold text-gray-900 mt-1">{bank.nom}</h2>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-green-700">{bank.teg}</p>
          <p className="text-xs text-gray-400">TEG estimé</p>
        </div>
      </div>

      <div className="text-sm text-gray-600 space-y-1">
        <p>⏱️ Dossier traité en {bank.delai}</p>
        <p>📄 {bank.documents}</p>
      </div>

      <a
        href={`tel:${bank.telephone}`}
        className="mt-4 flex items-center gap-2 text-sm font-medium text-green-700 hover:text-green-800"
      >
        📞 {bank.telephone}
      </a>
    </div>
  );
}
