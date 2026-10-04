import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupProjectLinesBySupplier, buildPurchaseOrderLines, buildSalesInvoiceLines, buildPurchaseInvoiceLines, sumDocLines, calculateInvoiceLineMargin } from "../src/domain/documents.js";
import { assertDocTransition } from "../src/domain/constants.js";

// Lignes telles que décrites dans l'exemple §54
const LIGNES = [
  { id: 1, supplier_id: 10, quantity: 20, unit: "Nuit", prix_achat_grande_agence: 100, prix_vente_notre_agence: 138, taux_tva: 19, article_designation_snapshot: "Chambre hôtel", article_code_snapshot: "ART-1" },
  { id: 2, supplier_id: 20, quantity: 2, unit: "Bus", prix_achat_grande_agence: 500, prix_vente_notre_agence: 649, taux_tva: 7, article_designation_snapshot: "Transport", article_code_snapshot: "ART-2" },
  { id: 3, supplier_id: 10, quantity: 20, unit: "Personne", prix_achat_grande_agence: 30, prix_vente_notre_agence: 41.4, taux_tva: 7, article_designation_snapshot: "Petit déjeuner", article_code_snapshot: "ART-3" },
];

describe("regroupement par fournisseur (§54)", () => {
  it("génère un groupe par fournisseur, chaque ligne dans la commande de son fournisseur", () => {
    const g = groupProjectLinesBySupplier(LIGNES);
    assert.equal(g.size, 2);
    assert.deepEqual(g.get(10).map((l) => l.id), [1, 3]);
    assert.deepEqual(g.get(20).map((l) => l.id), [2]);
  });
  it("ligne sans fournisseur → erreur (commande impossible)", () => {
    assert.throws(() => groupProjectLinesBySupplier([{ id: 9, quantity: 1 }]), /sans fournisseur/);
  });
});

describe("commande d'achat : prix d'achat Vos Voyage uniquement (§54, §67)", () => {
  it("Hôtel A : 20×100 et 20×30 (jamais 138 ni 41.4)", () => {
    const lignes = buildPurchaseOrderLines(groupProjectLinesBySupplier(LIGNES).get(10));
    assert.equal(lignes.length, 2);
    assert.equal(lignes[0].unitPrice, 100);
    assert.equal(lignes[1].unitPrice, 30);
    assert.equal(lignes[0].totalHt, 2000);
    assert.equal(lignes[1].totalHt, 600);
    assert.ok(!lignes.some((l) => l.unitPrice === 138 || l.unitPrice === 41.4));
  });
  it("Bus B : 2×500", () => {
    const lignes = buildPurchaseOrderLines(groupProjectLinesBySupplier(LIGNES).get(20));
    assert.equal(lignes[0].unitPrice, 500);
    assert.equal(lignes[0].totalHt, 1000);
  });
});

describe("facture de vente : prix de vente uniquement (§57, §67)", () => {
  it("reprend les prix de vente validés sans les recalculer", () => {
    const lignes = buildSalesInvoiceLines(LIGNES);
    assert.deepEqual(lignes.map((l) => l.unitPrice), [138, 649, 41.4]);
    assert.equal(lignes[0].totalHt, 2760);
    const tot = sumDocLines(lignes);
    assert.equal(tot.totalHt, 2760 + 1298 + 828);
  });
});

describe("marge des lignes de facture de vente", () => {
  it("le coût d'achat est snapshoté sur la ligne", () => {
    const lignes = buildSalesInvoiceLines([{ id: 1, quantity: 10, prix_achat_notre_agence: 120, prix_vente_notre_agence: 138, taux_tva: 19 }]);
    assert.equal(lignes[0].coutAchat, 120);
  });
  it("(138 − 120) × 10 = 180", () => {
    assert.equal(calculateInvoiceLineMargin(138, 120, 10), 180);
  });
  it("sans coût connu : marge 0, jamais gonflée", () => {
    assert.equal(calculateInvoiceLineMargin(138, null, 10), 0);
    assert.equal(calculateInvoiceLineMargin(138, undefined, 10), 0);
  });
});

describe("facture d'achat : traçabilité commande (§58)", () => {
  it("reprend les lignes de commande avec lien fin", () => {
    const po = buildPurchaseOrderLines(groupProjectLinesBySupplier(LIGNES).get(10))
      .map((l, i) => ({ id: 100 + i, project_line_id: [1, 3][i], quantity: l.quantity, unit_price: l.unitPrice, taux_tva: l.tauxTva, article_designation_snapshot: l.designation, article_code_snapshot: l.code, description: null, unit: l.unit, vat_label_snapshot: null }));
    const fa = buildPurchaseInvoiceLines(po);
    assert.equal(fa[0].purchaseOrderLineId, 100);
    assert.equal(fa[0].projectLineId, 1);
    assert.equal(fa[0].unitPrice, 100);
  });
});

describe("cycles de vie documentaires (§59)", () => {
  it("commande : BROUILLON → VALIDEE → CLOTUREE", () => {
    assertDocTransition("PO", "BROUILLON", "VALIDEE");
    assertDocTransition("PO", "VALIDEE", "CLOTUREE");
    assert.throws(() => assertDocTransition("PO", "BROUILLON", "CLOTUREE"));
    assert.throws(() => assertDocTransition("PO", "CLOTUREE", "BROUILLON"));
  });
  it("factures : BROUILLON → VALIDEE → ANNULEE", () => {
    assertDocTransition("INV", "BROUILLON", "VALIDEE");
    assertDocTransition("INV", "VALIDEE", "ANNULEE");
    assert.throws(() => assertDocTransition("INV", "VALIDEE", "BROUILLON"));
    assert.throws(() => assertDocTransition("INV", "ANNULEE", "VALIDEE"));
  });
});
