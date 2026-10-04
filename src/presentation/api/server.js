import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../../infrastructure/db/database.js";
import { Projects } from "../../application/projects.js";
import { confirmProject, getDoc, listDocs, transitionDoc, deleteDoc, getLinkedDocuments } from "../../application/documentFlow.js";
import { Encaissements, Paiements, pilotageFinancier } from "../../application/finance.js";
import { pilotage } from "../../application/dashboard.js";
import { genererPdf } from "../../documents/buildPdf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "poc-erp-secret-change-me";

app.use(express.json());
app.use(express.static(join(__dirname, "web")));

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.full_name, role: user.role_code }, JWT_SECRET, { expiresIn: "12h" });
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ erreur: "Authentification requise" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ erreur: "Session expirée, veuillez vous reconnecter" }); }
}

// --- Auth ---
app.post("/api/auth/login", (req, res) => {
  const { email, motDePasse } = req.body;
  if (!email || !motDePasse) return res.status(400).json({ erreur: "Email et mot de passe requis" });
  const db = getDb();
  const u = db.prepare(`SELECT u.*, r.code role_code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.email=? AND u.is_active=1`).get(email);
  if (!u || !bcrypt.compareSync(motDePasse, u.password_hash))
    return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
  res.json({ jeton: sign(u), utilisateur: { id: u.id, nom: u.full_name, email: u.email, role: u.role_code } });
});
app.get("/api/auth/me", auth, (req, res) => res.json({ utilisateur: req.user }));

// --- Référentiels génériques (clients, fournisseurs, articles, tva) ---
function crud(table, map, searchCols) {
  const r = express.Router();
  r.get("/", auth, (req, res) => {
    const db = getDb();
    const { recherche = "", inactifs = "", page = 1, pageSize = 50 } = req.query;
    let w = "", params = [];
    if (recherche) { w = `WHERE (${searchCols.map((c) => `${c} LIKE ?`).join(" OR ")})`; params = searchCols.map(() => `%${recherche}%`); }
    if (inactifs !== "1") { w += (w ? " AND " : "WHERE ") + "is_active=1"; }
    const total = db.prepare(`SELECT COUNT(*) c FROM ${table} ${w}`).get(...params).c;
    const rows = db.prepare(`SELECT * FROM ${table} ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
    res.json({ lignes: rows, total });
  });
  r.post("/", auth, (req, res) => {
    try {
      const db = getDb();
      const v = map(req.body);
      const keys = Object.keys(v);
      const row = db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => v[k]));
      res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.lastInsertRowid));
    } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
  });
  r.put("/:id", auth, (req, res) => {
    try {
      const db = getDb();
      const v = map(req.body);
      const keys = Object.keys(v);
      db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=datetime('now') WHERE id=?`)
        .run(...keys.map((k) => v[k]), req.params.id);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id));
    } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
  });
  r.delete("/:id", auth, (req, res) => {
    const db = getDb();
    try { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); res.json({ ok: true }); }
    catch { // suppression douce si référencé
      db.prepare(`UPDATE ${table} SET is_active=0 WHERE id=?`).run(req.params.id);
      res.json({ ok: true, desactive: true });
    }
  });
  return r;
}

const nonVide = (v, d = null) => (v === undefined || v === "" ? d : v);

app.use("/api/clients", crud("customers",
  (b) => ({ code: b.code, name: b.name, contact: nonVide(b.contact), phone: nonVide(b.phone), email: nonVide(b.email), address: nonVide(b.address), notes: nonVide(b.notes), is_active: b.is_active === 0 ? 0 : 1 }),
  ["code", "name", "phone", "email"]));
app.use("/api/fournisseurs", crud("suppliers",
  (b) => ({ code: b.code, name: b.name, contact: nonVide(b.contact), phone: nonVide(b.phone), email: nonVide(b.email), address: nonVide(b.address), notes: nonVide(b.notes), is_active: b.is_active === 0 ? 0 : 1 }),
  ["code", "name", "phone", "email"]));
app.use("/api/articles", crud("articles",
  (b) => ({ code: b.code, designation: b.designation, category_id: nonVide(b.category_id), unit: b.unit || "Unité", description: nonVide(b.description), is_active: b.is_active === 0 ? 0 : 1 }),
  ["code", "designation"]));

