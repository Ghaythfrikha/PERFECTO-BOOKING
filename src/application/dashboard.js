// Application — statistiques du tableau de bord (§1-§14, §24).
// Présentation uniquement : agrégations SQL ciblées, règles métier réutilisées
// (marges = vente − coût, statuts dérivés, reçu = Σ transactions par période).
// Règles de filtres (§13) : chaque section n'applique que les filtres ayant un sens
// pour elle (ex. le client ne filtre pas les données fournisseurs).
import { getDb } from "../infrastructure/db/database.js";
import { roundMoney } from "../domain/money.js";
import { derivePaymentStatus } from "../domain/payments.js";

function moisCles(finIso, nb = 12) {
  const [y, m] = finIso.slice(0, 7).split("-").map(Number);
  const cles = [];
  for (let i = nb - 1; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    cles.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return cles;
}

function sommeParMois(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.m, roundMoney(r.s || 0));
  return map;
}

export function pilotage(filtres = {}) {
  const db = getDb();
  const auj = new Date().toISOString().slice(0, 10);
  const fin = filtres.fin || auj;
  const debut = filtres.debut || `${fin.slice(0, 4)}-01-01`;
  const clientId = filtres.clientId ? Number(filtres.clientId) : null;
  const fournisseurId = filtres.fournisseurId ? Number(filtres.fournisseurId) : null;
  const categorieId = filtres.categorieId ? Number(filtres.categorieId) : null;
  const statut = filtres.statut || "";

  // ---- Projets : effectifs (filtres client + période sur la DATE D'ÉVÉNEMENT) ----
  const wp = [], pp = [];
  if (clientId) { wp.push("p.customer_id=?"); pp.push(clientId); }
  if (filtres.debut || filtres.fin) { wp.push("date(p.start_date) BETWEEN date(?) AND date(?)"); pp.push(debut, fin); }
  const wClause = wp.length ? "WHERE " + wp.join(" AND ") : "";
  const effectifs = db.prepare(`SELECT status, COUNT(*) c FROM projects p ${wClause} GROUP BY status`).all(...pp);
  const nb = { BROUILLON: 0, VALIDE: 0, ANNULE: 0 };
  for (const r of effectifs) if (nb[r.status] !== undefined) nb[r.status] = r.c;

  const wAtt = [...wp];
  if (statut) { wAtt.push("p.status=?"); }
  const pAtt = [...pp, ...(statut ? [statut] : [])];
  const attClause = wAtt.length ? "WHERE " + wAtt.join(" AND ") : "";
  const selBrouillon = `SELECT p.id, p.reference, p.title, c.name client, p.start_date, p.total_ttc,
    p.total_marge_notre_agence marge, (SELECT COUNT(*) FROM project_lines l WHERE l.project_id=p.id) nb_lignes
    FROM projects p JOIN customers c ON c.id=p.customer_id`;
  const brouillonsListe = statut
    ? db.prepare(`${selBrouillon} ${attClause} ORDER BY p.updated_at DESC LIMIT 8`).all(...pAtt)
    : db.prepare(`${selBrouillon} ${wClause} ${wClause ? "AND" : "WHERE"} p.status='BROUILLON'
      ORDER BY p.updated_at DESC LIMIT 8`).all(...pp);
  const margesNeg = db.prepare(`SELECT p.id, p.reference, p.title, c.name client, p.total_ht, p.total_marge_notre_agence marge
    FROM projects p JOIN customers c ON c.id=p.customer_id
    WHERE p.status='VALIDE' AND p.total_marge_notre_agence < 0 ${clientId ? "AND p.customer_id=?" : ""}
    ORDER BY p.total_marge_notre_agence LIMIT 10`).all(...(clientId ? [clientId] : []));

  // ---- CA mensuel (12 mois) : vendu = devis validés (mois de l'ÉVÉNEMENT), facturé = FV (émission), reçu = Σ transactions ----
  const cles = moisCles(fin);
  const d12 = `${cles[0]}-01`;
  const venduRows = db.prepare(`SELECT strftime('%Y-%m', p.start_date) m, SUM(p.total_ht) s FROM projects p
    WHERE p.status='VALIDE' AND date(p.start_date) >= date(?) ${clientId ? "AND p.customer_id=?" : ""}
    ${categorieId ? "AND EXISTS (SELECT 1 FROM project_lines l JOIN articles a ON a.id=l.article_id WHERE l.project_id=p.id AND a.category_id=?)" : ""}
    GROUP BY m`).all(d12, ...(clientId ? [clientId] : []), ...(categorieId ? [categorieId] : []));
  const factureRows = db.prepare(`SELECT strftime('%Y-%m', f.issue_date) m, SUM(f.total_ht) s FROM sales_invoices f
    WHERE f.status='VALIDEE' AND date(f.issue_date) >= date(?) ${clientId ? "AND f.customer_id=?" : ""} GROUP BY m`)
    .all(d12, ...(clientId ? [clientId] : []));
  const recuRows = db.prepare(`SELECT strftime('%Y-%m', r.transaction_date) m, SUM(r.amount_ht) s FROM received_transactions r
    WHERE date(r.transaction_date) >= date(?) GROUP BY m`).all(d12);
  const mV = sommeParMois(venduRows), mF = sommeParMois(factureRows), mR = sommeParMois(recuRows);
  // Période personnalisée : seuls les mois demandés sont conservés (KPI cohérents).
  const mDebut = (filtres.debut || "").slice(0, 7);
  const caMensuel = cles
    .filter((k) => !mDebut || k >= mDebut)
    .map((k) => ({ mois: k, vendu: mV.get(k) || 0, facture: mF.get(k) || 0, recu: mR.get(k) || 0 }));

  // ---- Factures d'achat : jamais de suivi "vente encaissée" (§5, §10) ----
  const wf = [], pf = [];
  if (fournisseurId) { wf.push("f.supplier_id=?"); pf.push(fournisseurId); }
  if (filtres.debut || filtres.fin) { wf.push("date(f.issue_date) BETWEEN date(?) AND date(?)"); pf.push(debut, fin); }
  const fClause = wf.length ? "WHERE " + wf.join(" AND ") : "";
  const soldes = db.prepare(`SELECT f.id, f.reference, f.supplier_name_snapshot fournisseur, f.project_reference projet,
    f.issue_date, f.total_ht, f.total_ttc, COALESCE(SUM(p.amount_ttc),0) paye
    FROM purchase_invoices f LEFT JOIN supplier_payments p ON p.purchase_invoice_id=f.id
    ${fClause} ${fClause ? "AND" : "WHERE"} f.status='VALIDEE' GROUP BY f.id`).all(...pf);
  let faHt = 0, faTtc = 0, faPaye = 0, nonPayees = 0, partielles = 0, soldees = 0;
  const aSurveiller = [];
  for (const r of soldes) {
    faHt = roundMoney(faHt + r.total_ht); faTtc = roundMoney(faTtc + r.total_ttc); faPaye = roundMoney(faPaye + r.paye);
    const reste = roundMoney(r.total_ttc - r.paye);
    const st = derivePaymentStatus(r.total_ttc, r.paye);
    if (st === "NON_PAYE") nonPayees++; else if (st === "PARTIEL") partielles++; else soldees++;
    if (st !== "TOTAL") aSurveiller.push({ ...r, paye: roundMoney(r.paye), reste, statut: st });
  }
  aSurveiller.sort((a, b) => b.reste - a.reste);

  // ---- Tops ----
  const topFournisseurs = db.prepare(`SELECT f.supplier_id id, f.supplier_name_snapshot nom,
    SUM(f.total_ttc) total, COALESCE((SELECT SUM(p.amount_ttc) FROM supplier_payments p
      JOIN purchase_invoices f2 ON f2.id=p.purchase_invoice_id WHERE f2.supplier_id=f.supplier_id AND f2.status='VALIDEE'),0) paye
    FROM purchase_invoices f WHERE f.status='VALIDEE' ${fournisseurId ? "AND f.supplier_id=?" : ""}
    ${filtres.debut || filtres.fin ? "AND date(f.issue_date) BETWEEN date(?) AND date(?)" : ""}
    GROUP BY f.supplier_id ORDER BY total DESC LIMIT 5`)
    .all(...(fournisseurId ? [fournisseurId] : []), ...((filtres.debut || filtres.fin) ? [debut, fin] : []))
    .map((r) => ({ ...r, total: roundMoney(r.total), paye: roundMoney(r.paye), reste: roundMoney(r.total - r.paye) }));
  const topClients = db.prepare(`SELECT * FROM (SELECT c.id, c.name nom,
    COALESCE((SELECT SUM(p.total_ttc) FROM projects p WHERE p.customer_id=c.id AND p.status='VALIDE'
      ${filtres.debut || filtres.fin ? "AND date(p.start_date) BETWEEN date(?) AND date(?)" : ""}),0) vendu,
    COALESCE((SELECT SUM(f.total_ttc) FROM sales_invoices f WHERE f.customer_id=c.id AND f.status='VALIDEE'
      ${filtres.debut || filtres.fin ? "AND date(f.issue_date) BETWEEN date(?) AND date(?)" : ""}),0) facture
    FROM customers c WHERE c.is_active=1 ${clientId ? "AND c.id=?" : ""})
    WHERE vendu > 0 OR facture > 0 ORDER BY vendu DESC LIMIT 5`).all(...(() => {
      const a = [];
      if (filtres.debut || filtres.fin) a.push(debut, fin);
      if (filtres.debut || filtres.fin) a.push(debut, fin);
      if (clientId) a.push(clientId);
      return a;
    })()).map((r) => ({ ...r, vendu: roundMoney(r.vendu), facture: roundMoney(r.facture) }));

  // ---- CA par catégorie (lignes des projets validés) ----
  const catRows = db.prepare(`SELECT COALESCE(cat.label,'Sans catégorie') categorie, SUM(l.quantity * l.prix_vente_notre_agence) ht
    FROM project_lines l JOIN projects p ON p.id=l.project_id
    LEFT JOIN articles a ON a.id=l.article_id LEFT JOIN article_categories cat ON cat.id=a.category_id
    WHERE p.status='VALIDE' ${clientId ? "AND p.customer_id=?" : ""}
    ${filtres.debut || filtres.fin ? "AND date(p.start_date) BETWEEN date(?) AND date(?)" : ""}
    ${categorieId ? "AND a.category_id=?" : ""}
    GROUP BY categorie ORDER BY ht DESC LIMIT 8`)
    .all(...(clientId ? [clientId] : []), ...((filtres.debut || filtres.fin) ? [debut, fin] : []), ...(categorieId ? [categorieId] : []));
  const catTotal = catRows.reduce((t, r) => t + (r.ht || 0), 0);
  const caParCategorie = catRows.map((r) => ({ categorie: r.categorie, ht: roundMoney(r.ht || 0),
    part: catTotal > 0 ? Math.round(((r.ht || 0) / catTotal) * 1000) / 10 : 0 }));

  // ---- Rentabilité : CA − coût = marge (montant ; aucun taux inventé, §9) ----
  const rentRows = db.prepare(`SELECT p.id, p.reference, p.title, c.name client, p.total_ht ca, p.total_achat_notre_agence cout,
    p.total_marge_notre_agence marge FROM projects p JOIN customers c ON c.id=p.customer_id
    WHERE p.status='VALIDE' ${clientId ? "AND p.customer_id=?" : ""}
    ${filtres.debut || filtres.fin ? "AND date(p.start_date) BETWEEN date(?) AND date(?)" : ""}
    ORDER BY p.total_marge_notre_agence DESC`).all(...(clientId ? [clientId] : []), ...((filtres.debut || filtres.fin) ? [debut, fin] : []));
  const rentabilite = {
    totalMarge: roundMoney(rentRows.reduce((t, r) => t + (r.marge || 0), 0)),
    top: rentRows.slice(0, 5).map((r) => ({ ...r, ca: roundMoney(r.ca), cout: roundMoney(r.cout), marge: roundMoney(r.marge) })),
    surveiller: rentRows.filter((r) => r.marge < 0).slice(0, 10)
      .map((r) => ({ ...r, ca: roundMoney(r.ca), cout: roundMoney(r.cout), marge: roundMoney(r.marge) })),
  };

  // ---- Alertes actionnables (§10) : jamais de "vente impayée" ----
  const alertes = [];
  if (nb.BROUILLON > 0) alertes.push({ niveau: "attention", libelle: `${nb.BROUILLON} projet(s) en brouillon`, detail: "Devis à valider", cible: { vue: "projets" } });
  const sansLignes = brouillonsListe.filter((b) => b.nb_lignes === 0);
  if (sansLignes.length > 0) alertes.push({ niveau: "probleme", libelle: `${sansLignes.length} brouillon(s) sans prestation`, detail: sansLignes.slice(0, 3).map((b) => b.reference).join(", "), cible: { vue: "projets" } });
  for (const m of margesNeg) alertes.push({ niveau: "probleme", libelle: `Marge négative : ${m.reference}`, detail: `${m.client} — ${m.marge} DT`, cible: { vue: "projet", id: m.id } });
  if (nonPayees > 0) alertes.push({ niveau: "attention", libelle: `${nonPayees} facture(s) d'achat non payée(s)`, detail: `Reste global : ${roundMoney(faTtc - faPaye)} DT`, cible: { vue: "factures", onglet: "achat" } });
  if (partielles > 0) alertes.push({ niveau: "info", libelle: `${partielles} facture(s) partiellement payée(s)`, detail: "Suivi des règlements", cible: { vue: "factures", onglet: "achat" } });

  // ---- Activité récente (audit existant, aucun second système, §11) ----
  const acts = db.prepare(`SELECT a.entity, a.action, a.payload, a.created_at, u.email auteur
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 15`).all();
  const LIB = { project: "Projet", purchase_order: "Commande d'achat", sales_invoice: "Facture de vente",
    purchase_invoice: "Facture d'achat", received_transaction: "Encaissement", supplier_payment: "Paiement fournisseur" };
  const ACT = { CREATED: "créé", GENERATED: "généré", VALIDATED: "validé", CONFIRMED: "confirmé", CANCELLED: "annulé",
    UPDATED: "modifié", LINE_ADDED: "prestation ajoutée", LINE_UPDATED: "prestation modifiée", LINE_REMOVED: "prestation retirée",
    DUPLICATED: "dupliqué", DELETED: "supprimé", VALIDEE: "validé", CLOTUREE: "clôturé", ANNULEE: "annulé" };
  const activite = acts.map((a) => {
    let ref = "";
    try { const p = JSON.parse(a.payload || "{}"); ref = p.reference || (p.project_id ? `projet #${p.project_id}` : ""); } catch { /* payload libre */ }
    return { quand: (a.created_at || "").slice(0, 16).replace("T", " "), texte: `${LIB[a.entity] || a.entity} ${ACT[a.action] || a.action}${ref ? ` — ${ref}` : ""}`, auteur: a.auteur || "—" };
  });

  return {
    projets: { ...nb, total: nb.BROUILLON + nb.VALIDE + nb.ANNULE, brouillons: brouillonsListe, margesNegatives: margesNeg },
    caMensuel,
    facturesAchat: { totalHt: faHt, totalTtc: faTtc, paye: faPaye, reste: roundMoney(faTtc - faPaye), nonPayees, partielles, soldees, surveiller: aSurveiller.slice(0, 10) },
    topFournisseurs, topClients, caParCategorie, rentabilite, alertes, activite,
  };
}
