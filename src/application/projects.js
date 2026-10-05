// Couche application — cas d'utilisation projet (§29, §46).
// Orchestration + transactions. Règles métier dans src/domain/.
// Persistance PostgreSQL : requêtes paramétrées $n, RETURNING id, dates TEXT ISO.
import { getDb } from "../infrastructure/db/database.js";
import { PROJECT_STATUS, assertTransitionProject } from "../domain/constants.js";
import { calculateLinePricing, calculateLineTotals } from "../domain/pricing.js";
import { calculateProjectTotals } from "../domain/totals.js";
import { validateProjectHeader, validateProjectLineInput, validateProjectForValidation } from "../domain/validation.js";
import { assertQuantity, assertMoney } from "../domain/money.js";
import { generatePurchaseOrdersForProject, nextDocRef } from "./documentFlow.js";

const MAINTENANT = "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')";

async function nextReference(db) {
  const year = new Date().getFullYear();
  const row = await db.get("SELECT COUNT(*) c FROM projects WHERE reference LIKE $1", `P-${year}-%`);
  return `P-${year}-${String(row.c + 1).padStart(4, "0")}`;
}

async function enrichLineForValidation(db, l) {
  const art = await db.get("SELECT is_active FROM articles WHERE id=$1", l.article_id);
  const sup = await db.get("SELECT is_active FROM suppliers WHERE id=$1", l.supplier_id);
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

async function recalcAndPersistTotals(db, projectId) {
  const rows = await db.all("SELECT * FROM project_lines WHERE project_id=$1", projectId);
  const totals = calculateProjectTotals(rows.map((r) => ({
    prixAchatGrandeAgence: r.prix_achat_grande_agence,
    typeMargeGrandeAgence: r.type_marge_grande_agence,
    valeurMargeGrandeAgence: r.valeur_marge_grande_agence,
    typeMargeNotreAgence: r.type_marge_notre_agence,
    valeurMargeNotreAgence: r.valeur_marge_notre_agence,
    quantite: r.quantity, tauxTva: r.taux_tva,
  })));
  await db.run(`UPDATE projects SET total_cout_grande_agence=$1, total_marge_grande_agence=$2, total_achat_notre_agence=$3,
    total_marge_notre_agence=$4, total_ht=$5, total_tva=$6, total_ttc=$7, updated_at=${MAINTENANT} WHERE id=$8`,
    totals.coutGrandeAgence, totals.margeGrandeAgence, totals.achatNotreAgence,
    totals.margeNotreAgence, totals.prixVenteHt, totals.tva, totals.totalTtc, projectId);
  return totals;
}

function requireDraft(project) {
  if (!project) throw Object.assign(new Error("Projet introuvable"), { code: "NOT_FOUND", status: 404 });
  if (project.status !== PROJECT_STATUS.BROUILLON)
    throw Object.assign(new Error("Un projet validé ou annulé ne peut pas être modifié"), { code: "FROZEN", status: 409 });
}

export const Projects = {
  async create({ titre, clientId, dateDebut, dateFin, notes }, userId) {
    const db = getDb();
    const errs = validateProjectHeader({ reference: "x", titre, clientId, dateDebut, dateFin, statut: "BROUILLON" });
    if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
    const ref = await nextReference(db);
    const r = await db.run(`INSERT INTO projects (reference,title,customer_id,start_date,end_date,notes,status,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,'BROUILLON',$7) RETURNING id`, ref, titre.trim(), clientId, dateDebut || null, dateFin || null, notes || null, userId || null);
    await audit(db, "project", r.lastInsertRowid, "CREATED", userId);
    return Projects.get(r.lastInsertRowid);
  },

  async get(id) {
    const db = getDb();
    const p = await db.get(`SELECT p.*, c.name customer_name FROM projects p JOIN customers c ON c.id=p.customer_id WHERE p.id=$1`, id);
    if (!p) return null;
    p.lines = await db.all(`SELECT l.*, a.designation article_designation, a.code article_code, s.name supplier_name,
      v.label vat_label FROM project_lines l
      LEFT JOIN articles a ON a.id=l.article_id LEFT JOIN suppliers s ON s.id=l.supplier_id
      LEFT JOIN vat_rates v ON v.id=l.vat_rate_id
      WHERE l.project_id=$1 ORDER BY l.position, l.id`, id);
    return p;
  },

  async list({ search = "", status = "", page = 1, pageSize = 20, sort = "updated_at", dir = "DESC" } = {}) {
    const db = getDb();
    const where = [];
    const params = [];
    if (status) { where.push(`p.status=$${params.length + 1}`); params.push(status); }
    if (search) {
      where.push(`(p.reference LIKE $${params.length + 1} OR p.title LIKE $${params.length + 2} OR c.name LIKE $${params.length + 3})`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const allowed = ["reference", "title", "start_date", "total_ttc", "updated_at", "status"];
    if (!allowed.includes(sort)) sort = "updated_at";
    dir = dir === "ASC" ? "ASC" : "DESC";
    const total = (await db.get(`SELECT COUNT(*) c FROM projects p JOIN customers c ON c.id=p.customer_id ${w}`, ...params)).c;
    const rows = await db.all(`SELECT p.*, c.name customer_name FROM projects p JOIN customers c ON c.id=p.customer_id
      ${w} ORDER BY p.${sort} ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, ...params, pageSize, (page - 1) * pageSize);
    return { rows, total, page, pageSize };
  },

  async updateHeader(id, patch, userId) {
    const db = getDb();
    await db.transaction(async (tx) => {
      const p = await tx.get("SELECT * FROM projects WHERE id=$1", id);
      requireDraft(p);
      const next = { ...p, title: patch.titre ?? p.title, customer_id: patch.clientId ?? p.customer_id,
        start_date: patch.dateDebut ?? p.start_date, end_date: patch.dateFin ?? p.end_date, notes: patch.notes ?? p.notes };
      const errs = validateProjectHeader({ reference: p.reference, titre: next.title, clientId: next.customer_id,
        dateDebut: next.start_date, dateFin: next.end_date, statut: p.status });
      if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
      await tx.run(`UPDATE projects SET title=$1, customer_id=$2, start_date=$3, end_date=$4, notes=$5, updated_at=${MAINTENANT} WHERE id=$6`,
        next.title, next.customer_id, next.start_date, next.end_date, next.notes, id);
      await audit(tx, "project", id, "UPDATED", userId);
    });
    return Projects.get(id);
  },

  async addLine(projectId, body, userId) {
    const db = getDb();
    const input = normLineInput(body);
    const errs = validateProjectLineInput(input);
    if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
    assertQuantity(input.quantite); assertMoney(input.prixAchatGrandeAgence, "Prix d'achat Vos Voyage");
    await db.transaction(async (tx) => {
      const p = await tx.get("SELECT * FROM projects WHERE id=$1", projectId);
      requireDraft(p);
      const art = await tx.get("SELECT * FROM articles WHERE id=$1", input.articleId);
      const sup = await tx.get("SELECT * FROM suppliers WHERE id=$1", input.fournisseurId);
      if (!art) throw Object.assign(new Error("Article introuvable"), { status: 400 });
      if (!sup) throw Object.assign(new Error("Fournisseur introuvable"), { status: 400 });
      const { pricing, totals } = computeLine({ ...input, quantity: input.quantite, taux_tva: input.tauxTva });
      const vatRow = input.vatRateId ? await tx.get("SELECT label FROM vat_rates WHERE id=$1", input.vatRateId) : null;
      const vatLabel = vatRow?.label || null;
      const pos = (await tx.get("SELECT COALESCE(MAX(position),0)+1 m FROM project_lines WHERE project_id=$1", projectId)).m;
      await tx.run(`INSERT INTO project_lines (project_id,position,article_id,supplier_id,description,quantity,unit,
        prix_achat_grande_agence,type_marge_grande_agence,valeur_marge_grande_agence,type_marge_notre_agence,valeur_marge_notre_agence,
        prix_achat_notre_agence,prix_vente_notre_agence,total_ht,montant_tva,total_ttc,vat_rate_id,taux_tva,
        article_designation_snapshot,article_code_snapshot,supplier_name_snapshot,vat_label_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        projectId, pos, input.articleId, input.fournisseurId, input.description, input.quantite, input.unit,
        input.prixAchatGrandeAgence, input.typeMargeGrandeAgence, input.valeurMargeGrandeAgence,
        input.typeMargeNotreAgence, input.valeurMargeNotreAgence,
        pricing.prixAchatNotreAgence, pricing.prixVenteNotreAgence, totals.totalHt, totals.montantTva, totals.totalTtc,
        input.vatRateId, input.tauxTva, art.designation, art.code, sup.name, vatLabel);
      await recalcAndPersistTotals(tx, projectId);
      await audit(tx, "project", projectId, "LINE_ADDED", userId);
    });
    return Projects.get(projectId);
  },

  async updateLine(projectId, lineId, body, userId) {
    const db = getDb();
    const input = normLineInput(body);
    const errs = validateProjectLineInput(input);
    if (errs.length) throw Object.assign(new Error(errs.join(" ; ")), { status: 400, code: "VALIDATION" });
    await db.transaction(async (tx) => {
      const p = await tx.get("SELECT * FROM projects WHERE id=$1", projectId);
      requireDraft(p);
      const ex = await tx.get("SELECT * FROM project_lines WHERE id=$1 AND project_id=$2", lineId, projectId);
      if (!ex) throw Object.assign(new Error("Prestation introuvable"), { status: 404 });
      const { pricing, totals } = computeLine({ ...input, quantity: input.quantite, taux_tva: input.tauxTva });
      const art = await tx.get("SELECT * FROM articles WHERE id=$1", input.articleId);
      const sup = await tx.get("SELECT * FROM suppliers WHERE id=$1", input.fournisseurId);
      const vatRow = input.vatRateId ? await tx.get("SELECT label FROM vat_rates WHERE id=$1", input.vatRateId) : null;
      const vatLabel = vatRow?.label || null;
      await tx.run(`UPDATE project_lines SET article_id=$1,supplier_id=$2,description=$3,quantity=$4,unit=$5,
        prix_achat_grande_agence=$6,type_marge_grande_agence=$7,valeur_marge_grande_agence=$8,type_marge_notre_agence=$9,valeur_marge_notre_agence=$10,
        prix_achat_notre_agence=$11,prix_vente_notre_agence=$12,total_ht=$13,montant_tva=$14,total_ttc=$15,
        vat_rate_id=$16,taux_tva=$17,article_designation_snapshot=$18,article_code_snapshot=$19,supplier_name_snapshot=$20,vat_label_snapshot=$21,
        updated_at=${MAINTENANT} WHERE id=$22`,
        input.articleId, input.fournisseurId, input.description, input.quantite, input.unit,
        input.prixAchatGrandeAgence, input.typeMargeGrandeAgence, input.valeurMargeGrandeAgence,
        input.typeMargeNotreAgence, input.valeurMargeNotreAgence,
        pricing.prixAchatNotreAgence, pricing.prixVenteNotreAgence, totals.totalHt, totals.montantTva, totals.totalTtc,
        input.vatRateId, input.tauxTva, art.designation, art.code, sup.name, vatLabel, lineId);
      await recalcAndPersistTotals(tx, projectId);
      await audit(tx, "project", projectId, "LINE_UPDATED", userId);
    });
    return Projects.get(projectId);
  },

  async removeLine(projectId, lineId, userId) {
    const db = getDb();
    await db.transaction(async (tx) => {
      const p = await tx.get("SELECT * FROM projects WHERE id=$1", projectId);
      requireDraft(p);
      await tx.run("DELETE FROM project_lines WHERE id=$1 AND project_id=$2", lineId, projectId);
      await recalcAndPersistTotals(tx, projectId);
      await audit(tx, "project", projectId, "LINE_REMOVED", userId);
    });
    return Projects.get(projectId);
  },

  // Opération métier : validation (§25, §28, §46) — atomique.
  async validate(projectId, userId) {
    const db = getDb();
    await db.transaction(async (tx) => {
      const p = await tx.get("SELECT * FROM projects WHERE id=$1", projectId);
      if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
      assertTransitionProject(p.status, PROJECT_STATUS.VALIDE);
      const lines = await tx.all("SELECT * FROM project_lines WHERE project_id=$1", projectId);
      const enriched = await Promise.all(lines.map((l) => enrichLineForValidation(tx, l)));
      const errs = validateProjectForValidation(
        { reference: p.reference, titre: p.title, clientId: p.customer_id, dateDebut: p.start_date, dateFin: p.end_date, statut: p.status },
        enriched
      );
      if (errs.length) throw Object.assign(new Error("Validation impossible : " + errs.join(" ; ")), { status: 400, code: "VALIDATION" });
      // Recalcul autoritatif backend (§21) + snapshots historiques (§24)
      const cust = await tx.get("SELECT name FROM customers WHERE id=$1", p.customer_id);
      for (const l of lines) {
        const { pricing, totals } = computeLine({
          prixAchatGrandeAgence: l.prix_achat_grande_agence, typeMargeGrandeAgence: l.type_marge_grande_agence,
          valeurMargeGrandeAgence: l.valeur_marge_grande_agence, typeMargeNotreAgence: l.type_marge_notre_agence,
          valeurMargeNotreAgence: l.valeur_marge_notre_agence, quantity: l.quantity, taux_tva: l.taux_tva,
        });
        const art = await tx.get("SELECT designation,code FROM articles WHERE id=$1", l.article_id);
        const sup = await tx.get("SELECT name FROM suppliers WHERE id=$1", l.supplier_id);
        await tx.run(`UPDATE project_lines SET prix_achat_notre_agence=$1,prix_vente_notre_agence=$2,total_ht=$3,montant_tva=$4,total_ttc=$5,
          article_designation_snapshot=$6,article_code_snapshot=$7,supplier_name_snapshot=$8 WHERE id=$9`,
          pricing.prixAchatNotreAgence, pricing.prixVenteNotreAgence, totals.totalHt, totals.montantTva, totals.totalTtc,
          art.designation, art.code, sup.name, l.id);
      }
      const totals = await recalcAndPersistTotals(tx, projectId);
      const quoteRef = p.quote_reference || await nextDocRef(tx, "DEV", "projects", "quote_reference");
      await tx.run(`UPDATE projects SET status='VALIDE', customer_name_snapshot=$1, validated_by=$2, validated_at=${MAINTENANT}, quote_reference=$3, updated_at=${MAINTENANT} WHERE id=$4`,
        cust.name, userId || null, quoteRef, projectId);
      await audit(tx, "project", projectId, "VALIDATED", userId, JSON.stringify(totals));
      // Génération automatique des commandes d'achat (1/fournisseur, PA Vos Voyage),
      // dans la MÊME transaction : tout ou rien (§54).
      await generatePurchaseOrdersForProject(tx, { id: projectId, reference: p.reference }, lines, userId);
    });
    return Projects.get(projectId);
  },

  async cancel(projectId, userId) {
    const db = getDb();
    await db.transaction(async (tx) => {
      const p = await tx.get("SELECT * FROM projects WHERE id=$1", projectId);
      if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
      assertTransitionProject(p.status, PROJECT_STATUS.ANNULE);
      await tx.run(`UPDATE projects SET status='ANNULE', cancelled_by=$1, cancelled_at=${MAINTENANT}, updated_at=${MAINTENANT} WHERE id=$2`,
        userId || null, projectId);
      await audit(tx, "project", projectId, "CANCELLED", userId);
    });
    return Projects.get(projectId);
  },

  async duplicate(projectId, userId) {
    const db = getDb();
    let newId;
    await db.transaction(async (tx) => {
      const p = await tx.get("SELECT * FROM projects WHERE id=$1", projectId);
      if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
      const ref = await nextReference(tx);
      const r = await tx.run(`INSERT INTO projects (reference,title,customer_id,start_date,end_date,notes,status,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'BROUILLON',$7) RETURNING id`,
        ref, p.title + " (copie)", p.customer_id, p.start_date, p.end_date, p.notes, userId || null);
      newId = r.lastInsertRowid;
      const lines = await tx.all("SELECT * FROM project_lines WHERE project_id=$1 ORDER BY position", projectId);
      for (const l of lines) {
        await tx.run(`INSERT INTO project_lines (project_id,position,article_id,supplier_id,description,quantity,unit,
          prix_achat_grande_agence,type_marge_grande_agence,valeur_marge_grande_agence,type_marge_notre_agence,valeur_marge_notre_agence,
          prix_achat_notre_agence,prix_vente_notre_agence,total_ht,montant_tva,total_ttc,vat_rate_id,taux_tva,
          article_designation_snapshot,article_code_snapshot,supplier_name_snapshot,vat_label_snapshot)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          newId, l.position, l.article_id, l.supplier_id, l.description, l.quantity, l.unit,
          l.prix_achat_grande_agence, l.type_marge_grande_agence, l.valeur_marge_grande_agence,
          l.type_marge_notre_agence, l.valeur_marge_notre_agence,
          l.prix_achat_notre_agence, l.prix_vente_notre_agence, l.total_ht, l.montant_tva, l.total_ttc,
          l.vat_rate_id, l.taux_tva, l.article_designation_snapshot, l.article_code_snapshot,
          l.supplier_name_snapshot, l.vat_label_snapshot);
      }
      await recalcAndPersistTotals(tx, newId);
      await audit(tx, "project", newId, "DUPLICATED", userId);
    });
    return Projects.get(newId);
  },

  async delete(projectId) {
    const db = getDb();
    const p = await db.get("SELECT * FROM projects WHERE id=$1", projectId);
    requireDraft(p);
    await db.run("DELETE FROM projects WHERE id=$1", projectId);
    return { ok: true };
  },
};

async function audit(db, entity, entityId, action, userId, payload = null) {
  await db.run("INSERT INTO audit_logs (entity,entity_id,action,user_id,payload) VALUES ($1,$2,$3,$4,$5)",
    entity, entityId, action, userId || null, payload);
}
