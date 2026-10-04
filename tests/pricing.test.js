import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateLinePricing, calculateLineTotals } from "../src/domain/pricing.js";
import { calculateProjectTotals } from "../src/domain/totals.js";
import { assertTransitionProject, PROJECT_STATUS } from "../src/domain/constants.js";
import { roundMoney } from "../src/domain/money.js";

const P = (pa, mg, mn, qte = 1, tva = 19) => {
  const pricing = calculateLinePricing({
    prixAchatGrandeAgence: pa, typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: mg,
    typeMargeNotreAgence: "POURCENTAGE", valeurMargeNotreAgence: mn,
  });
  return { pricing, totals: calculateLineTotals({ quantite: qte, prixAchatGrandeAgence: pa,
    prixAchatNotreAgence: pricing.prixAchatNotreAgence, prixVenteNotreAgence: pricing.prixVenteNotreAgence, tauxTva: tva }) };
};

describe("pricing — cas nominaux §44", () => {
  it("100 + 20% = 120 puis 120 + 15% = 138", () => {
    const { pricing } = P(100, 20, 15);
    assert.equal(pricing.prixAchatNotreAgence, 120);
    assert.equal(pricing.prixVenteNotreAgence, 138);
  });
  it("montants fixes : 100+25=125 puis 125+20=145", () => {
    const r = calculateLinePricing({ prixAchatGrandeAgence: 100,
      typeMargeGrandeAgence: "MONTANT_FIXE", valeurMargeGrandeAgence: 25,
      typeMargeNotreAgence: "MONTANT_FIXE", valeurMargeNotreAgence: 20 });
    assert.equal(r.prixAchatNotreAgence, 125);
    assert.equal(r.prixVenteNotreAgence, 145);
  });
  it("quantité : 20 × 138 = 2760 HT", () => {
    const { totals } = P(100, 20, 15, 20, 0);
    assert.equal(totals.totalHt, 2760);
  });
  it("TVA 19% sur 2760 = 524.4, TTC 3284.4", () => {
    const { totals } = P(100, 20, 15, 20, 19);
    assert.equal(totals.montantTva, 524.4);
    assert.equal(totals.totalTtc, 3284.4);
  });
});

describe("pricing — cas limites", () => {
  it("quantité zéro ou négative rejetée", () => {
    assert.throws(() => calculateLineTotals({ quantite: 0, prixAchatGrandeAgence: 10, prixAchatNotreAgence: 10, prixVenteNotreAgence: 10, tauxTva: 19 }));
  });
  it("prix négatif rejeté", () => {
    assert.throws(() => calculateLinePricing({ prixAchatGrandeAgence: -5,
      typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 10,
      typeMargeNotreAgence: "POURCENTAGE", valeurMargeNotreAgence: 10 }));
  });
  it("marge zéro acceptée", () => {
    const r = calculateLinePricing({ prixAchatGrandeAgence: 100,
      typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 0,
      typeMargeNotreAgence: "POURCENTAGE", valeurMargeNotreAgence: 0 });
    assert.equal(r.prixVenteNotreAgence, 100);
  });
  it("arrondi décimal : 10.555 + 10% = 11.611", () => {
    const r = calculateLinePricing({ prixAchatGrandeAgence: 10.555,
      typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 10,
      typeMargeNotreAgence: "POURCENTAGE", valeurMargeNotreAgence: 0 });
    assert.equal(r.prixAchatNotreAgence, roundMoney(10.555 * 1.1));
  });
  it("TVA invalide rejetée", () => {
    assert.throws(() => calculateLineTotals({ quantite: 1, prixAchatGrandeAgence: 10, prixAchatNotreAgence: 10, prixVenteNotreAgence: 10, tauxTva: 150 }));
  });
});

describe("totaux projet = somme des lignes", () => {
  it("agrège correctement", () => {
    const t = calculateProjectTotals([
      { prixAchatGrandeAgence: 100, typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 20,
        typeMargeNotreAgence: "POURCENTAGE", valeurMargeNotreAgence: 15, quantite: 20, tauxTva: 19 },
      { prixAchatGrandeAgence: 50, typeMargeGrandeAgence: "MONTANT_FIXE", valeurMargeGrandeAgence: 10,
        typeMargeNotreAgence: "POURCENTAGE", valeurMargeNotreAgence: 10, quantite: 2, tauxTva: 7 },
    ]);
    assert.equal(t.prixVenteHt, 2760 + 132);
    assert.ok(t.totalTtc > t.prixVenteHt);
  });
});

describe("machine à états", () => {
  it("BROUILLON → VALIDE et ANNULE autorisés", () => {
    assertTransitionProject(PROJECT_STATUS.BROUILLON, PROJECT_STATUS.VALIDE);
    assertTransitionProject(PROJECT_STATUS.BROUILLON, PROJECT_STATUS.ANNULE);
  });
  it("VALIDE → BROUILLON interdit", () => {
    assert.throws(() => assertTransitionProject(PROJECT_STATUS.VALIDE, PROJECT_STATUS.BROUILLON));
  });
  it("ANNULE → VALIDE interdit", () => {
    assert.throws(() => assertTransitionProject(PROJECT_STATUS.ANNULE, PROJECT_STATUS.VALIDE));
  });
});
