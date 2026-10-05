// Application — finance encaissements & paiements (§3-§17).
// Backend autoritatif (§16) : recalcule HT/TVA/TTC, contrôle le restant, journalise.
// Persistance PostgreSQL : requêtes paramétrées $n, RETURNING id.
import { getDb } from "../infrastructure/db/database.js";
import { calculateTransactionAmounts, assertWithinRemaining, derivePaymentStatus, remainingAmount } from "../domain/payments.js";
import { calculateInvoiceLineMargin } from "../domain/documents.js";
import { roundMoney } from "../domain/money.js";

async function nextTxRef(db, prefix, table) {
  const year = new Date().getFullYear();
  const row = await db.get(`SELECT COUNT(*) c FROM ${table} WHERE reference LIKE $1`, `${prefix}-${year}-%`);
  return `${prefix}-${year}-${String(row.c + 1).padStart(3, "0")}`;
}

async function audit(db, entity, entityId, action, userId, payload = null) {
  await db.run("INSERT INTO audit_logs (entity,entity_id,action,user_id,payload) VALUES ($1,$2,$3,$4,$5)",
    entity, entityId, action, userId || null, payload);
}

async function resolveType(db, typeId) {
  const t = await db.get("SELECT * FROM transaction_types WHERE id=$1 AND is_active=1", typeId);
  if (!t) throw Object.assign(new Error("Type de transaction invalide"), { status: 400, code: "INVALID_TX_TYPE" });
  return t;
}

async function resolveTaux(db, vatRateId, tauxTva) {
  if (vatRateId) {
    const v = await db.get("SELECT * FROM vat_rates WHERE id=$1", vatRateId);
    if (!v) throw Object.assign(new Error("Taux de TVA invalide"), { status: 400 });
    return { taux: v.rate, label: v.label, id: v.id };
  }
  const t = Number(tauxTva);
  if (!Number.isFinite(t) || t < 0 || t > 100) throw Object.assign(new Error("Taux de TVA invalide"), { status: 400 });
  return { taux: t, label: `TVA ${t} %`, id: null };
}

