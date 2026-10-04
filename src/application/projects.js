// Couche application — cas d'utilisation projet (§29, §46).
// Orchestration + transactions. Règles métier dans src/domain/.
import { getDb } from "../infrastructure/db/database.js";
import { PROJECT_STATUS, assertTransitionProject } from "../domain/constants.js";
import { calculateLinePricing, calculateLineTotals } from "../domain/pricing.js";
import { calculateProjectTotals } from "../domain/totals.js";
import { validateProjectHeader, validateProjectLineInput, validateProjectForValidation } from "../domain/validation.js";
import { assertQuantity, assertMoney } from "../domain/money.js";
import { generatePurchaseOrdersForProject, nextDocRef } from "./documentFlow.js";

function nextReference(db) {
  const year = new Date().getFullYear();
  const row = db.prepare("SELECT COUNT(*) c FROM projects WHERE reference LIKE ?").get(`P-${year}-%`);
  return `P-${year}-${String(row.c + 1).padStart(4, "0")}`;
}

function enrichLineForValidation(db, l) {
  const art = db.prepare("SELECT is_active FROM articles WHERE id=?").get(l.article_id);
  const sup = db.prepare("SELECT is_active FROM suppliers WHERE id=?").get(l.supplier_id);
  return {
    articleId: l.article_id,
    fournisseurId: l.supplier_id,
    quantite: l.quantity,
    prixAchatGrandeAgence: l.prix_achat_grande_agence,
    typeMargeGrandeAgence: l.type_marge_grande_agence,
    valeurMargeGrandeAgence: l.valeur_marge_grande_agence,
    typeMargeNotreAgence: l.type_marge_notre_agence,
    valeurMargeNotreAgence: l.valeur_marge_notre_agence,
    tauxTva: l.taux_tva,
    articleInactif: !art || !art.is_active,
    fournisseurInactif: !sup || !sup.is_active,
  };
}

function computeLine(l) {
  const pricing = calculateLinePricing({
    prixAchatGrandeAgence: l.prixAchatGrandeAgence ?? l.prix_achat_grande_agence,
    typeMargeGrandeAgence: l.typeMargeGrandeAgence ?? l.type_marge_grande_agence,
    valeurMargeGrandeAgence: l.valeurMargeGrandeAgence ?? l.valeur_marge_grande_agence,
    typeMargeNotreAgence: l.typeMargeNotreAgence ?? l.type_marge_notre_agence,
    valeurMargeNotreAgence: l.valeurMargeNotreAgence ?? l.valeur_marge_notre_agence,
  });
  const quantite = l.quantite ?? l.quantity;
  const tauxTva = l.tauxTva ?? l.taux_tva;
  const totals = calculateLineTotals({
    quantite,
    prixAchatGrandeAgence: l.prixAchatGrandeAgence ?? l.prix_achat_grande_agence,
    prixAchatNotreAgence: pricing.prixAchatNotreAgence,
    prixVenteNotreAgence: pricing.prixVenteNotreAgence,
    tauxTva,
  });
  return { pricing, totals };
}

function normLineInput(b) {
  return {
    articleId: b.articleId, fournisseurId: b.fournisseurId,
    quantite: Number(b.quantite), prixAchatGrandeAgence: Number(b.prixAchatGrandeAgence),
    typeMargeGrandeAgence: b.typeMargeGrandeAgence, valeurMargeGrandeAgence: Number(b.valeurMargeGrandeAgence),
    typeMargeNotreAgence: b.typeMargeNotreAgence, valeurMargeNotreAgence: Number(b.valeurMargeNotreAgence),
    tauxTva: Number(b.tauxTva), description: b.description || null, unit: b.unit || "Unité",
    vatRateId: b.vatRateId || null,
  };
}

