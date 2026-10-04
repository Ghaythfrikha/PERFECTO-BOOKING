// Tests extension financière (§30) : exécutés contre une base SQLite ISOLÉE
// (ERP_DB_PATH), jamais la base réelle. Vérifient le backend/domaine, pas l'UI.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ERP_DB_PATH = join(tmpdir(), `erp-test-${Date.now()}-${process.pid}.db`);

const { getDb } = await import("../src/infrastructure/db/database.js");
const { Projects } = await import("../src/application/projects.js");
const { confirmProject, getDoc, deleteDoc } = await import("../src/application/documentFlow.js");
const { Encaissements, Paiements } = await import("../src/application/finance.js");
const { pilotageFinancier } = await import("../src/application/finance.js");
const { calculateTransactionAmounts, derivePaymentStatus, PAYMENT_STATUS } = await import("../src/domain/payments.js");

let ids = {};
before(() => {
  const db = getDb();
  const cli = db.prepare("INSERT INTO customers (code,name,is_active) VALUES ('CLI-T','Client Test',1)").run().lastInsertRowid;
  const f1 = db.prepare("INSERT INTO suppliers (code,name,is_active) VALUES ('F-T1','Hôtel Test',1)").run().lastInsertRowid;
  const f2 = db.prepare("INSERT INTO suppliers (code,name,is_active) VALUES ('F-T2','Bus Test',1)").run().lastInsertRowid;
  const a1 = db.prepare("INSERT INTO articles (code,designation,unit,is_active) VALUES ('A-T1','Nuitée','Nuit',1)").run().lastInsertRowid;
  const a2 = db.prepare("INSERT INTO articles (code,designation,unit,is_active) VALUES ('A-T2','Transport','Bus',1)").run().lastInsertRowid;
  const t19 = db.prepare("INSERT INTO vat_rates (code,label,rate,is_active) VALUES ('T-T19','TVA 19 %',19,1)").run().lastInsertRowid;
  const virement = db.prepare("INSERT INTO transaction_types (code,label,is_active) VALUES ('VIR-T','Virement Test',1)").run().lastInsertRowid;
  ids = { cli, f1, f2, a1, a2, t19, virement };
});

function projetAvecLignes() {
  const p = Projects.create({ titre: "Projet Finance", clientId: ids.cli, dateDebut: "2026-11-01", dateFin: "2026-11-02", notes: null }, null);
  const ligne = (a, f) => ({ articleId: a, fournisseurId: f, quantite: 10, unit: "Nuit", prixAchatGrandeAgence: 100,
    typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 20, typeMargeNotreAgence: "POURCENTAGE",
    valeurMargeNotreAgence: 15, vatRateId: ids.t19, tauxTva: 19 });
  Projects.addLine(p.id, ligne(ids.a1, ids.f1), null);
  Projects.addLine(p.id, ligne(ids.a2, ids.f2), null);
  return Projects.validate(p.id, null).id;
}

describe("documents générés directement VALIDÉE (§1)", () => {
  it("commandes, facture vente et factures achat naissent VALIDÉE avec validated_at", () => {
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    for (const t of ["purchase_orders", "sales_invoices", "purchase_invoices"]) {
      const rows = db.prepare(`SELECT status, validated_at FROM ${t} WHERE project_id=?`).all(pid);
      assert.ok(rows.length > 0, t);
      for (const r of rows) {
        assert.equal(r.status, "VALIDEE", t);
        assert.ok(r.validated_at, t + " validated_at");
      }
    }
    const n = db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE project_id=? AND status='BROUILLON'").get(pid).c;
    assert.equal(n, 0, "aucun document auto en BROUILLON");
  });
});

describe("encaissements (§6-§8)", () => {
  it("HT 1000 + TVA 19 % → 190 / 1190 (recalcul backend)", () => {
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    const fv = db.prepare("SELECT id, total_ttc FROM sales_invoices WHERE project_id=?").get(pid);
    const t = Encaissements.create({ montantHt: 1000, vatRateId: ids.t19, typeId: ids.virement, factureVenteId: fv.id }, null);
    assert.equal(t.amount_ht, 1000);
    assert.equal(t.tva_amount, 190);
    assert.equal(t.amount_ttc, 1190);
    assert.equal(t.project_id, pid);
    const tot = Encaissements.totals();
    assert.ok(tot.totalTtc >= 1190);
  });
  it("plusieurs encaissements pour une même facture ; dépassement refusé", () => {
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    const fv = db.prepare("SELECT id, total_ttc FROM sales_invoices WHERE project_id=?").get(pid);
    Encaissements.create({ montantHt: 100, vatRateId: ids.t19, typeId: ids.virement, factureVenteId: fv.id }, null);
    assert.throws(() => Encaissements.create({ montantHt: fv.total_ttc, tauxTva: 0, typeId: ids.virement, factureVenteId: fv.id }, null), /dépasse le restant/);
  });
  it("montant nul/négatif et TVA invalide refusés", () => {
    assert.throws(() => calculateTransactionAmounts(0, 19), /supérieur à zéro/);
    assert.throws(() => calculateTransactionAmounts(-5, 19), /supérieur à zéro/);
    assert.throws(() => calculateTransactionAmounts(100, 150), /TVA invalide/);
  });
});

