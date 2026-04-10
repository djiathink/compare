/**
 * Tests du moteur de recommandation (lib/recommend.ts)
 * Couvre : scoring, filtrage, normalisation, parsing, edge cases
 */

import { describe, it, expect } from "vitest";
import {
  scoreBanks,
  filterBanks,
  recommend,
  parseMontant,
  parseDuree,
  BankRowSchema,
  BankRow,
} from "@/lib/recommend";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeBankRow = (overrides: Partial<BankRow> = {}): BankRow => ({
  nom_banque: "Test Bank",
  teg_min: 12.0,
  teg_max: 15.0,
  delai_traitement_jours: 5,
  montant_min_fcfa: 1_000_000,
  montant_max_fcfa: 100_000_000,
  nb_documents: 3,
  documents_requis: "RCCM, Bilan N-1",
  contact_telephone: "+237 000 00 00 00",
  secteurs_exclus: "",
  date_verification: "2026-04-10",
  ...overrides,
});

const BANKS: BankRow[] = [
  makeBankRow({ nom_banque: "Afriland", teg_min: 12.0, delai_traitement_jours: 5, nb_documents: 3 }),
  makeBankRow({ nom_banque: "Ecobank", teg_min: 14.5, delai_traitement_jours: 7, nb_documents: 4 }),
  makeBankRow({ nom_banque: "UBA", teg_min: 15.0, delai_traitement_jours: 10, nb_documents: 5 }),
];

// ─── scoreBanks ──────────────────────────────────────────────────────────────

describe("scoreBanks", () => {
  it("classe la banque avec le TEG le plus bas en premier", () => {
    const scored = scoreBanks(BANKS);
    expect(scored[0].nom_banque).toBe("Afriland");
    expect(scored[1].nom_banque).toBe("Ecobank");
    expect(scored[2].nom_banque).toBe("UBA");
  });

  it("retourne un tableau vide si input vide", () => {
    expect(scoreBanks([])).toEqual([]);
  });

  it("scores sont entre 0 et 1", () => {
    const scored = scoreBanks(BANKS);
    for (const b of scored) {
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(1);
    }
  });

  it("guard division par zéro : toutes les banques ont le même TEG → score = 0.5 sur dimension TEG", () => {
    const sameTeg = [
      makeBankRow({ nom_banque: "A", teg_min: 13.0, delai_traitement_jours: 3, nb_documents: 2 }),
      makeBankRow({ nom_banque: "B", teg_min: 13.0, delai_traitement_jours: 7, nb_documents: 4 }),
    ];
    const scored = scoreBanks(sameTeg);
    // Les deux ont le même TEG → le délai (plus court = A) devrait décider
    expect(scored[0].nom_banque).toBe("A");
    // Pas de NaN
    for (const b of scored) expect(isNaN(b.score)).toBe(false);
  });

  it("une seule banque → score non NaN", () => {
    const scored = scoreBanks([BANKS[0]]);
    expect(scored).toHaveLength(1);
    expect(isNaN(scored[0].score)).toBe(false);
  });
});

// ─── filterBanks ────────────────────────────────────────────────────────────

describe("filterBanks", () => {
  it("exclut une banque par secteur", () => {
    const banks = [
      makeBankRow({ nom_banque: "A", secteurs_exclus: "agriculture" }),
      makeBankRow({ nom_banque: "B", secteurs_exclus: "" }),
    ];
    const filtered = filterBanks(banks, 10_000_000, "Agriculture");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].nom_banque).toBe("B");
  });

  it("exclusion insensible à la casse et aux espaces", () => {
    const banks = [makeBankRow({ secteurs_exclus: " Agriculture , BTP " })];
    expect(filterBanks(banks, 10_000_000, "agriculture")).toHaveLength(0);
    expect(filterBanks(banks, 10_000_000, "BTP")).toHaveLength(0);
    expect(filterBanks(banks, 10_000_000, "Commerce")).toHaveLength(1);
  });

  it("exclut une banque si le montant est hors plage", () => {
    const banks = [
      makeBankRow({ nom_banque: "A", montant_min_fcfa: 5_000_000, montant_max_fcfa: 50_000_000 }),
    ];
    expect(filterBanks(banks, 1_000_000, "Commerce")).toHaveLength(0);   // trop petit
    expect(filterBanks(banks, 100_000_000, "Commerce")).toHaveLength(0); // trop grand
    expect(filterBanks(banks, 10_000_000, "Commerce")).toHaveLength(1);  // dans la plage
  });

  it("retourne 0 banques si aucune ne correspond → pas de crash", () => {
    const banks = [makeBankRow({ secteurs_exclus: "agriculture" })];
    expect(filterBanks(banks, 10_000_000, "Agriculture")).toHaveLength(0);
  });
});

// ─── recommend ──────────────────────────────────────────────────────────────

