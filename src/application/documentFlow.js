// Application — flux documentaire (§54, §56–§59, §64, §67).
// Opérations métier transactionnelles, idempotentes, traçables (project_id + project_reference).
import { getDb } from "../infrastructure/db/database.js";
import { assertDocTransition } from "../domain/constants.js";
import { groupProjectLinesBySupplier, buildPurchaseOrderLines, buildSalesInvoiceLines, buildPurchaseInvoiceLines, sumDocLines } from "../domain/documents.js";
import { derivePaymentStatus, remainingAmount } from "../domain/payments.js";

export function nextDocRef(db, prefix, table, column = "reference") {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${column} LIKE ?`).get(`${prefix}-${year}-%`);
  return `${prefix}-${year}-${String(row.c + 1).padStart(3, "0")}`;
}

function audit(db, entity, entityId, action, userId, payload = null) {
  db.prepare("INSERT INTO audit_logs (entity,entity_id,action,user_id,payload) VALUES (?,?,?,?,?)")
    .run(entity, entityId, action, userId || null, payload);
}

/** Génère les commandes d'achat (1/fournisseur). Idempotent. Doit tourner dans une transaction. */
export function generatePurchaseOrdersForProject(db, project, lines, userId) {
  const existing = db.prepare("SELECT * FROM purchase_orders WHERE project_id=?").all(project.id);
  if (existing.length > 0) return existing;
  const groups = groupProjectLinesBySupplier(lines);
  const created = [];
  for (const [supplierId, group] of groups) {
    const sup = db.prepare("SELECT name, address FROM suppliers WHERE id=?").get(supplierId);
    if (!sup) throw Object.assign(new Error("Fournisseur introuvable pour la commande d'achat"), { status: 400 });
    const built = buildPurchaseOrderLines(group);
    const tot = sumDocLines(built);
    const ref = nextDocRef(db, "CA", "purchase_orders");
    // Génération métier cohérente → directement VALIDÉE (§1 ext.) : jamais de BROUILLON artificiel.
    const r = db.prepare(`INSERT INTO purchase_orders (reference,project_id,project_reference,supplier_id,
      supplier_name_snapshot,supplier_address_snapshot,status,subtotal_ht,total_tva,total_ttc,created_by,validated_by,validated_at)
      VALUES (?,?,?,?,?,?,'VALIDEE',?,?,?,?,?,datetime('now'))`)
      .run(ref, project.id, project.reference, supplierId, sup.name, sup.address || null, tot.totalHt, tot.totalTva, tot.totalTtc, userId || null, userId || null);
    const poId = r.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO purchase_order_lines (purchase_order_id,project_id,project_line_id,
      article_designation_snapshot,article_code_snapshot,description,quantity,unit,unit_price,taux_tva,
      vat_label_snapshot,total_ht,montant_tva,total_ttc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const b of built) {
      ins.run(poId, project.id, b.projectLineId, b.designation, b.code, b.description, b.quantity, b.unit,
        b.unitPrice, b.tauxTva, b.vatLabel, b.totalHt, b.montantTva, b.totalTtc);
    }
    audit(db, "purchase_order", poId, "GENERATED", userId, JSON.stringify({ project_id: project.id, reference: ref }));
    created.push(db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(poId));
  }
  return created;
}

/** Confirmation client (§56) : verrouille la confirmation + génère facture de vente et factures d'achat. Atomique + idempotent. */
export function confirmProject(projectId, userId, note = null) {
  const db = getDb();
  const tx = db.transaction(() => {
    const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
    if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
    if (p.status !== "VALIDE") throw Object.assign(new Error("Seul un devis validé peut être confirmé par le client"), { status: 409 });
    if (p.confirmed_at) return; // idempotent
    db.prepare("UPDATE projects SET confirmed_by=?, confirmed_at=datetime('now'), confirmation_note=?, updated_at=datetime('now') WHERE id=?")
      .run(userId || null, note || null, projectId);
    audit(db, "project", projectId, "CONFIRMED", userId, note || null);

    const lines = db.prepare("SELECT * FROM project_lines WHERE project_id=?").all(projectId);
    // Facture de vente (prix de vente validés)
    if (!db.prepare("SELECT id FROM sales_invoices WHERE project_id=?").get(projectId)) {
      const cust = db.prepare("SELECT name, address FROM customers WHERE id=?").get(p.customer_id);
      const built = buildSalesInvoiceLines(lines);
      const tot = sumDocLines(built);
      const ref = nextDocRef(db, "FV", "sales_invoices");
      const r = db.prepare(`INSERT INTO sales_invoices (reference,project_id,project_reference,customer_id,
        customer_name_snapshot,customer_address_snapshot,status,total_ht,total_tva,total_ttc,created_by,validated_by,validated_at)
        VALUES (?,?,?,?,?,?,'VALIDEE',?,?,?,?,?,datetime('now'))`)
        .run(ref, projectId, p.reference, p.customer_id, cust.name, cust.address || null, tot.totalHt, tot.totalTva, tot.totalTtc, userId || null, userId || null);
      const ins = db.prepare(`INSERT INTO sales_invoice_lines (sales_invoice_id,project_id,project_line_id,
        article_designation_snapshot,article_code_snapshot,description,quantity,unit,unit_price,taux_tva,
        cout_achat_snapshot,vat_label_snapshot,total_ht,montant_tva,total_ttc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const b of built) ins.run(r.lastInsertRowid, projectId, b.projectLineId, b.designation, b.code, b.description,
        b.quantity, b.unit, b.unitPrice, b.tauxTva, b.coutAchat, b.vatLabel, b.totalHt, b.montantTva, b.totalTtc);
      audit(db, "sales_invoice", r.lastInsertRowid, "GENERATED", userId, JSON.stringify({ project_id: projectId }));
    }
    // Factures d'achat (1 par commande, depuis les lignes de commande)
    const pos = db.prepare("SELECT * FROM purchase_orders WHERE project_id=?").all(projectId);
    for (const po of pos) {
      if (db.prepare("SELECT id FROM purchase_invoices WHERE purchase_order_id=?").get(po.id)) continue;
      const poLines = db.prepare("SELECT * FROM purchase_order_lines WHERE purchase_order_id=?").all(po.id);
      const built = buildPurchaseInvoiceLines(poLines);
      const tot = sumDocLines(built);
      const ref = nextDocRef(db, "FA", "purchase_invoices");
      const r = db.prepare(`INSERT INTO purchase_invoices (reference,project_id,project_reference,purchase_order_id,
        purchase_order_reference,supplier_id,supplier_name_snapshot,supplier_address_snapshot,
        status,total_ht,total_tva,total_ttc,created_by,validated_by,validated_at)
        VALUES (?,?,?,?,?,?,?,?,'VALIDEE',?,?,?,?,?,datetime('now'))`)
        .run(ref, projectId, p.reference, po.id, po.reference, po.supplier_id, po.supplier_name_snapshot,
          po.supplier_address_snapshot, tot.totalHt, tot.totalTva, tot.totalTtc, userId || null, userId || null);
      const ins = db.prepare(`INSERT INTO purchase_invoice_lines (purchase_invoice_id,purchase_order_line_id,project_id,
        project_line_id,article_designation_snapshot,article_code_snapshot,description,quantity,unit,unit_price,
        taux_tva,vat_label_snapshot,total_ht,montant_tva,total_ttc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const b of built) ins.run(r.lastInsertRowid, b.purchaseOrderLineId, projectId, b.projectLineId, b.designation,
        b.code, b.description, b.quantity, b.unit, b.unitPrice, b.tauxTva, b.vatLabel, b.totalHt, b.montantTva, b.totalTtc);
      audit(db, "purchase_invoice", r.lastInsertRowid, "GENERATED", userId, JSON.stringify({ purchase_order_id: po.id }));
    }
  });
  tx();
}

const DOC_CONF = {
  po: { table: "purchase_orders", linesTable: "purchase_order_lines", linesKey: "purchase_order_id", entity: "purchase_order", kind: "PO", label: "Commande d'achat" },
  si: { table: "sales_invoices", linesTable: "sales_invoice_lines", linesKey: "sales_invoice_id", entity: "sales_invoice", kind: "INV", label: "Facture de vente" },
  pi: { table: "purchase_invoices", linesTable: "purchase_invoice_lines", linesKey: "purchase_invoice_id", entity: "purchase_invoice", kind: "INV", label: "Facture d'achat" },
};

export function getDoc(kind, id) {
  const c = DOC_CONF[kind];
  const db = getDb();
  const d = db.prepare(`SELECT * FROM ${c.table} WHERE id=?`).get(id);
  if (!d) return null;
  d.lines = db.prepare(`SELECT * FROM ${c.linesTable} WHERE ${c.linesKey}=? ORDER BY id`).all(id);
  // Soldes dérivés des mouvements réels (§11, §22-23) : jamais un champ manuel.
  if (kind === "si") {
    const recu = db.prepare("SELECT COALESCE(SUM(amount_ttc),0) s FROM received_transactions WHERE sales_invoice_id=?").get(id).s;
    d.finance = { totalRegle: recu, reste: remainingAmount(d.total_ttc, recu), statut: derivePaymentStatus(d.total_ttc, recu) };
  } else if (kind === "pi") {
    const paye = db.prepare("SELECT COALESCE(SUM(amount_ttc),0) s FROM supplier_payments WHERE purchase_invoice_id=?").get(id).s;
    d.finance = { totalRegle: paye, reste: remainingAmount(d.total_ttc, paye), statut: derivePaymentStatus(d.total_ttc, paye) };
  }
  return d;
}

export function listDocs(kind, { search = "", status = "", page = 1, pageSize = 15 } = {}) {
  const c = DOC_CONF[kind];
  const db = getDb();
  const where = [], params = [];
  if (status) { where.push("d.status=?"); params.push(status); }
  if (search) { where.push("(d.reference LIKE ? OR d.project_reference LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) c FROM ${c.table} d ${w}`).get(...params).c;
  const rows = db.prepare(`SELECT d.* FROM ${c.table} d ${w} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { rows, total, page, pageSize };
}

/** Changement de statut documentaire (§59) : transition explicite + audit. */
export function transitionDoc(kind, id, to, userId) {
  const c = DOC_CONF[kind];
  const db = getDb();
  const tx = db.transaction(() => {
    const d = db.prepare(`SELECT * FROM ${c.table} WHERE id=?`).get(id);
    if (!d) throw Object.assign(new Error(`${c.label} introuvable`), { status: 404 });
    assertDocTransition(c.kind, d.status, to);
    const extra = to === "VALIDEE" ? ", validated_by=?, validated_at=datetime('now')" : to === "CLOTUREE" ? ", closed_at=datetime('now')" : "";
    const params = to === "VALIDEE" ? [userId || null, id] : [id];
    db.prepare(`UPDATE ${c.table} SET status=?, updated_at=datetime('now')${extra} WHERE id=?`).run(to, ...params);
    audit(db, c.entity, id, to, userId);
  });
  tx();
  return getDoc(kind, id);
}

/** Suppression : uniquement un document en brouillon, jamais un document validé (§67). */
export function deleteDoc(kind, id) {
  const c = DOC_CONF[kind];
  const db = getDb();
  const d = db.prepare(`SELECT * FROM ${c.table} WHERE id=?`).get(id);
  if (!d) throw Object.assign(new Error(`${c.label} introuvable`), { status: 404 });
  if (d.status !== "BROUILLON") throw Object.assign(new Error("Un document validé ne peut pas être supprimé"), { status: 409, code: "FROZEN" });
  db.prepare(`DELETE FROM ${c.table} WHERE id=?`).run(id);
  return { ok: true };
}

/** Traçabilité visuelle (§66) : toutes les pièces liées au projet, dans les deux sens. */
export function getLinkedDocuments(projectId) {
  const db = getDb();
  return {
    purchaseOrders: db.prepare("SELECT id, reference, supplier_name_snapshot, status, total_ttc FROM purchase_orders WHERE project_id=? ORDER BY reference").all(projectId),
    salesInvoice: db.prepare("SELECT id, reference, status, total_ttc FROM sales_invoices WHERE project_id=?").get(projectId) || null,
    purchaseInvoices: db.prepare("SELECT id, reference, supplier_name_snapshot, status, total_ttc, purchase_order_reference FROM purchase_invoices WHERE project_id=? ORDER BY reference").all(projectId),
  };
}
