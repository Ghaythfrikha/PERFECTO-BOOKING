// Tests extension financière (§30) : schéma PostgreSQL DÉDIÉ par fichier
// (TEST_SCHEMA), jamais la base réelle. Vérifient le backend/domaine, pas l'UI.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_SCHEMA = "t_finance";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "";

const { initDb, getDb, closeDb } = await import("../src/infrastructure/db/database.js");
const { Projects } = await import("../src/application/projects.js");
const { confirmProject, getDoc, deleteDoc } = await import("../src/application/documentFlow.js");
const { Encaissements, Paiements } = await import("../src/application/finance.js");
const { pilotageFinancier } = await import("../src/application/finance.js");
const { calculateTransactionAmounts, derivePaymentStatus, PAYMENT_STATUS } = await import("../src/domain/payments.js");

let ids = {};
before(async () => {
  await initDb();
  const db = getDb();
  const ins = async (sql, ...p) => (await db.run(sql + " RETURNING id", ...p)).lastInsertRowid;
  ids.cli = await ins("INSERT INTO customers (code,name,is_active) VALUES ('CLI-T','Client Test',1)");
  ids.f1 = await ins("INSERT INTO suppliers (code,name,is_active) VALUES ('F-T1','Hôtel Test',1)");
  ids.f2 = await ins("INSERT INTO suppliers (code,name,is_active) VALUES ('F-T2','Bus Test',1)");
  ids.a1 = await ins("INSERT INTO articles (code,designation,unit,is_active) VALUES ('A-T1','Nuitée','Nuit',1)");
  ids.a2 = await ins("INSERT INTO articles (code,designation,unit,is_active) VALUES ('A-T2','Transport','Bus',1)");
  ids.t19 = await ins("INSERT INTO vat_rates (code,label,rate,is_active) VALUES ('T-T19','TVA 19 %',19,1)");
  ids.virement = await ins("INSERT INTO transaction_types (code,label,is_active) VALUES ('VIR-T','Virement Test',1)");
});
after(async () => {
  const db = getDb();
  await db.query('DROP SCHEMA IF EXISTS "t_finance" CASCADE');
  await closeDb();
});

async function projetAvecLignes() {
  const p = await Projects.create({ titre: "Projet Finance", clientId: ids.cli, dateDebut: "2026-11-01", dateFin: "2026-11-02", notes: null }, null);
  const ligne = (a, f) => ({ articleId: a, fournisseurId: f, quantite: 10, unit: "Nuit", prixAchatGrandeAgence: 100,
    typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 20, typeMargeNotreAgence: "POURCENTAGE",
    valeurMargeNotreAgence: 15, vatRateId: ids.t19, tauxTva: 19 });
  await Projects.addLine(p.id, ligne(ids.a1, ids.f1), null);
  await Projects.addLine(p.id, ligne(ids.a2, ids.f2), null);
  return (await Projects.validate(p.id, null)).id;
}

describe("documents générés directement VALIDÉE (§1)", () => {
  it("commandes, facture vente et factures achat naissent VALIDÉE avec validated_at", async () => {
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    for (const t of ["purchase_orders", "sales_invoices", "purchase_invoices"]) {
      const rows = await db.all(`SELECT status, validated_at FROM ${t} WHERE project_id=$1`, pid);
      assert.ok(rows.length > 0, t);
      for (const r of rows) {
        assert.equal(r.status, "VALIDEE", t);
        assert.ok(r.validated_at, t + " validated_at");
      }
    }
    const n = (await db.get("SELECT COUNT(*) c FROM purchase_orders WHERE project_id=$1 AND status='BROUILLON'", pid)).c;
    assert.equal(n, 0, "aucun document auto en BROUILLON");
  });
});

describe("encaissements (§6-§8)", () => {
  it("HT 1000 + TVA 19 % → 190 / 1190 (recalcul backend)", async () => {
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    const fv = await db.get("SELECT id, total_ttc FROM sales_invoices WHERE project_id=$1", pid);
    const t = await Encaissements.create({ montantHt: 1000, vatRateId: ids.t19, typeId: ids.virement, factureVenteId: fv.id }, null);
    assert.equal(t.amount_ht, 1000);
    assert.equal(t.tva_amount, 190);
    assert.equal(t.amount_ttc, 1190);
    assert.equal(t.project_id, pid);
    const tot = await Encaissements.totals();
    assert.ok(tot.totalTtc >= 1190);
  });
  it("plusieurs encaissements pour une même facture ; dépassement refusé", async () => {
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    const fv = await db.get("SELECT id, total_ttc FROM sales_invoices WHERE project_id=$1", pid);
    await Encaissements.create({ montantHt: 100, vatRateId: ids.t19, typeId: ids.virement, factureVenteId: fv.id }, null);
    await assert.rejects(() => Encaissements.create({ montantHt: fv.total_ttc, tauxTva: 0, typeId: ids.virement, factureVenteId: fv.id }, null), /dépasse le restant/);
  });
  it("montant nul/négatif et TVA invalide refusés", () => {
    assert.throws(() => calculateTransactionAmounts(0, 19), /supérieur à zéro/);
    assert.throws(() => calculateTransactionAmounts(-5, 19), /supérieur à zéro/);
    assert.throws(() => calculateTransactionAmounts(100, 150), /TVA invalide/);
  });
});