describe("recommend", () => {
  const loader = async () => BANKS;

  it("retourne ok:true avec top 3 sur happy path", async () => {
    const result = await recommend({ montant: 10_000_000, duree: 24, secteur: "Commerce" }, loader);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.banks.length).toBeGreaterThan(0);
      expect(result.banks[0].nom).toBe("Afriland");
    }
  });

  it("retourne ok:true avec banks:[] et warning si 0 banques correspondent", async () => {
    const noMatchLoader = async () => [
      makeBankRow({ secteurs_exclus: "commerce, btp, agriculture, transport, autre" }),
    ];
    const result = await recommend({ montant: 10_000_000, duree: 24, secteur: "Commerce" }, noMatchLoader);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.banks).toHaveLength(0);
      expect(result.warning).toContain("APECCAM");
    }
  });

  it("retourne ok:false si le loader lance une erreur", async () => {
    const errorLoader = async () => { throw new Error("Sheets down"); };
    const result = await recommend({ montant: 10_000_000, duree: 24, secteur: "Commerce" }, errorLoader);
    expect(result.ok).toBe(false);
  });

  it("retourne au maximum 3 banques même si plus sont disponibles", async () => {
    const manyBanks = Array.from({ length: 6 }, (_, i) =>
      makeBankRow({ nom_banque: `Bank ${i}`, teg_min: 10 + i })
    );
    const result = await recommend(
      { montant: 10_000_000, duree: 24, secteur: "Commerce" },
      async () => manyBanks
    );
    if (result.ok) expect(result.banks.length).toBeLessThanOrEqual(3);
  });

  it("inclut un warning si moins de 3 banques correspondent", async () => {
    const twoLoader = async () => BANKS.slice(0, 2);
    const result = await recommend({ montant: 10_000_000, duree: 24, secteur: "Commerce" }, twoLoader);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toBeDefined();
  });
});

// ─── parseMontant ────────────────────────────────────────────────────────────

describe("parseMontant", () => {
  it.each([
    ["15 millions", 15_000_000],
    ["15millions", 15_000_000],
    ["15M", 15_000_000],
    ["5m", 5_000_000],
    ["1.5 millions", 1_500_000],
    ["15000000", 15_000_000],
    ["500000", 500_000],
  ])('parse "%s" → %d', (input, expected) => {
    expect(parseMontant(input)).toBe(expected);
  });

  it.each([["beaucoup"], ["abc"], [""], ["-5"], ["0"]])(
    'retourne null pour "%s"',
    (input) => {
      expect(parseMontant(input)).toBeNull();
    }
  );
});

// ─── parseDuree ──────────────────────────────────────────────────────────────

describe("parseDuree", () => {
  it.each([
    ["24 mois", 24],
    ["24", 24],
    ["2 ans", 24],
    ["3ans", 36],
    ["12mois", 12],
  ])('parse "%s" → %d mois', (input, expected) => {
    expect(parseDuree(input)).toBe(expected);
  });

  it.each([["longtemps"], [""], ["0"], ["400 mois"]])(
    'retourne null pour "%s"',
    (input) => {
      expect(parseDuree(input)).toBeNull();
    }
  );
});

// ─── BankRowSchema (validation Zod) ─────────────────────────────────────────

describe("BankRowSchema", () => {
  it("parse une ligne valide", () => {
    const row = {
      nom_banque: "Afriland First Bank",
      teg_min: "12.5",
      teg_max: "15.0",
      delai_traitement_jours: "5",
      montant_min_fcfa: "1000000",
      montant_max_fcfa: "100000000",
      nb_documents: "3",
      documents_requis: "RCCM, 3 bilans",
      contact_telephone: "+237 222 22 01 22",
      secteurs_exclus: "",
      date_verification: "2026-04-10",
    };
    expect(BankRowSchema.safeParse(row).success).toBe(true);
  });

  it("convertit une virgule en point pour teg_min", () => {
    const row = {
      nom_banque: "Test",
      teg_min: "12,5",  // virgule française
      teg_max: "15,0",
      delai_traitement_jours: "5",
      montant_min_fcfa: "1000000",
      montant_max_fcfa: "100000000",
      nb_documents: "3",
      documents_requis: "RCCM",
      contact_telephone: "+237",
      secteurs_exclus: "",
      date_verification: "2026-04-10",
    };
    const result = BankRowSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.teg_min).toBe(12.5);
  });

  it("rejette un TEG invalide (texte non parseable)", () => {
    const row = {
      nom_banque: "Test",
      teg_min: "abc",
      teg_max: "15",
      delai_traitement_jours: "5",
      montant_min_fcfa: "1000000",
      montant_max_fcfa: "100000000",
      nb_documents: "3",
      documents_requis: "RCCM",
      contact_telephone: "+237",
      secteurs_exclus: "",
      date_verification: "2026-04-10",
    };
    expect(BankRowSchema.safeParse(row).success).toBe(false);
  });
});
