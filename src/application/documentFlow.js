// Application — flux documentaire (§54, §56–§59, §64, §67).
// Opérations métier transactionnelles, idempotentes, traçables (project_id + project_reference).
// Persistance PostgreSQL : requêtes paramétrées $n, RETURNING id, dates TEXT ISO.
import { getDb } from "../infrastructure/db/database.js";
import { assertDocTransition } from "../domain/constants.js";
import { groupProjectLinesBySupplier, buildPurchaseOrderLines, buildSalesInvoiceLines, buildPurchaseInvoiceLines, sumDocLines } from "../domain/documents.js";
import { derivePaymentStatus, remainingAmount } from "../domain/payments.js";

const MAINTENANT = "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')";

export async function nextDocRef(db, prefix, table, column = "reference") {
  const year = new Date().getFullYear();
  const row = await db.get(`SELECT COUNT(*) c FROM ${table} WHERE ${column} LIKE $1`, `${prefix}-${year}-%`);
  return `${prefix}-${year}-${String(row.c + 1).padStart(3, "0")}`;
}

async function audit(db, entity, entityId, action, userId, payload = null) {
  await db.run("INSERT INTO audit_logs (entity,entity_id,action,user_id,payload) VALUES ($1,$2,$3,$4,$5)",
    entity, entityId, action, userId || null, payload);
}