export const Encaissements = {
  async create({ dateTransaction, montantHt, vatRateId, tauxTva, typeId, factureVenteId = null, notes = null }, userId) {
    const db = getDb();
    let newId;
    await db.transaction(async (tx) => {
      await resolveType(tx, typeId);
      const { taux, label, id } = await resolveTaux(tx, vatRateId, tauxTva);
      const m = calculateTransactionAmounts(Number(montantHt), taux);
      let projectId = null, projectRef = null;
      if (factureVenteId) {
        const f = await tx.get("SELECT * FROM sales_invoices WHERE id=$1", factureVenteId);
        if (!f) throw Object.assign(new Error("Facture de vente introuvable"), { status: 404 });
        if (f.status === "ANNULEE") throw Object.assign(new Error("Facture de vente annulée"), { status: 409 });
        const deja = (await tx.get("SELECT COALESCE(SUM(amount_ttc),0) s FROM received_transactions WHERE sales_invoice_id=$1", factureVenteId)).s;
        assertWithinRemaining(f.total_ttc, deja, m.montantTtc, "encaissement");
        projectId = f.project_id; projectRef = f.project_reference;
      }
      const ref = await nextTxRef(tx, "ENC", "received_transactions");
      const r = await tx.run(`INSERT INTO received_transactions (reference,transaction_date,amount_ht,vat_rate_id,taux_tva,
        vat_label_snapshot,tva_amount,amount_ttc,transaction_type_id,sales_invoice_id,project_id,project_reference,notes,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, ref, dateTransaction || new Date().toISOString().slice(0, 10),
        m.montantHt, id, taux, label, m.montantTva, m.montantTtc, typeId, factureVenteId, projectId, projectRef, notes, userId || null, userId || null);
      newId = r.lastInsertRowid;
      await audit(tx, "received_transaction", newId, "CREATED", userId, JSON.stringify({ reference: ref }));
    });
    return Encaissements.get(newId);
  },

  async get(id) {
    const db = getDb();
    return await db.get(`SELECT r.*, t.label type_label, u.email created_by_email, f.reference invoice_reference
      FROM received_transactions r JOIN transaction_types t ON t.id=r.transaction_type_id
      LEFT JOIN users u ON u.id=r.created_by LEFT JOIN sales_invoices f ON f.id=r.sales_invoice_id WHERE r.id=$1`, id) || null;
  },

  async list({ search = "", typeId = "", page = 1, pageSize = 15 } = {}) {
    const db = getDb();
    const where = [], params = [];
    if (typeId) { where.push(`r.transaction_type_id=$${params.length + 1}`); params.push(typeId); }
    if (search) {
      where.push(`(r.reference LIKE $${params.length + 1} OR r.project_reference LIKE $${params.length + 2} OR f.reference LIKE $${params.length + 3})`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (await db.get(`SELECT COUNT(*) c FROM received_transactions r LEFT JOIN sales_invoices f ON f.id=r.sales_invoice_id ${w}`, ...params)).c;
    const rows = await db.all(`SELECT r.*, t.label type_label, f.reference invoice_reference
      FROM received_transactions r JOIN transaction_types t ON t.id=r.transaction_type_id
      LEFT JOIN sales_invoices f ON f.id=r.sales_invoice_id ${w}
      ORDER BY r.transaction_date DESC, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, ...params, pageSize, (page - 1) * pageSize);
    return { rows, total, page, pageSize };
  },

  async totals() {
    const db = getDb();
    const r = await db.get("SELECT COALESCE(SUM(amount_ht),0) ht, COALESCE(SUM(tva_amount),0) tva, COALESCE(SUM(amount_ttc),0) ttc FROM received_transactions");
    return { totalHt: roundMoney(r.ht), totalTva: roundMoney(r.tva), totalTtc: roundMoney(r.ttc) };
  },

  async delete(id, userId) {
    const db = getDb();
    await db.transaction(async (tx) => {
      const r = await tx.get("SELECT * FROM received_transactions WHERE id=$1", id);
      if (!r) throw Object.assign(new Error("Encaissement introuvable"), { status: 404 });
      await tx.run("DELETE FROM received_transactions WHERE id=$1", id);
      await audit(tx, "received_transaction", id, "DELETED", userId, JSON.stringify({ reference: r.reference }));
    });
    return { ok: true };
  },
};

export const Paiements = {
  async create({ datePaiement, fournisseurId, factureAchatId, montantHt, vatRateId, tauxTva, typeId, notes = null }, userId) {
    const db = getDb();
    let newId;
    await db.transaction(async (tx) => {
      await resolveType(tx, typeId);
      const f = await tx.get("SELECT * FROM purchase_invoices WHERE id=$1", factureAchatId);
      if (!f) throw Object.assign(new Error("Facture d'achat introuvable"), { status: 404 });
      if (f.status === "ANNULEE") throw Object.assign(new Error("Facture d'achat annulée"), { status: 409 });
      const supId = fournisseurId || f.supplier_id;
      if (supId !== f.supplier_id) throw Object.assign(new Error("Le fournisseur ne correspond pas à la facture d'achat"), { status: 400 });
      if (!await tx.get("SELECT id FROM suppliers WHERE id=$1", supId)) throw Object.assign(new Error("Fournisseur introuvable"), { status: 404 });
      const { taux, label, id } = await resolveTaux(tx, vatRateId, tauxTva);
      const m = calculateTransactionAmounts(Number(montantHt), taux);
      const deja = (await tx.get("SELECT COALESCE(SUM(amount_ttc),0) s FROM supplier_payments WHERE purchase_invoice_id=$1", factureAchatId)).s;
      assertWithinRemaining(f.total_ttc, deja, m.montantTtc, "paiement");
      const ref = await nextTxRef(tx, "PAY", "supplier_payments");
      const r = await tx.run(`INSERT INTO supplier_payments (reference,payment_date,supplier_id,purchase_invoice_id,
        amount_ht,vat_rate_id,taux_tva,vat_label_snapshot,tva_amount,amount_ttc,transaction_type_id,notes,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, ref, datePaiement || new Date().toISOString().slice(0, 10),
        supId, factureAchatId, m.montantHt, id, taux, label, m.montantTva, m.montantTtc, typeId, notes, userId || null, userId || null);
      newId = r.lastInsertRowid;
      await audit(tx, "supplier_payment", newId, "CREATED", userId, JSON.stringify({ reference: ref }));
    });
    return Paiements.get(newId);
  },

  async get(id) {
    const db = getDb();
    return await db.get(`SELECT p.*, t.label type_label, s.name supplier_name, f.reference invoice_reference, f.project_reference
      FROM supplier_payments p JOIN transaction_types t ON t.id=p.transaction_type_id
      JOIN suppliers s ON s.id=p.supplier_id JOIN purchase_invoices f ON f.id=p.purchase_invoice_id WHERE p.id=$1`, id) || null;
  },

  async list({ search = "", fournisseurId = "", page = 1, pageSize = 15 } = {}) {
    const db = getDb();
    const where = [], params = [];
    if (fournisseurId) { where.push(`p.supplier_id=$${params.length + 1}`); params.push(fournisseurId); }
    if (search) {
      where.push(`(p.reference LIKE $${params.length + 1} OR f.reference LIKE $${params.length + 2} OR s.name LIKE $${params.length + 3} OR f.project_reference LIKE $${params.length + 4})`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (await db.get(`SELECT COUNT(*) c FROM supplier_payments p JOIN suppliers s ON s.id=p.supplier_id JOIN purchase_invoices f ON f.id=p.purchase_invoice_id ${w}`, ...params)).c;
    const rows = await db.all(`SELECT p.*, t.label type_label, s.name supplier_name, f.reference invoice_reference, f.project_reference
      FROM supplier_payments p JOIN transaction_types t ON t.id=p.transaction_type_id
      JOIN suppliers s ON s.id=p.supplier_id JOIN purchase_invoices f ON f.id=p.purchase_invoice_id ${w}
      ORDER BY p.payment_date DESC, p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, ...params, pageSize, (page - 1) * pageSize);
    return { rows, total, page, pageSize };
  },

  /** Indicateurs calculés depuis les données réelles (§21). */
  async totals() {
    const db = getDb();
    const paye = (await db.get("SELECT COALESCE(SUM(amount_ttc),0) s FROM supplier_payments")).s;
    const fact = await db.get("SELECT COALESCE(SUM(total_ttc),0) s, COALESCE(SUM(total_ht),0) h FROM purchase_invoices WHERE status='VALIDEE'");
    const soldes = await db.all(`SELECT f.total_ttc - COALESCE(SUM(p.amount_ttc),0) reste,
      COALESCE(SUM(p.amount_ttc),0) paye FROM purchase_invoices f
      LEFT JOIN supplier_payments p ON p.purchase_invoice_id=f.id
      WHERE f.status='VALIDEE' GROUP BY f.id, f.total_ttc`);
    const nonPayees = soldes.filter((r) => r.paye <= 0.0005).length;
    const partielles = soldes.filter((r) => r.paye > 0.0005 && r.reste > 0.0005).length;
    const soldees = soldes.filter((r) => r.reste <= 0.0005).length;
    return { totalPaye: roundMoney(paye), totalFacture: roundMoney(fact.s), resteAPayer: roundMoney(fact.s - paye),
      totalFactureHt: roundMoney(fact.h), nonPayees, partielles, soldees };
  },

  /** Solde d'une facture d'achat : total, payé, reste, statut dérivé. */
  async soldeFacture(factureAchatId) {
    const db = getDb();
    const f = await db.get("SELECT * FROM purchase_invoices WHERE id=$1", factureAchatId);
    if (!f) throw Object.assign(new Error("Facture d'achat introuvable"), { status: 404 });
    const paye = (await db.get("SELECT COALESCE(SUM(amount_ttc),0) s FROM supplier_payments WHERE purchase_invoice_id=$1", factureAchatId)).s;
    return { total: f.total_ttc, paye: roundMoney(paye), reste: remainingAmount(f.total_ttc, paye), statut: derivePaymentStatus(f.total_ttc, paye) };
  },

  /** Factures avec restant > 0 pour un fournisseur (aide à la saisie). */
  async impayees(fournisseurId = null) {
    const db = getDb();
    const w = fournisseurId ? "WHERE f.supplier_id=$1" : "";
    const params = fournisseurId ? [fournisseurId] : [];
    return (await db.all(`SELECT f.id, f.reference, f.total_ttc, f.project_reference,
      f.total_ttc - COALESCE((SELECT SUM(amount_ttc) FROM supplier_payments p WHERE p.purchase_invoice_id=f.id),0) reste
      FROM purchase_invoices f ${w} ORDER BY f.reference`, ...params)).filter((r) => r.reste > 0.0005);
  },

  async delete(id, userId) {
    const db = getDb();
    await db.transaction(async (tx) => {
      const r = await tx.get("SELECT * FROM supplier_payments WHERE id=$1", id);
      if (!r) throw Object.assign(new Error("Paiement introuvable"), { status: 404 });
      await tx.run("DELETE FROM supplier_payments WHERE id=$1", id);
      await audit(tx, "supplier_payment", id, "DELETED", userId, JSON.stringify({ reference: r.reference }));
    });
    return { ok: true };
  },
};

/** Pilotage financier du dashboard (§25) : vendu / facturé / reçu, achats, marge. */
export async function pilotageFinancier() {
  const db = getDb();
  const vendu = (await db.get("SELECT COALESCE(SUM(total_ttc),0) s FROM projects WHERE status='VALIDE'")).s;
  const fv = await db.get("SELECT COALESCE(SUM(total_ht),0) h, COALESCE(SUM(total_ttc),0) t FROM sales_invoices WHERE status='VALIDEE'");
  const recu = await db.get("SELECT COALESCE(SUM(amount_ht),0) h, COALESCE(SUM(amount_ttc),0) t FROM received_transactions");
  const fa = await db.get("SELECT COALESCE(SUM(total_ht),0) h, COALESCE(SUM(total_ttc),0) t FROM purchase_invoices WHERE status='VALIDEE'");
  const paye = (await db.get("SELECT COALESCE(SUM(amount_ttc),0) s FROM supplier_payments")).s;
  // Marge facturée (HT) = total des marges des LIGNES des factures de vente validées :
  // Σ (prix de vente − coût d'achat snapshoté) × quantité. Sans lien avec les factures d'achat.
  const lignesMarge = await db.all(`SELECT l.unit_price, l.cout_achat_snapshot, l.quantity
    FROM sales_invoice_lines l JOIN sales_invoices f ON f.id = l.sales_invoice_id
    WHERE f.status='VALIDEE'`);
  const marge = lignesMarge.reduce((t, l) => roundMoney(t + calculateInvoiceLineMargin(l.unit_price, l.cout_achat_snapshot, l.quantity)), 0);
  return {
    caVenduTtc: roundMoney(vendu),
    caFactureHt: roundMoney(fv.h), caFactureTtc: roundMoney(fv.t),
    caRecuHt: roundMoney(recu.h), caRecuTtc: roundMoney(recu.t),
    achatsFacturesHt: roundMoney(fa.h), achatsFacturesTtc: roundMoney(fa.t),
    achatsPayesTtc: roundMoney(paye), resteAPayerTtc: roundMoney(fa.t - paye),
    margeFactureeHt: marge,
  };
}