// TVA (lecture + admin)
app.get("/api/tva", auth, (req, res) => {
  const db = getDb();
  res.json({ lignes: db.prepare("SELECT * FROM vat_rates ORDER BY rate").all() });
});
app.post("/api/tva", auth, (req, res) => {
  try {
    const db = getDb();
    const r = db.prepare("INSERT INTO vat_rates (code,label,rate,is_active) VALUES (?,?,?,?)")
      .run(req.body.code, req.body.label, Number(req.body.rate), req.body.is_active === 0 ? 0 : 1);
    res.status(201).json(db.prepare("SELECT * FROM vat_rates WHERE id=?").get(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
});
app.put("/api/tva/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE vat_rates SET code=?,label=?,rate=?,is_active=? WHERE id=?")
    .run(req.body.code, req.body.label, Number(req.body.rate), req.body.is_active === 0 ? 0 : 1, req.params.id);
  res.json(db.prepare("SELECT * FROM vat_rates WHERE id=?").get(req.params.id));
});
app.get("/api/categories", auth, (req, res) => {
  res.json({ lignes: getDb().prepare("SELECT * FROM article_categories ORDER BY label").all() });
});

// --- Projets ---
app.get("/api/projets", auth, (req, res) => {
  res.json(Projects.list({ search: req.query.recherche || "", status: req.query.statut || "",
    page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15),
    sort: req.query.tri || "updated_at", dir: req.query.sens || "DESC" }));
});
app.post("/api/projets", auth, (req, res) => {
  try {
    const p = Projects.create({ titre: req.body.titre, clientId: req.body.clientId,
      dateDebut: req.body.dateDebut || null, dateFin: req.body.dateFin || null, notes: req.body.notes || null }, req.user.id);
    res.status(201).json(p);
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/projets/:id", auth, (req, res) => {
  const p = Projects.get(req.params.id);
  if (!p) return res.status(404).json({ erreur: "Projet introuvable" });
  res.json(p);
});
app.put("/api/projets/:id", auth, (req, res) => {
  try { res.json(Projects.updateHeader(req.params.id, req.body, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.delete("/api/projets/:id", auth, (req, res) => {
  try { res.json(Projects.delete(req.params.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/lignes", auth, (req, res) => {
  try { res.status(201).json(Projects.addLine(req.params.id, req.body, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.put("/api/projets/:id/lignes/:lid", auth, (req, res) => {
  try { res.json(Projects.updateLine(req.params.id, req.params.lid, req.body, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.delete("/api/projets/:id/lignes/:lid", auth, (req, res) => {
  try { res.json(Projects.removeLine(req.params.id, req.params.lid, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/valider", auth, (req, res) => {
  try { res.json(Projects.validate(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/annuler", auth, (req, res) => {
  try { res.json(Projects.cancel(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/dupliquer", auth, (req, res) => {
  try { res.status(201).json(Projects.duplicate(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});

// --- Confirmation client (§56) : VERROUILLE + génère facture de vente et factures d'achat ---
app.post("/api/projets/:id/confirmer", auth, (req, res) => {
  try {
    confirmProject(req.params.id, req.user.id, req.body.note || null);
    res.json(Projects.get(req.params.id));
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/projets/:id/documents", auth, (req, res) => {
  const p = Projects.get(req.params.id);
  if (!p) return res.status(404).json({ erreur: "Projet introuvable" });
  res.json({ devis: p.quote_reference || null, ...getLinkedDocuments(req.params.id) });
});

// --- Documents (commandes d'achat, factures) ---
function routesDocs(url, kind, action2) {
  app.get(url, auth, (req, res) => {
    res.json(listDocs(kind, { search: req.query.recherche || "", status: req.query.statut || "",
      page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15) }));
  });
  app.get(`${url}/:id`, auth, (req, res) => {
    const d = getDoc(kind, req.params.id);
    if (!d) return res.status(404).json({ erreur: "Document introuvable" });
    res.json(d);
  });
  app.post(`${url}/:id/valider`, auth, (req, res) => {
    try { res.json(transitionDoc(kind, req.params.id, "VALIDEE", req.user.id)); }
    catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
  });
  app.post(`${url}/:id/${action2}`, auth, (req, res) => {
    try { res.json(transitionDoc(kind, req.params.id, action2 === "cloturer" ? "CLOTUREE" : "ANNULEE", req.user.id)); }
    catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
  });
  app.delete(`${url}/:id`, auth, (req, res) => {
    try { res.json(deleteDoc(kind, req.params.id)); }
    catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
  });
}
routesDocs("/api/commandes-achat", "po", "cloturer");
routesDocs("/api/factures-vente", "si", "annuler");
routesDocs("/api/factures-achat", "pi", "annuler");

// --- PDF (§61-62) : GET .../pdf, données = snapshots persistés ---
function envoyerPdf(res, promesse, nom) {
  promesse.then((buf) => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nom}.pdf"`);
    res.send(buf);
  }).catch((e) => res.status(500).json({ erreur: "Génération PDF impossible : " + e.message }));
}
const mapLignesPdf = (lignes) => lignes.map((l) => ({
  designation: l.article_designation_snapshot, description: l.description,
  quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, tauxTva: l.taux_tva,
  totalHt: l.total_ht, totalTtc: l.total_ttc,
}));
app.get("/api/projets/:id/devis/pdf", auth, (req, res) => {
  const p = Projects.get(req.params.id);
  if (!p) return res.status(404).json({ erreur: "Projet introuvable" });
  envoyerPdf(res, genererPdf({
    titre: "Devis", reference: p.quote_reference || p.reference, date: p.created_at, refProjet: p.reference,
    tiersTitre: "Client", tiersLignes: [p.customer_name_snapshot || p.customer_name],
    lignes: p.lines.map((l) => ({ designation: l.article_designation_snapshot || l.article_designation,
      description: l.description, quantity: l.quantity, unit: l.unit,
      unitPrice: l.prix_vente_notre_agence, tauxTva: l.taux_tva, totalHt: l.total_ht, totalTtc: l.total_ttc })),
    totauxLignes: [["Prix de vente HT", p.total_ht], ["TVA", p.total_tva]], totalTtc: p.total_ttc, notes: p.notes,
  }), `devis-${p.reference}`);
});
app.get("/api/commandes-achat/:id/pdf", auth, (req, res) => {
  const d = getDoc("po", req.params.id);
  if (!d) return res.status(404).json({ erreur: "Document introuvable" });
  envoyerPdf(res, genererPdf({
    titre: "Commande d'achat", reference: d.reference, date: d.created_at, refProjet: d.project_reference,
    tiersTitre: "Fournisseur", tiersLignes: [d.supplier_name_snapshot, d.supplier_address_snapshot],
    lignes: mapLignesPdf(d.lines),
    totauxLignes: [["Total HT", d.subtotal_ht], ["TVA", d.total_tva]], totalTtc: d.total_ttc, notes: d.notes,
  }), `commande-${d.reference}`);
});
app.get("/api/factures-vente/:id/pdf", auth, (req, res) => {
  const d = getDoc("si", req.params.id);
  if (!d) return res.status(404).json({ erreur: "Document introuvable" });
  envoyerPdf(res, genererPdf({
    titre: "Facture de vente", reference: d.reference, date: d.issue_date, refProjet: d.project_reference,
    tiersTitre: "Client", tiersLignes: [d.customer_name_snapshot, d.customer_address_snapshot],
    lignes: mapLignesPdf(d.lines),
    totauxLignes: [["Total HT", d.total_ht], ["TVA", d.total_tva]], totalTtc: d.total_ttc, notes: d.notes,
  }), `facture-vente-${d.reference}`);
});
app.get("/api/factures-achat/:id/pdf", auth, (req, res) => {
  const d = getDoc("pi", req.params.id);
  if (!d) return res.status(404).json({ erreur: "Document introuvable" });
  envoyerPdf(res, genererPdf({
    titre: "Facture d'achat", reference: d.reference, date: d.issue_date, refProjet: d.project_reference,
    refExtra: `Commande d'origine : ${d.purchase_order_reference}`,
    tiersTitre: "Fournisseur", tiersLignes: [d.supplier_name_snapshot, d.supplier_address_snapshot],
    lignes: mapLignesPdf(d.lines),
    totauxLignes: [["Total HT", d.total_ht], ["TVA", d.total_tva]], totalTtc: d.total_ttc, notes: d.notes,
  }), `facture-achat-${d.reference}`);
});

// --- Types de transactions (master data extensible, §5) ---
app.get("/api/types-transactions", auth, (req, res) => {
  const db = getDb();
  const { inactifs = "" } = req.query;
  const rows = db.prepare(`SELECT * FROM transaction_types ${inactifs === "1" ? "" : "WHERE is_active=1"} ORDER BY label`).all();
  res.json({ lignes: rows });
});
app.post("/api/types-transactions", auth, (req, res) => {
  try {
    const db = getDb();
    const r = db.prepare("INSERT INTO transaction_types (code,label,is_active) VALUES (?,?,?)")
      .run(req.body.code, req.body.label, req.body.is_active === 0 ? 0 : 1);
    res.status(201).json(db.prepare("SELECT * FROM transaction_types WHERE id=?").get(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
});
app.put("/api/types-transactions/:id", auth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE transaction_types SET code=?,label=?,is_active=?,updated_at=datetime('now') WHERE id=?")
    .run(req.body.code, req.body.label, req.body.is_active === 0 ? 0 : 1, req.params.id);
  res.json(db.prepare("SELECT * FROM transaction_types WHERE id=?").get(req.params.id));
});

// --- Encaissements reçus (Vos Voyage → Perfecto Booking, §3-§8) ---
app.get("/api/encaissements", auth, (req, res) => {
  res.json(Encaissements.list({ search: req.query.recherche || "", typeId: req.query.typeId || "",
    page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15) }));
});
app.get("/api/encaissements/totaux", auth, (req, res) => res.json(Encaissements.totals()));
app.post("/api/encaissements", auth, (req, res) => {
  try {
    res.status(201).json(Encaissements.create({
      dateTransaction: req.body.dateTransaction || null, montantHt: Number(req.body.montantHt),
      vatRateId: req.body.vatRateId ? Number(req.body.vatRateId) : null,
      tauxTva: req.body.tauxTva !== undefined ? Number(req.body.tauxTva) : undefined,
      typeId: Number(req.body.typeId), factureVenteId: req.body.factureVenteId ? Number(req.body.factureVenteId) : null,
      notes: req.body.notes || null,
    }, req.user.id));
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/encaissements/:id", auth, (req, res) => {
  const r = Encaissements.get(req.params.id);
  if (!r) return res.status(404).json({ erreur: "Encaissement introuvable" });
  res.json(r);
});
app.delete("/api/encaissements/:id", auth, (req, res) => {
  try { res.json(Encaissements.delete(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});

// --- Paiements fournisseurs (Vos Voyage → fournisseur, §9-§12) ---
app.get("/api/paiements", auth, (req, res) => {
  res.json(Paiements.list({ search: req.query.recherche || "", fournisseurId: req.query.fournisseurId || "",
    page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15) }));
});
app.get("/api/paiements/totaux", auth, (req, res) => res.json(Paiements.totals()));
app.get("/api/paiements/impayees", auth, (req, res) => {
  res.json({ lignes: Paiements.impayees(req.query.fournisseurId || null) });
});
app.post("/api/paiements", auth, (req, res) => {
  try {
    res.status(201).json(Paiements.create({
      datePaiement: req.body.datePaiement || null, fournisseurId: req.body.fournisseurId ? Number(req.body.fournisseurId) : null,
      factureAchatId: Number(req.body.factureAchatId), montantHt: Number(req.body.montantHt),
      vatRateId: req.body.vatRateId ? Number(req.body.vatRateId) : null,
      tauxTva: req.body.tauxTva !== undefined ? Number(req.body.tauxTva) : undefined,
      typeId: Number(req.body.typeId), notes: req.body.notes || null,
    }, req.user.id));
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/paiements/:id", auth, (req, res) => {
  const r = Paiements.get(req.params.id);
  if (!r) return res.status(404).json({ erreur: "Paiement introuvable" });
  res.json(r);
});
app.delete("/api/paiements/:id", auth, (req, res) => {
  try { res.json(Paiements.delete(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});

// --- Tableau de bord ---
app.get("/api/tableau-de-bord", auth, (req, res) => {
  const db = getDb();
  const s = (st) => db.prepare("SELECT COUNT(*) c, COALESCE(SUM(total_ttc),0) t, COALESCE(SUM(total_marge_notre_agence),0) m FROM projects WHERE status=?").get(st);
  const b = s("BROUILLON"), v = s("VALIDE");
  const recents = db.prepare(`SELECT p.*, c.name customer_name FROM projects p JOIN customers c ON c.id=p.customer_id ORDER BY p.updated_at DESC LIMIT 8`).all();
  res.json({ brouillon: b, valide: v, recents, finance: pilotageFinancier() });
});

// --- Pilotage : statistiques agrégées côté SQL (§14), filtres globaux ---
app.get("/api/tableau-de-bord/pilotage", auth, (req, res) => {
  try {
    res.json(pilotage({ debut: req.query.debut || null, fin: req.query.fin || null,
      clientId: req.query.clientId || null, fournisseurId: req.query.fournisseurId || null,
      categorieId: req.query.categorieId || null, statut: req.query.statut || "" }));
  } catch (e) { res.status(500).json({ erreur: "Calcul du pilotage impossible" }); }
});

function messageFr(e) {
  if (String(e.message).includes("UNIQUE")) {
    if (String(e.message).includes("customers")) return "Ce code client existe déjà";
    if (String(e.message).includes("suppliers")) return "Ce code fournisseur existe déjà";
    if (String(e.message).includes("articles")) return "Ce code article existe déjà";
    return "Cette référence existe déjà";
  }
  return "Enregistrement impossible, vérifiez les champs";
}

// SPA fallback
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(join(__dirname, "web", "index.html")));

app.listen(PORT, () => console.log(`ERP événementiel : http://localhost:${PORT} — compte directeur@agence.tn / Directeur123!`));