function recalcAndPersistTotals(db, projectId) {
  const rows = db.prepare("SELECT * FROM project_lines WHERE project_id=?").all(projectId);
  const totals = calculateProjectTotals(rows.map((r) => ({
    prixAchatGrandeAgence: r.prix_achat_grande_agence,
    typeMargeGrandeAgence: r.type_marge_grande_agence,
    valeurMargeGrandeAgence: r.valeur_marge_grande_agence,
    typeMargeNotreAgence: r.type_marge_notre_agence,
    valeurMargeNotreAgence: r.valeur_marge_notre_agence,
    quantite: r.quantity, tauxTva: r.taux_tva,
  })));
  db.prepare(`UPDATE projects SET total_cout_grande_agence=?, total_marge_grande_agence=?, total_achat_notre_agence=?,
    total_marge_notre_agence=?, total_ht=?, total_tva=?, total_ttc=?, updated_at=datetime('now') WHERE id=?`)
    .run(totals.coutGrandeAgence, totals.margeGrandeAgence, totals.achatNotreAgence,
      totals.margeNotreAgence, totals.prixVenteHt, totals.tva, totals.totalTtc, projectId);
  return totals;
}

function requireDraft(project) {
  if (!project) throw Object.assign(new Error("Projet introuvable"), { code: "NOT_FOUND", status: 404 });
  if (project.status !== PROJECT_STATUS.BROUILLON)
    throw Object.assign(new Error("Un projet validé ou annulé ne peut pas être modifié"), { code: "FROZEN", status: 409 });
}

