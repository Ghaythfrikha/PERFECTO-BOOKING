// Tests dashboard & PDF (§22) : base isolée, cas vides/limites, filtres, multipage.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ERP_DB_PATH = join(tmpdir(), `erp-dash-test-${Date.now()}-${process.pid}.db`);

const { getDb } = await import("../src/infrastructure/db/database.js");
const { Projects } = await import("../src/application/projects.js");
const { confirmProject } = await import("../src/application/documentFlow.js");
const { Encaissements, Paiements } = await import("../src/application/finance.js");
const { pilotage } = await import("../src/application/dashboard.js");
const { genererPdf } = await import("../src/documents/buildPdf.js");

let ids = {};
before(() => {
  const db = getDb();
  ids.cli1 = db.prepare("INSERT INTO customers (code,name,is_active) VALUES ('DC-1','Client Un',1)").run().lastInsertRowid;
  ids.cli2 = db.prepare("INSERT INTO customers (code,name,is_active) VALUES ('DC-2','Client Deux',1)").run().lastInsertRowid;
  ids.f1 = db.prepare("INSERT INTO suppliers (code,name,is_active) VALUES ('DF-1','Hôtel A',1)").run().lastInsertRowid;
  ids.f2 = db.prepare("INSERT INTO suppliers (code,name,is_active) VALUES ('DF-2','Bus B',1)").run().lastInsertRowid;
  ids.cat1 = db.prepare("INSERT INTO article_categories (code,label) VALUES ('DH','Hébergement')").run().lastInsertRowid;
  ids.cat2 = db.prepare("INSERT INTO article_categories (code,label) VALUES ('DT','Transport')").run().lastInsertRowid;
  ids.a1 = db.prepare("INSERT INTO articles (code,designation,category_id,unit,is_active) VALUES ('DA-1','Nuitée',?, 'Nuit',1)").run(ids.cat1).lastInsertRowid;
  ids.a2 = db.prepare("INSERT INTO articles (code,designation,category_id,unit,is_active) VALUES ('DA-2','Trajet',?, 'Bus',1)").run(ids.cat2).lastInsertRowid;
  ids.t19 = db.prepare("INSERT INTO vat_rates (code,label,rate,is_active) VALUES ('DT19','TVA 19 %',19,1)").run().lastInsertRowid;
  ids.vir = db.prepare("INSERT INTO transaction_types (code,label,is_active) VALUES ('DVIR','Virement',1)").run().lastInsertRowid;
});

const ligne = (a, f) => ({ articleId: a, fournisseurId: f, quantite: 10, unit: "Nuit", prixAchatGrandeAgence: 100,
  typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 20, typeMargeNotreAgence: "POURCENTAGE",
  valeurMargeNotreAgence: 15, vatRateId: ids.t19, tauxTva: 19 });

function projetComplet(clientId, lignes) {
  const p = Projects.create({ titre: "Dash", clientId, dateDebut: "2026-01-10", dateFin: "2026-01-12", notes: null }, null);
  for (const l of lignes) Projects.addLine(p.id, l, null);
  Projects.validate(p.id, null);
  confirmProject(p.id, null);
  return p.id;
}

describe("pilotage à vide", () => {
  it("aucune donnée → zéros et listes vides, sans erreur", () => {
    const d = pilotage({});
    assert.deepEqual([d.projets.BROUILLON, d.projets.VALIDE, d.projets.ANNULE], [0, 0, 0]);
    assert.equal(d.caMensuel.length, 12);
    assert.ok(d.caMensuel.every((m) => m.vendu === 0 && m.facture === 0 && m.recu === 0));
    assert.equal(d.facturesAchat.totalTtc, 0);
    assert.deepEqual([d.topFournisseurs.length, d.topClients.length, d.caParCategorie.length], [0, 0, 0]);
    assert.deepEqual(d.alertes, []);
    assert.deepEqual(d.activite, []);
  });
});