describe("paiements fournisseurs (§10-§11)", () => {
  it("partiel → PARTIEL + reste ; complet → TOTAL ; dépassement refusé", async () => {
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    const fa = await db.get("SELECT id, total_ttc FROM purchase_invoices WHERE project_id=$1 LIMIT 1", pid);
    const sol0 = await Paiements.soldeFacture(fa.id);
    assert.equal(sol0.statut, PAYMENT_STATUS.NON_PAYE);
    await Paiements.create({ factureAchatId: fa.id, montantHt: 100, vatRateId: ids.t19, typeId: ids.virement }, null);
    const s1 = await Paiements.soldeFacture(fa.id);
    assert.equal(s1.statut, PAYMENT_STATUS.PARTIEL);
    assert.equal(s1.reste, Math.round((fa.total_ttc - 119) * 1000) / 1000);
    await assert.rejects(() => Paiements.create({ factureAchatId: fa.id, montantHt: fa.total_ttc, tauxTva: 0, typeId: ids.virement }, null), /dépasse le restant/);
    await Paiements.create({ factureAchatId: fa.id, montantHt: s1.reste, tauxTva: 0, typeId: ids.virement }, null);
    assert.equal((await Paiements.soldeFacture(fa.id)).statut, PAYMENT_STATUS.TOTAL);
  });
  it("fournisseur incohérent ou facture inexistante refusés", async () => {
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    const fa = await db.get("SELECT id, supplier_id FROM purchase_invoices WHERE project_id=$1 LIMIT 1", pid);
    const autre = fa.supplier_id === ids.f1 ? ids.f2 : ids.f1;
    await assert.rejects(() => Paiements.create({ factureAchatId: fa.id, fournisseurId: autre, montantHt: 10, tauxTva: 0, typeId: ids.virement }, null), /ne correspond pas/);
    await assert.rejects(() => Paiements.create({ factureAchatId: 999999, montantHt: 10, tauxTva: 0, typeId: ids.virement }, null), /introuvable/);
  });
  it("suppression d'un paiement restaure le restant (statut dérivé)", async () => {
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    const fa = await db.get("SELECT id FROM purchase_invoices WHERE project_id=$1 LIMIT 1", pid);
    const pay = await Paiements.create({ factureAchatId: fa.id, montantHt: 50, tauxTva: 0, typeId: ids.virement }, null);
    assert.equal((await Paiements.soldeFacture(fa.id)).statut, PAYMENT_STATUS.PARTIEL);
    await Paiements.delete(pay.id, null);
    assert.equal((await Paiements.soldeFacture(fa.id)).statut, PAYMENT_STATUS.NON_PAYE);
  });
});

describe("marge facturée = marges des lignes de factures de vente (sans lien achats)", () => {
  it("2 lignes (138 − 120) × 10 → +360 au pilotage, coût snapshoté en base", async () => {
    const avant = (await pilotageFinancier()).margeFactureeHt;
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    const lignes = await db.all(`SELECT unit_price, cout_achat_snapshot, quantity FROM sales_invoice_lines
      WHERE sales_invoice_id = (SELECT id FROM sales_invoices WHERE project_id=$1)`, pid);
    assert.equal(lignes.length, 2);
    for (const l of lignes) assert.equal(l.cout_achat_snapshot, 120);
    const apres = (await pilotageFinancier()).margeFactureeHt;
    assert.equal(Math.round((apres - avant) * 1000) / 1000, 360);
  });
});

describe("intégrité (§18, §30)", () => {
  it("suppression d'une facture validée (même payée) refusée", async () => {
    const pid = await projetAvecLignes();
    await confirmProject(pid, null);
    const db = getDb();
    const fa = await db.get("SELECT id FROM purchase_invoices WHERE project_id=$1 LIMIT 1", pid);
    await Paiements.create({ factureAchatId: fa.id, montantHt: 10, tauxTva: 0, typeId: ids.virement }, null);
    await assert.rejects(() => deleteDoc("pi", fa.id), /ne peut pas être supprimé/);
    const si = await db.get("SELECT id FROM sales_invoices WHERE project_id=$1", pid);
    assert.equal((await getDoc("si", si.id)).status, "VALIDEE");
  });
  it("statuts dérivés : seuils", () => {
    assert.equal(derivePaymentStatus(1000, 0), PAYMENT_STATUS.NON_PAYE);
    assert.equal(derivePaymentStatus(1000, 400), PAYMENT_STATUS.PARTIEL);
    assert.equal(derivePaymentStatus(1000, 1000), PAYMENT_STATUS.TOTAL);
  });
});