describe("paiements fournisseurs (§10-§11)", () => {
  it("partiel → PARTIEL + reste ; complet → TOTAL ; dépassement refusé", () => {
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    const fa = db.prepare("SELECT id, total_ttc FROM purchase_invoices WHERE project_id=? LIMIT 1").get(pid);
    const soil0 = Paiements.soldeFacture(fa.id);
    assert.equal(soil0.statut, PAYMENT_STATUS.NON_PAYE);
    Paiements.create({ factureAchatId: fa.id, montantHt: 100, vatRateId: ids.t19, typeId: ids.virement }, null);
    const s1 = Paiements.soldeFacture(fa.id);
    assert.equal(s1.statut, PAYMENT_STATUS.PARTIEL);
    assert.equal(s1.reste, Math.round((fa.total_ttc - 119) * 1000) / 1000);
    assert.throws(() => Paiements.create({ factureAchatId: fa.id, montantHt: fa.total_ttc, tauxTva: 0, typeId: ids.virement }, null), /dépasse le restant/);
    Paiements.create({ factureAchatId: fa.id, montantHt: s1.reste, tauxTva: 0, typeId: ids.virement }, null);
    assert.equal(Paiements.soldeFacture(fa.id).statut, PAYMENT_STATUS.TOTAL);
  });
  it("fournisseur incohérent ou facture inexistante refusés", () => {
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    const fa = db.prepare("SELECT id, supplier_id FROM purchase_invoices WHERE project_id=? LIMIT 1").get(pid);
    const autre = fa.supplier_id === ids.f1 ? ids.f2 : ids.f1;
    assert.throws(() => Paiements.create({ factureAchatId: fa.id, fournisseurId: autre, montantHt: 10, tauxTva: 0, typeId: ids.virement }, null), /ne correspond pas/);
    assert.throws(() => Paiements.create({ factureAchatId: 999999, montantHt: 10, tauxTva: 0, typeId: ids.virement }, null), /introuvable/);
  });
  it("suppression d'un paiement restaure le restant (statut dérivé)", () => {
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    const fa = db.prepare("SELECT id FROM purchase_invoices WHERE project_id=? LIMIT 1").get(pid);
    const pay = Paiements.create({ factureAchatId: fa.id, montantHt: 50, tauxTva: 0, typeId: ids.virement }, null);
    assert.equal(Paiements.soldeFacture(fa.id).statut, PAYMENT_STATUS.PARTIEL);
    Paiements.delete(pay.id, null);
    assert.equal(Paiements.soldeFacture(fa.id).statut, PAYMENT_STATUS.NON_PAYE);
  });
});

describe("marge facturée = marges des lignes de factures de vente (sans lien achats)", () => {
  it("2 lignes (138 − 120) × 10 → +360 au pilotage, coût snapshoté en base", () => {
    const avant = pilotageFinancier().margeFactureeHt;
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    const lignes = db.prepare(`SELECT unit_price, cout_achat_snapshot, quantity FROM sales_invoice_lines
      WHERE sales_invoice_id = (SELECT id FROM sales_invoices WHERE project_id=?)`).all(pid);
    assert.equal(lignes.length, 2);
    for (const l of lignes) assert.equal(l.cout_achat_snapshot, 120);
    const apres = pilotageFinancier().margeFactureeHt;
    assert.equal(Math.round((apres - avant) * 1000) / 1000, 360);
  });
});

describe("intégrité (§18, §30)", () => {
  it("suppression d'une facture validée (même payée) refusée", () => {
    const pid = projetAvecLignes();
    confirmProject(pid, null);
    const db = getDb();
    const fa = db.prepare("SELECT id FROM purchase_invoices WHERE project_id=? LIMIT 1").get(pid);
    Paiements.create({ factureAchatId: fa.id, montantHt: 10, tauxTva: 0, typeId: ids.virement }, null);
    assert.throws(() => deleteDoc("pi", fa.id), /ne peut pas être supprimé/);
    const si = db.prepare("SELECT id FROM sales_invoices WHERE project_id=?").get(pid);
    assert.equal(getDoc("si", si.id).status, "VALIDEE");
  });
  it("statuts dérivés : seuils", () => {
    assert.equal(derivePaymentStatus(1000, 0), PAYMENT_STATUS.NON_PAYE);
    assert.equal(derivePaymentStatus(1000, 400), PAYMENT_STATUS.PARTIEL);
    assert.equal(derivePaymentStatus(1000, 1000), PAYMENT_STATUS.TOTAL);
  });
});