describe("pilotage avec activité", () => {
  it("mois multiples, tops, catégories, reçus par période", () => {
    const db = getDb();
    const p1 = projetComplet(ids.cli1, [ligne(ids.a1, ids.f1)]);
    const p2 = projetComplet(ids.cli2, [ligne(ids.a2, ids.f2)]);
    db.prepare("UPDATE projects SET validated_at='2026-03-15 10:00:00' WHERE id=?").run(p1);
    db.prepare("UPDATE projects SET validated_at='2026-05-20 10:00:00' WHERE id=?").run(p2);
    db.prepare("UPDATE sales_invoices SET issue_date='2026-03-16' WHERE project_id=?").run(p1);
    db.prepare("UPDATE sales_invoices SET issue_date='2026-05-21' WHERE project_id=?").run(p2);
    const fv1 = db.prepare("SELECT id FROM sales_invoices WHERE project_id=?").get(p1).id;
    Encaissements.create({ dateTransaction: "2026-03-20", montantHt: 500, vatRateId: ids.t19, typeId: ids.vir, factureVenteId: fv1 }, null);
    Encaissements.create({ dateTransaction: "2026-06-05", montantHt: 200, vatRateId: ids.t19, typeId: ids.vir }, null);

    const d = pilotage({ debut: "2026-01-01", fin: "2026-12-31" });
    assert.equal(d.projets.VALIDE, 2);
    const janv = d.caMensuel.find((m) => m.mois === "2026-01");
    const mars = d.caMensuel.find((m) => m.mois === "2026-03");
    const juin = d.caMensuel.find((m) => m.mois === "2026-06");
    assert.ok(janv.vendu > 0, "vendu au mois de l'événement : " + JSON.stringify(janv));
    assert.ok(mars.vendu === 0 && mars.facture > 0 && mars.recu === 500, JSON.stringify(mars));
    assert.equal(juin.recu, 200);
    assert.equal(juin.vendu, 0, "reçu ≠ vendu : ventes non affectées au mois de l'encaissement");
    assert.equal(d.topFournisseurs.length, 2);
    assert.equal(d.topClients.length, 2);
    assert.equal(d.caParCategorie.length, 2);
    assert.ok(d.caParCategorie.every((x) => x.ht > 0 && x.part > 0));
    assert.equal(d.rentabilite.top.length, 2);
    assert.ok(d.rentabilite.top.every((r) => r.marge > 0 && r.ca > 0 && r.cout > 0));
    assert.ok(d.activite.length > 0, "activité issue de l'audit existant");
  });

  it("filtres combinés : client + période personnalisée (date d'événement)", () => {
    const d = pilotage({ debut: "2026-01-01", fin: "2026-01-31", clientId: ids.cli1 });
    assert.equal(d.projets.VALIDE, 1);
    assert.equal(d.topClients.length, 1);
    assert.equal(d.topClients[0].nom, "Client Un");
    const d2 = pilotage({ debut: "2026-01-01", fin: "2026-01-31", clientId: 999999 });
    assert.equal(d2.projets.VALIDE, 0, "aucun projet pour ce client");
    const d3 = pilotage({ debut: "2026-05-01", fin: "2026-05-31" });
    assert.equal(d3.projets.VALIDE, 0, "aucun événement en mai");
    assert.deepEqual(d3.caMensuel.map((m) => m.mois), ["2026-05"], "courbe restreinte à la période");
  });

  it("factures partiellement payées et alertes actionnables", () => {
    const db = getDb();
    Projects.create({ titre: "Brouillon à valider", clientId: ids.cli1, dateDebut: "2026-07-01", dateFin: "2026-07-02", notes: null }, null);
    const fa = db.prepare("SELECT id, supplier_id FROM purchase_invoices LIMIT 1").get();
    Paiements.create({ factureAchatId: fa.id, montantHt: 50, vatRateId: ids.t19, typeId: ids.vir }, null);
    const d = pilotage({});
    assert.equal(d.facturesAchat.partielles, 1);
    assert.equal(d.facturesAchat.nonPayees, 1);
    assert.ok(d.facturesAchat.surveiller.length > 0);
    const partielle = d.facturesAchat.surveiller.find((x) => x.statut === "PARTIEL");
    assert.ok(partielle && partielle.reste > 0 && partielle.paye > 0, "une facture partielle suivie");
    assert.ok(d.alertes.some((a) => a.cible.vue === "projets"), "alerte brouillons/projets");
    assert.ok(d.alertes.some((a) => a.cible.vue === "factures"), "alerte factures d'achat");
    assert.ok(d.alertes.every((a) => !/vente.*(impayée|payée|encaissée)/i.test(a.libelle)), "jamais de suivi vente encaissée");
  });

  it("marge négative signalée sans seuil inventé", () => {
    const db = getDb();
    const p = db.prepare("SELECT id FROM projects WHERE status='VALIDE' LIMIT 1").get().id;
    db.prepare("UPDATE projects SET total_marge_notre_agence=-12.5 WHERE id=?").run(p);
    const d = pilotage({});
    assert.ok(d.rentabilite.surveiller.length > 0);
    assert.ok(d.alertes.some((a) => /négative/.test(a.libelle) && a.cible.vue === "projet"));
    db.prepare("UPDATE projects SET total_marge_notre_agence=(total_ht - total_achat_notre_agence) WHERE id=?").run(p);
  });
});

function pdfBase(lignes) {
  return { titre: "Facture de vente", reference: "FV-T-001", date: "2026-03-16", refProjet: "P-T-001",
    tiersTitre: "Client", tiersLignes: ["Client Un"], lignes, totauxLignes: [["Total HT", 100]], totalTtc: 119 };
}

describe("PDF (§18-§21)", () => {
  // pdfkit écrit le contenu en fragments hexadécimaux : on les décode pour vérifier le texte réel.
  const textePdf = (buf) => [...buf.toString("latin1").matchAll(/<([0-9A-Fa-f]{2,})>/g)]
    .map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("");
  it("zéro ligne : en-têtes présents, pas de tableau aveugle", async () => {
    const txt = textePdf(await genererPdf(pdfBase([])));
    for (const h of ["Prestation", "Montant HT", "TTC", "Imprimé le"]) assert.ok(txt.includes(h), h);
    assert.ok(txt.includes("Aucune ligne"));
  });
  it("une ligne : données + en-têtes", async () => {
    const txt = textePdf(await genererPdf(pdfBase([{ designation: "Nuitée", description: "Chambre double, vue mer, petit déjeuner inclus",
      quantity: 2, unit: "Nuit", unitPrice: 100, tauxTva: 19, totalHt: 200, totalTtc: 238 }])));
    assert.ok(txt.includes("Prestation"));
    assert.ok(txt.includes("Imprimé le"));
  });
  it("multipage : en-têtes répétés sur chaque page", async () => {
    const lignes = Array.from({ length: 45 }, (_, i) => ({ designation: `Prestation ${i + 1}`,
      description: "Description longue répétée pour tester le rendu multipage du tableau", quantity: 1, unit: "Unité",
      unitPrice: 10, tauxTva: 19, totalHt: 10, totalTtc: 11.9 }));
    const buf = await genererPdf(pdfBase(lignes));
    const brut = buf.toString("latin1");
    const pages = brut.split("/Type /Page").length - 1 - 1; // moins le nœud /Pages
    assert.ok(pages > 1, "plusieurs pages");
    const nbEntetes = textePdf(buf).split("Prestation").length - 1;
    assert.ok(nbEntetes >= pages, `en-têtes répétés (${nbEntetes} >= ${pages})`);
  });
});