/** Génère les commandes d'achat (1/fournisseur). Idempotent. Doit tourner dans une transaction. */
export async function generatePurchaseOrdersForProject(db, project, lines, userId) {
  const existing = await db.all("SELECT * FROM purchase_orders WHERE project_id=$1", project.id);
  if (existing.length > 0) return existing;
  const groups = groupProjectLinesBySupplier(lines);
  const created = [];
  for (const [supplierId, group] of groups) {
    const sup = await db.get("SELECT name, address FROM suppliers WHERE id=$1", supplierId);
    if (!sup) throw Object.assign(new Error("Fournisseur introuvable pour la commande d'achat"), { status: 400 });
    const built = buildPurchaseOrderLines(group);
    const tot = sumDocLines(built);
    const ref = await nextDocRef(db, "CA", "purchase_orders");
    // Génération métier cohérente → directement VALIDÉE (§1 ext.) : jamais de BROUILLON artificiel.
    const r = await db.run(`INSERT INTO purchase_orders (reference,project_id,project_reference,supplier_id,
      supplier_name_snapshot,supplier_address_snapshot,status,subtotal_ht,total_tva,total_ttc,created_by,validated_by,validated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'VALIDEE',$7,$8,$9,$10,$11,${MAINTENANT}) RETURNING id`,
      ref, project.id, project.reference, supplierId, sup.name, sup.address || null, tot.totalHt, tot.totalTva, tot.totalTtc, userId || null, userId || null);
    const poId = r.lastInsertRowid;
    for (const b of built) {
      await db.run(`INSERT INTO purchase_order_lines (purchase_order_id,project_id,project_line_id,
        article_designation_snapshot,article_code_snapshot,description,quantity,unit,unit_price,taux_tva,
        vat_label_snapshot,total_ht,montant_tva,total_ttc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        poId, project.id, b.projectLineId, b.designation, b.code, b.description, b.quantity, b.unit,
        b.unitPrice, b.tauxTva, b.vatLabel, b.totalHt, b.montantTva, b.totalTtc);
    }
    await audit(db, "purchase_order", poId, "GENERATED", userId, JSON.stringify({ project_id: project.id, reference: ref }));
    created.push(await db.get("SELECT * FROM purchase_orders WHERE id=$1", poId));
  }
  return created;
}

/** Confirmation client (§56) : verrouille la confirmation + génère facture de vente et factures d'achat. Atomique + idempotent. */
export async function confirmProject(projectId, userId, note = null) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const p = await tx.get("SELECT * FROM projects WHERE id=$1", projectId);
    if (!p) throw Object.assign(new Error("Projet introuvable"), { status: 404 });
    if (p.status !== "VALIDE") throw Object.assign(new Error("Seul un devis validé peut être confirmé par le client"), { status: 409 });
    if (p.confirmed_at) return; // idempotent
    await tx.run(`UPDATE projects SET confirmed_by=$1, confirmed_at=${MAINTENANT}, confirmation_note=$2, updated_at=${MAINTENANT} WHERE id=$3`,
      userId || null, note || null, projectId);
    await audit(tx, "project", projectId, "CONFIRMED", userId, note || null);

    const lines = await tx.all("SELECT * FROM project_lines WHERE project_id=$1", projectId);
    // Facture de vente (prix de vente validés)
    if (!await tx.get("SELECT id FROM sales_invoices WHERE project_id=$1", projectId)) {
      const cust = await tx.get("SELECT name, address FROM customers WHERE id=$1", p.customer_id);
      const built = buildSalesInvoiceLines(lines);
      const tot = sumDocLines(built);
      const ref = await nextDocRef(tx, "FV", "sales_invoices");
      const r = await tx.run(`INSERT INTO sales_invoices (reference,project_id,project_reference,customer_id,
        customer_name_snapshot,customer_address_snapshot,status,total_ht,total_tva,total_ttc,created_by,validated_by,validated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'VALIDEE',$7,$8,$9,$10,$11,${MAINTENANT}) RETURNING id`,
        ref, projectId, p.reference, p.customer_id, cust.name, cust.address || null, tot.totalHt, tot.totalTva, tot.totalTtc, userId || null, userId || null);
      for (const b of built) {
        await tx.run(`INSERT INTO sales_invoice_lines (sales_invoice_id,project_id,project_line_id,
          article_designation_snapshot,article_code_snapshot,description,quantity,unit,unit_price,taux_tva,
          cout_achat_snapshot,vat_label_snapshot,total_ht,montant_tva,total_ttc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          r.lastInsertRowid, projectId, b.projectLineId, b.designation, b.code, b.description,
          b.quantity, b.unit, b.unitPrice, b.tauxTva, b.coutAchat, b.vatLabel, b.totalHt, b.montantTva, b.totalTtc);
      }
      await audit(tx, "sales_invoice", r.lastInsertRowid, "GENERATED", userId, JSON.stringify({ project_id: projectId }));
    }
    // Factures d'achat (1 par commande, depuis les lignes de commande)
    const pos = await tx.all("SELECT * FROM purchase_orders WHERE project_id=$1", projectId);
    for (const po of pos) {
      if (await tx.get("SELECT id FROM purchase_invoices WHERE purchase_order_id=$1", po.id)) continue;
      const poLines = await tx.all("SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1", po.id);
      const built = buildPurchaseInvoiceLines(poLines);
      const tot = sumDocLines(built);
      const ref = await nextDocRef(tx, "FA", "purchase_invoices");
      const r = await tx.run(`INSERT INTO purchase_invoices (reference,project_id,project_reference,purchase_order_id,
        purchase_order_reference,supplier_id,supplier_name_snapshot,supplier_address_snapshot,
        status,total_ht,total_tva,total_ttc,created_by,validated_by,validated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'VALIDEE',$9,$10,$11,$12,$13,${MAINTENANT}) RETURNING id`,
        ref, projectId, p.reference, po.id, po.reference, po.supplier_id, po.supplier_name_snapshot,
        po.supplier_address_snapshot, tot.totalHt, tot.totalTva, tot.totalTtc, userId || null, userId || null);
      for (const b of built) {
        await tx.run(`INSERT INTO purchase_invoice_lines (purchase_invoice_id,purchase_order_line_id,project_id,
          project_line_id,article_designation_snapshot,article_code_snapshot,description,quantity,unit,unit_price,
          taux_tva,vat_label_snapshot,total_ht,montant_tva,total_ttc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          r.lastInsertRowid, b.purchaseOrderLineId, projectId, b.projectLineId, b.designation,
          b.code, b.description, b.quantity, b.unit, b.unitPrice, b.tauxTva, b.vatLabel, b.totalHt, b.montantTva, b.totalTtc);
      }
      await audit(tx, "purchase_invoice", r.lastInsertRowid, "GENERATED", userId, JSON.stringify({ purchase_order_id: po.id }));
    }
  });
}

const DOC_CONF = {
  po: { table: "purchase_orders", linesTable: "purchase_order_lines", linesKey: "purchase_order_id", entity: "purchase_order", kind: "PO", label: "Commande d'achat" },
  si: { table: "sales_invoices", linesTable: "sales_invoice_lines", linesKey: "sales_invoice_id", entity: "sales_invoice", kind: "INV", label: "Facture de vente" },
  pi: { table: "purchase_invoices", linesTable: "purchase_invoice_lines", linesKey: "purchase_invoice_id", entity: "purchase_invoice", kind: "INV", label: "Facture d'achat" },
};

export async function getDoc(kind, id) {
  const c = DOC_CONF[kind];
  const db = getDb();
  const d = await db.get(`SELECT * FROM ${c.table} WHERE id=$1`, id);
  if (!d) return null;
  d.lines = await db.all(`SELECT * FROM ${c.linesTable} WHERE ${c.linesKey}=$1 ORDER BY id`, id);
  // Soldes dérivés des mouvements réels (§11, §22-23) : jamais un champ manuel.
  if (kind === "si") {
    const recu = (await db.get("SELECT COALESCE(SUM(amount_ttc),0) s FROM received_transactions WHERE sales_invoice_id=$1", id)).s;
    d.finance = { totalRegle: recu, reste: remainingAmount(d.total_ttc, recu), statut: derivePaymentStatus(d.total_ttc, recu) };
  } else if (kind === "pi") {
    const paye = (await db.get("SELECT COALESCE(SUM(amount_ttc),0) s FROM supplier_payments WHERE purchase_invoice_id=$1", id)).s;
    d.finance = { totalRegle: paye, reste: remainingAmount(d.total_ttc, paye), statut: derivePaymentStatus(d.total_ttc, paye) };
  }
  return d;
}

export async function listDocs(kind, { search = "", status = "", page = 1, pageSize = 15 } = {}) {
  const c = DOC_CONF[kind];
  const db = getDb();
  const where = [], params = [];
  if (status) { where.push(`d.status=$${params.length + 1}`); params.push(status); }
  if (search) {
    where.push(`(d.reference LIKE $${params.length + 1} OR d.project_reference LIKE $${params.length + 2})`);
    params.push(`%${search}%`, `%${search}%`);
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (await db.get(`SELECT COUNT(*) c FROM ${c.table} d ${w}`, ...params)).c;
  const rows = await db.all(`SELECT d.* FROM ${c.table} d ${w} ORDER BY d.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    ...params, pageSize, (page - 1) * pageSize);
  return { rows, total, page, pageSize };
}

/** Changement de statut documentaire (§59) : transition explicite + audit. */
export async function transitionDoc(kind, id, to, userId) {
  const c = DOC_CONF[kind];
  const db = getDb();
  await db.transaction(async (tx) => {
    const d = await tx.get(`SELECT * FROM ${c.table} WHERE id=$1`, id);
    if (!d) throw Object.assign(new Error(`${c.label} introuvable`), { status: 404 });
    assertDocTransition(c.kind, d.status, to);
    if (to === "VALIDEE") {
      await tx.run(`UPDATE ${c.table} SET status=$1, updated_at=${MAINTENANT}, validated_by=$2, validated_at=${MAINTENANT} WHERE id=$3`, to, userId || null, id);
    } else if (to === "CLOTUREE") {
      await tx.run(`UPDATE ${c.table} SET status=$1, updated_at=${MAINTENANT}, closed_at=${MAINTENANT} WHERE id=$2`, to, id);
    } else {
      await tx.run(`UPDATE ${c.table} SET status=$1, updated_at=${MAINTENANT} WHERE id=$2`, to, id);
    }
    await audit(tx, c.entity, id, to, userId);
  });
  return getDoc(kind, id);
}

/** Suppression : uniquement un document en brouillon, jamais un document validé (§67). */
export async function deleteDoc(kind, id) {
  const c = DOC_CONF[kind];
  const db = getDb();
  const d = await db.get(`SELECT * FROM ${c.table} WHERE id=$1`, id);
  if (!d) throw Object.assign(new Error(`${c.label} introuvable`), { status: 404 });
  if (d.status !== "BROUILLON") throw Object.assign(new Error("Un document validé ne peut pas être supprimé"), { status: 409, code: "FROZEN" });
  await db.run(`DELETE FROM ${c.table} WHERE id=$1`, id);
  return { ok: true };
}

/** Traçabilité visuelle (§66) : toutes les pièces liées au projet, dans les deux sens. */
export async function getLinkedDocuments(projectId) {
  const db = getDb();
  return {
    purchaseOrders: await db.all("SELECT id, reference, supplier_name_snapshot, status, total_ttc FROM purchase_orders WHERE project_id=$1 ORDER BY reference", projectId),
    salesInvoice: await db.get("SELECT id, reference, status, total_ttc FROM sales_invoices WHERE project_id=$1", projectId) || null,
    purchaseInvoices: await db.all("SELECT id, reference, supplier_name_snapshot, status, total_ttc, purchase_order_reference FROM purchase_invoices WHERE project_id=$1 ORDER BY reference", projectId),
  };
}