export const Projects = {
  create({ titre, clientId, dateDebut, dateFin, notes }, userId) {
    const db = getDb();
    const errs = validateProjectHeader({ reference: "x", titre, clientId, dateDebut, dateFin, statut: "BROUILLON" });
    if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
    const ref = nextReference(db);
    const r = db.prepare(`INSERT INTO projects (reference,title,customer_id,start_date,end_date,notes,status,created_by)
      VALUES (?,?,?,?,?,?,'BROUILLON',?)`).run(ref, titre.trim(), clientId, dateDebut || null, dateFin || null, notes || null, userId || null);
    audit(db, "project", r.lastInsertRowid, "CREATED", userId);
    return Projects.get(r.lastInsertRowid);
  },

  get(id) {
    const db = getDb();
    const p = db.prepare(`SELECT p.*, c.name customer_name FROM projects p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`).get(id);
    if (!p) return null;
    p.lines = db.prepare(`SELECT l.*, a.designation article_designation, a.code article_code, s.name supplier_name,
      v.label vat_label FROM project_lines l
      LEFT JOIN articles a ON a.id=l.article_id LEFT JOIN suppliers s ON s.id=l.supplier_id
      LEFT JOIN vat_rates v ON v.id=l.vat_rate_id
      WHERE l.project_id=? ORDER BY l.position, l.id`).all(id);
    return p;
  },

  list({ search = "", status = "", page = 1, pageSize = 20, sort = "updated_at", dir = "DESC" } = {}) {
    const db = getDb();
    const where = [];
    const params = [];
    if (status) { where.push("p.status=?"); params.push(status); }
    if (search) { where.push("(p.reference LIKE ? OR p.title LIKE ? OR c.name LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const allowed = ["reference", "title", "start_date", "total_ttc", "updated_at", "status"];
    if (!allowed.includes(sort)) sort = "updated_at";
    dir = dir === "ASC" ? "ASC" : "DESC";
    const total = db.prepare(`SELECT COUNT(*) c FROM projects p JOIN customers c ON c.id=p.customer_id ${w}`).get(...params).c;
    const rows = db.prepare(`SELECT p.*, c.name customer_name FROM projects p JOIN customers c ON c.id=p.customer_id
      ${w} ORDER BY p.${sort} ${dir} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return { rows, total, page, pageSize };
  },

  updateHeader(id, patch, userId) {
    const db = getDb();
    const tx = db.transaction(() => {
      const p = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
      requireDraft(p);
      const next = { ...p, title: patch.titre ?? p.title, customer_id: patch.clientId ?? p.customer_id,
        start_date: patch.dateDebut ?? p.start_date, end_date: patch.dateFin ?? p.end_date, notes: patch.notes ?? p.notes };
      const errs = validateProjectHeader({ reference: p.reference, titre: next.title, clientId: next.customer_id,
        dateDebut: next.start_date, dateFin: next.end_date, statut: p.status });
      if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
      db.prepare("UPDATE projects SET title=?, customer_id=?, start_date=?, end_date=?, notes=?, updated_at=datetime('now') WHERE id=?")
        .run(next.title, next.customer_id, next.start_date, next.end_date, next.notes, id);
      audit(db, "project", id, "UPDATED", userId);
    });
    tx();
    return Projects.get(id);
  },

  addLine(projectId, body, userId) {
    const db = getDb();
    const input = normLineInput(body);
    const errs = validateProjectLineInput(input);
    if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
    assertQuantity(input.quantite); assertMoney(input.prixAchatGrandeAgence, "Prix d'achat Vos Voyage");
    const tx = db.transaction(() => {
      const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
      requireDraft(p);
      const art = db.prepare("SELECT * FROM articles WHERE id=?").get(input.articleId);
      const sup = db.prepare("SELECT * FROM suppliers WHERE id=?").get(input.fournisseurId);
      if (!art) throw Object.assign(new Error("Article introuvable"), { status: 400 });
      if (!sup) throw Object.assign(new Error("Fournisseur introuvable"), { status: 400 });
      const { pricing, totals } = computeLine({ ...input, quantity: input.quantite, taux_tva: input.tauxTva });
      const vatLabel = input.vatRateId ? (db.prepare("SELECT label FROM vat_rates WHERE id=?").get(input.vatRateId)?.label || null) : null;
      const pos = db.prepare("SELECT COALESCE(MAX(position),0)+1 m FROM project_lines WHERE project_id=?").get(projectId).m;
      db.prepare(`INSERT INTO project_lines (project_id,position,article_id,supplier_id,description,quantity,unit,
        prix_achat_grande_agence,type_marge_grande_agence,valeur_marge_grande_agence,type_marge_notre_agence,valeur_marge_notre_agence,
        prix_achat_notre_agence,prix_vente_notre_agence,total_ht,montant_tva,total_ttc,vat_rate_id,taux_tva,
        article_designation_snapshot,article_code_snapshot,supplier_name_snapshot,vat_label_snapshot)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(projectId, pos, input.articleId, input.fournisseurId, input.description, input.quantite, input.unit,
          input.prixAchatGrandeAgence, input.typeMargeGrandeAgence, input.valeurMargeGrandeAgence,
          input.typeMargeNotreAgence, input.valeurMargeNotreAgence,
          pricing.prixAchatNotreAgence, pricing.prixVenteNotreAgence, totals.totalHt, totals.montantTva, totals.totalTtc,
          input.vatRateId, input.tauxTva, art.designation, art.code, sup.name, vatLabel);
      recalcAndPersistTotals(db, projectId);
      audit(db, "project", projectId, "LINE_ADDED", userId);
    });
    tx();
    return Projects.get(projectId);
  },

  updateLine(projectId, lineId, body, userId) {
    const db = getDb();
    const input = normLineInput(body);
    const errs = validateProjectLineInput(input);
    if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
    const tx = db.transaction(() => {
      const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
      requireDraft(p);
      const ex = db.prepare("SELECT * FROM project_lines WHERE id=? AND project_id=?").get(lineId, projectId);
      if (!ex) throw Object.assign(new Error("Prestation introuvable"), { status: 404 });
      const { pricing, totals } = computeLine({ ...input, quantity: input.quantite, taux_tva: input.tauxTva });
      const art = db.prepare("SELECT * FROM articles WHERE id=?").get(input.articleId);
      const sup = db.prepare("SELECT * FROM suppliers WHERE id=?").get(input.fournisseurId);
      const vatLabel = input.vatRateId ? (db.prepare("SELECT label FROM vat_rates WHERE id=?").get(input.vatRateId)?.label || null) : null;
      db.prepare(`UPDATE project_lines SET article_id=?,supplier_id=?,description=?,quantity=?,unit=?,
        prix_achat_grande_agence=?,type_marge_grande_agence=?,valeur_marge_grande_agence=?,type_marge_notre_agence=?,valeur_marge_notre_agence=?,
        prix_achat_notre_agence=?,prix_vente_notre_agence=?,total_ht=?,montant_tva=?,total_ttc=?,
        vat_rate_id=?,taux_tva=?,article_designation_snapshot=?,article_code_snapshot=?,supplier_name_snapshot=?,vat_label_snapshot=?,
        updated_at=datetime('now') WHERE id=?`)
        .run(input.articleId, input.fournisseurId, input.description, input.quantite, input.unit,
          input.prixAchatGrandeAgence, input.typeMargeGrandeAgence, input.valeurMargeGrandeAgence,
          input.typeMargeNotreAgence, input.valeurMargeNotreAgence,
          pricing.prixAchatNotreAgence, pricing.prixVenteNotreAgence, totals.totalHt, totals.montantTva, totals.totalTtc,
          input.vatRateId, input.tauxTva, art.designation, art.code, sup.name, vatLabel, lineId);
      recalcAndPersistTotals(db, projectId);
      audit(db, "project", projectId, "LINE_UPDATED", userId);
    });
    tx();
    return Projects.get(projectId);
  },

  removeLine(projectId, lineId, userId) {
    const db = getDb();
    const tx = db.transaction(() => {
      const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
      requireDraft(p);
      db.prepare("DELETE FROM project_lines WHERE id=? AND project_id=?").run(lineId, projectId);
      recalcAndPersistTotals(db, projectId);
      audit(db, "project", projectId, "LINE_REMOVED", userId);
    });
    tx();
    return Projects.get(projectId);
  },

  // Opération métier : validation (§25, §28, §46) — atomique.
  validate(projectId, userId) {
    const db = getDb();
    const tx = db.transaction(() => {
      const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
      if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
      assertTransitionProject(p.status, PROJECT_STATUS.VALIDE);
      const lines = db.prepare("SELECT * FROM project_lines WHERE project_id=?").all(projectId);
      const errs = validateProjectForValidation(
        { reference: p.reference, titre: p.title, clientId: p.customer_id, dateDebut: p.start_date, dateFin: p.end_date, statut: p.status },
        lines.map(enrichLineForValidation.bind(null, db))
      );
      if (errs.length) throw Object.assign(new Error("Validation impossible : " + errs.join(" ; ")), { status: 400, code: "VALIDATION" });
      // Recalcul autoritatif backend (§21) + snapshots historiques (§24)
      const cust = db.prepare("SELECT name FROM customers WHERE id=?").get(p.customer_id);
      for (const l of lines) {
        const { pricing, totals } = computeLine({
          prixAchatGrandeAgence: l.prix_achat_grande_agence, typeMargeGrandeAgence: l.type_marge_grande_agence,
          valeurMargeGrandeAgence: l.valeur_marge_grande_agence, typeMargeNotreAgence: l.type_marge_notre_agence,
          valeurMargeNotreAgence: l.valeur_marge_notre_agence, quantity: l.quantity, taux_tva: l.taux_tva,
        });
        const art = db.prepare("SELECT designation,code FROM articles WHERE id=?").get(l.article_id);
        const sup = db.prepare("SELECT name FROM suppliers WHERE id=?").get(l.supplier_id);
        db.prepare(`UPDATE project_lines SET prix_achat_notre_agence=?,prix_vente_notre_agence=?,total_ht=?,montant_tva=?,total_ttc=?,
          article_designation_snapshot=?,article_code_snapshot=?,supplier_name_snapshot=?,customer_name_snapshot_ignore=0 WHERE id=?`
          .replace(",customer_name_snapshot_ignore=0", ""))
          .run(pricing.prixAchatNotreAgence, pricing.prixVenteNotreAgence, totals.totalHt, totals.montantTva, totals.totalTtc,
            art.designation, art.code, sup.name, l.id);
      }
      const totals = recalcAndPersistTotals(db, projectId);
      const quoteRef = p.quote_reference || nextDocRef(db, "DEV", "projects", "quote_reference");
      db.prepare("UPDATE projects SET status='VALIDE', customer_name_snapshot=?, validated_by=?, validated_at=datetime('now'), quote_reference=?, updated_at=datetime('now') WHERE id=?")
        .run(cust.name, userId || null, quoteRef, projectId);
      audit(db, "project", projectId, "VALIDATED", userId, JSON.stringify(totals));
      // Génération automatique des commandes d'achat (1/fournisseur, PA Vos Voyage),
      // dans la MÊME transaction : tout ou rien (§54).
      generatePurchaseOrdersForProject(db, { id: projectId, reference: p.reference }, lines, userId);
    });
    tx();
    return Projects.get(projectId);
  },

  cancel(projectId, userId) {
    const db = getDb();
    const tx = db.transaction(() => {
      const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
      if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
      assertTransitionProject(p.status, PROJECT_STATUS.ANNULE);
      db.prepare("UPDATE projects SET status='ANNULE', cancelled_by=?, cancelled_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .run(userId || null, projectId);
      audit(db, "project", projectId, "CANCELLED", userId);
    });
    tx();
    return Projects.get(projectId);
  },

  duplicate(projectId, userId) {
    const db = getDb();
    let newId;
    const tx = db.transaction(() => {
      const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
      if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
      const ref = nextReference(db);
      const r = db.prepare(`INSERT INTO projects (reference,title,customer_id,start_date,end_date,notes,status,created_by)
        VALUES (?,?,?,?,?,?,'BROUILLON',?)`)
        .run(ref, p.title + " (copie)", p.customer_id, p.start_date, p.end_date, p.notes, userId || null);
      newId = r.lastInsertRowid;
      const lines = db.prepare("SELECT * FROM project_lines WHERE project_id=? ORDER BY position").all(projectId);
      for (const l of lines) {
        db.prepare(`INSERT INTO project_lines (project_id,position,article_id,supplier_id,description,quantity,unit,
          prix_achat_grande_agence,type_marge_grande_agence,valeur_marge_grande_agence,type_marge_notre_agence,valeur_marge_notre_agence,
          prix_achat_notre_agence,prix_vente_notre_agence,total_ht,montant_tva,total_ttc,vat_rate_id,taux_tva,
          article_designation_snapshot,article_code_snapshot,supplier_name_snapshot,vat_label_snapshot)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(newId, l.position, l.article_id, l.supplier_id, l.description, l.quantity, l.unit,
            l.prix_achat_grande_agence, l.type_marge_grande_agence, l.valeur_marge_grande_agence,
            l.type_marge_notre_agence, l.valeur_marge_notre_agence,
            l.prix_achat_notre_agence, l.prix_vente_notre_agence, l.total_ht, l.montant_tva, l.total_ttc,
            l.vat_rate_id, l.taux_tva, l.article_designation_snapshot, l.article_code_snapshot,
            l.supplier_name_snapshot, l.vat_label_snapshot);
      }
      recalcAndPersistTotals(db, newId);
      audit(db, "project", newId, "DUPLICATED", userId);
    });
    tx();
    return Projects.get(newId);
  },

  delete(projectId) {
    const db = getDb();
    const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
    requireDraft(p);
    db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
    return { ok: true };
  },
};

function audit(db, entity, entityId, action, userId, payload = null) {
  db.prepare("INSERT INTO audit_logs (entity,entity_id,action,user_id,payload) VALUES (?,?,?,?,?)")
    .run(entity, entityId, action, userId || null, payload);
}
