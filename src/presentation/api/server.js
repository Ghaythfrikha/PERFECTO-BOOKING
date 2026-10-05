import express from "express";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, getDb } from "../../infrastructure/db/database.js";
import { Projects } from "../../application/projects.js";
import { confirmProject, getDoc, listDocs, transitionDoc, deleteDoc, getLinkedDocuments } from "../../application/documentFlow.js";
import { Encaissements, Paiements, pilotageFinancier } from "../../application/finance.js";
import { pilotage } from "../../application/dashboard.js";
import { genererPdf } from "../../documents/buildPdf.js";

dotenv.config();
await initDb();

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
const erreurServeur = (res, e) => res.status(500).json({ erreur: "Erreur interne : " + e.message });

// --- Auth ---
app.post("/api/auth/login", async (req, res) => {
  const { email, motDePasse } = req.body;
  if (!email || !motDePasse) return res.status(400).json({ erreur: "Email et mot de passe requis" });
  try {
    const db = getDb();
    const u = await db.get(`SELECT u.*, r.code role_code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.email=$1 AND u.is_active=1`, email);
    if (!u || !bcrypt.compareSync(motDePasse, u.password_hash))
      return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    res.json({ jeton: sign(u), utilisateur: { id: u.id, nom: u.full_name, email: u.email, role: u.role_code } });
  } catch (e) { erreurServeur(res, e); }
});
app.get("/api/auth/me", auth, (req, res) => res.json({ utilisateur: req.user }));

// --- Référentiels génériques (clients, fournisseurs, articles, tva) ---
function crud(table, map, searchCols) {
  const r = express.Router();
  const MAINTENANT = "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')";
  r.get("/", auth, async (req, res) => {
    try {
      const db = getDb();
      const { recherche = "", inactifs = "", page = 1, pageSize = 50 } = req.query;
      let w = "", params = [];
      if (recherche) {
        w = `WHERE (${searchCols.map((c, i) => `${c} LIKE $${i + 1}`).join(" OR ")})`;
        params = searchCols.map(() => `%${recherche}%`);
      }
      if (inactifs !== "1") { w += (w ? " AND " : "WHERE ") + "is_active=1"; }
      const total = (await db.get(`SELECT COUNT(*) c FROM ${table} ${w}`, ...params)).c;
      const rows = await db.all(`SELECT * FROM ${table} ${w} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
      res.json({ lignes: rows, total });
    } catch (e) { erreurServeur(res, e); }
  });
  r.post("/", auth, async (req, res) => {
    try {
      const db = getDb();
      const v = map(req.body);
      const keys = Object.keys(v);
      const row = await db.run(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
        ...keys.map((k) => v[k]));
      res.status(201).json(await db.get(`SELECT * FROM ${table} WHERE id=$1`, row.lastInsertRowid));
    } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
  });
  r.put("/:id", auth, async (req, res) => {
    try {
      const db = getDb();
      const v = map(req.body);
      const keys = Object.keys(v);
      await db.run(`UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(",")}, updated_at=${MAINTENANT} WHERE id=$${keys.length + 1}`,
        ...keys.map((k) => v[k]), req.params.id);
      res.json(await db.get(`SELECT * FROM ${table} WHERE id=$1`, req.params.id));
    } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
  });
  r.delete("/:id", auth, async (req, res) => {
    const db = getDb();
    try { await db.run(`DELETE FROM ${table} WHERE id=$1`, req.params.id); res.json({ ok: true }); }
    catch { // suppression douce si référencé
      await db.run(`UPDATE ${table} SET is_active=0 WHERE id=$1`, req.params.id);
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
app.get("/api/tva", auth, async (req, res) => {
  try { res.json({ lignes: await getDb().all("SELECT * FROM vat_rates ORDER BY rate") }); }
  catch (e) { erreurServeur(res, e); }
});
app.post("/api/tva", auth, async (req, res) => {
  try {
    const db = getDb();
    const r = await db.run("INSERT INTO vat_rates (code,label,rate,is_active) VALUES ($1,$2,$3,$4) RETURNING id",
      req.body.code, req.body.label, Number(req.body.rate), req.body.is_active === 0 ? 0 : 1);
    res.status(201).json(await db.get("SELECT * FROM vat_rates WHERE id=$1", r.lastInsertRowid));
  } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
});
app.put("/api/tva/:id", auth, async (req, res) => {
  try {
    const db = getDb();
    await db.run("UPDATE vat_rates SET code=$1,label=$2,rate=$3,is_active=$4 WHERE id=$5",
      req.body.code, req.body.label, Number(req.body.rate), req.body.is_active === 0 ? 0 : 1, req.params.id);
    res.json(await db.get("SELECT * FROM vat_rates WHERE id=$1", req.params.id));
  } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
});
app.get("/api/categories", auth, async (req, res) => {
  try { res.json({ lignes: await getDb().all("SELECT * FROM article_categories ORDER BY label") }); }
  catch (e) { erreurServeur(res, e); }
});

// --- Projets ---
app.get("/api/projets", auth, async (req, res) => {
  try {
    res.json(await Projects.list({ search: req.query.recherche || "", status: req.query.statut || "",
      page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15),
      sort: req.query.tri || "updated_at", dir: req.query.sens || "DESC" }));
  } catch (e) { erreurServeur(res, e); }
});
app.post("/api/projets", auth, async (req, res) => {
  try {
    const p = await Projects.create({ titre: req.body.titre, clientId: req.body.clientId,
      dateDebut: req.body.dateDebut || null, dateFin: req.body.dateFin || null, notes: req.body.notes || null }, req.user.id);
    res.status(201).json(p);
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/projets/:id", auth, async (req, res) => {
  try {
    const p = await Projects.get(req.params.id);
    if (!p) return res.status(404).json({ erreur: "Projet introuvable" });
    res.json(p);
  } catch (e) { erreurServeur(res, e); }
});
app.put("/api/projets/:id", auth, async (req, res) => {
  try { res.json(await Projects.updateHeader(req.params.id, req.body, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.delete("/api/projets/:id", auth, async (req, res) => {
  try { res.json(await Projects.delete(req.params.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/lignes", auth, async (req, res) => {
  try { res.status(201).json(await Projects.addLine(req.params.id, req.body, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.put("/api/projets/:id/lignes/:lid", auth, async (req, res) => {
  try { res.json(await Projects.updateLine(req.params.id, req.params.lid, req.body, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.delete("/api/projets/:id/lignes/:lid", auth, async (req, res) => {
  try { res.json(await Projects.removeLine(req.params.id, req.params.lid, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/valider", auth, async (req, res) => {
  try { res.json(await Projects.validate(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/annuler", auth, async (req, res) => {
  try { res.json(await Projects.cancel(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.post("/api/projets/:id/dupliquer", auth, async (req, res) => {
  try { res.status(201).json(await Projects.duplicate(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});

// --- Confirmation client (§56) : VERROUILLE + génère facture de vente et factures d'achat ---
app.post("/api/projets/:id/confirmer", auth, async (req, res) => {
  try {
    await confirmProject(req.params.id, req.user.id, req.body.note || null);
    res.json(await Projects.get(req.params.id));
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/projets/:id/documents", auth, async (req, res) => {
  try {
    const p = await Projects.get(req.params.id);
    if (!p) return res.status(404).json({ erreur: "Projet introuvable" });
    res.json({ devis: p.quote_reference || null, ...await getLinkedDocuments(req.params.id) });
  } catch (e) { erreurServeur(res, e); }
});

// --- Documents (commandes d'achat, factures) ---
function routesDocs(url, kind, action2) {
  app.get(url, auth, async (req, res) => {
    try {
      res.json(await listDocs(kind, { search: req.query.recherche || "", status: req.query.statut || "",
        page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15) }));
    } catch (e) { erreurServeur(res, e); }
  });
  app.get(`${url}/:id`, auth, async (req, res) => {
    try {
      const d = await getDoc(kind, req.params.id);
      if (!d) return res.status(404).json({ erreur: "Document introuvable" });
      res.json(d);
    } catch (e) { erreurServeur(res, e); }
  });
  app.post(`${url}/:id/valider`, auth, async (req, res) => {
    try { res.json(await transitionDoc(kind, req.params.id, "VALIDEE", req.user.id)); }
    catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
  });
  app.post(`${url}/:id/${action2}`, auth, async (req, res) => {
    try { res.json(await transitionDoc(kind, req.params.id, action2 === "cloturer" ? "CLOTUREE" : "ANNULEE", req.user.id)); }
    catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
  });
  app.delete(`${url}/:id`, auth, async (req, res) => {
    try { res.json(await deleteDoc(kind, req.params.id)); }
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
app.get("/api/projets/:id/devis/pdf", auth, async (req, res) => {
  try {
    const p = await Projects.get(req.params.id);
    if (!p) return res.status(404).json({ erreur: "Projet introuvable" });
    envoyerPdf(res, genererPdf({
      titre: "Devis", reference: p.quote_reference || p.reference, date: p.created_at, refProjet: p.reference,
      tiersTitre: "Client", tiersLignes: [p.customer_name_snapshot || p.customer_name],
      lignes: p.lines.map((l) => ({ designation: l.article_designation_snapshot || l.article_designation,
        description: l.description, quantity: l.quantity, unit: l.unit,
        unitPrice: l.prix_vente_notre_agence, tauxTva: l.taux_tva, totalHt: l.total_ht, totalTtc: l.total_ttc })),
      totauxLignes: [["Prix de vente HT", p.total_ht], ["TVA", p.total_tva]], totalTtc: p.total_ttc, notes: p.notes,
    }), `devis-${p.reference}`);
  } catch (e) { erreurServeur(res, e); }
});
app.get("/api/commandes-achat/:id/pdf", auth, async (req, res) => {
  try {
    const d = await getDoc("po", req.params.id);
    if (!d) return res.status(404).json({ erreur: "Document introuvable" });
    envoyerPdf(res, genererPdf({
      titre: "Commande d'achat", reference: d.reference, date: d.created_at, refProjet: d.project_reference,
      tiersTitre: "Fournisseur", tiersLignes: [d.supplier_name_snapshot, d.supplier_address_snapshot],
      lignes: mapLignesPdf(d.lines),
      totauxLignes: [["Total HT", d.subtotal_ht], ["TVA", d.total_tva]], totalTtc: d.total_ttc, notes: d.notes,
    }), `commande-${d.reference}`);
  } catch (e) { erreurServeur(res, e); }
});
app.get("/api/factures-vente/:id/pdf", auth, async (req, res) => {
  try {
    const d = await getDoc("si", req.params.id);
    if (!d) return res.status(404).json({ erreur: "Document introuvable" });
    envoyerPdf(res, genererPdf({
      titre: "Facture de vente", reference: d.reference, date: d.issue_date, refProjet: d.project_reference,
      tiersTitre: "Client", tiersLignes: [d.customer_name_snapshot, d.customer_address_snapshot],
      lignes: mapLignesPdf(d.lines),
      totauxLignes: [["Total HT", d.total_ht], ["TVA", d.total_tva]], totalTtc: d.total_ttc, notes: d.notes,
    }), `facture-vente-${d.reference}`);
  } catch (e) { erreurServeur(res, e); }
});
app.get("/api/factures-achat/:id/pdf", auth, async (req, res) => {
  try {
    const d = await getDoc("pi", req.params.id);
    if (!d) return res.status(404).json({ erreur: "Document introuvable" });
    envoyerPdf(res, genererPdf({
      titre: "Facture d'achat", reference: d.reference, date: d.issue_date, refProjet: d.project_reference,
      refExtra: `Commande d'origine : ${d.purchase_order_reference}`,
      tiersTitre: "Fournisseur", tiersLignes: [d.supplier_name_snapshot, d.supplier_address_snapshot],
      lignes: mapLignesPdf(d.lines),
      totauxLignes: [["Total HT", d.total_ht], ["TVA", d.total_tva]], totalTtc: d.total_ttc, notes: d.notes,
    }), `facture-achat-${d.reference}`);
  } catch (e) { erreurServeur(res, e); }
});

// --- Types de transactions (master data extensible, §5) ---
app.get("/api/types-transactions", auth, async (req, res) => {
  try {
    const db = getDb();
    const { inactifs = "" } = req.query;
    const rows = await db.all(`SELECT * FROM transaction_types ${inactifs === "1" ? "" : "WHERE is_active=1"} ORDER BY label`);
    res.json({ lignes: rows });
  } catch (e) { erreurServeur(res, e); }
});
app.post("/api/types-transactions", auth, async (req, res) => {
  try {
    const db = getDb();
    const r = await db.run("INSERT INTO transaction_types (code,label,is_active) VALUES ($1,$2,$3) RETURNING id",
      req.body.code, req.body.label, req.body.is_active === 0 ? 0 : 1);
    res.status(201).json(await db.get("SELECT * FROM transaction_types WHERE id=$1", r.lastInsertRowid));
  } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
});
app.put("/api/types-transactions/:id", auth, async (req, res) => {
  try {
    const db = getDb();
    await db.run("UPDATE transaction_types SET code=$1,label=$2,is_active=$3,updated_at=to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE id=$4",
      req.body.code, req.body.label, req.body.is_active === 0 ? 0 : 1, req.params.id);
    res.json(await db.get("SELECT * FROM transaction_types WHERE id=$1", req.params.id));
  } catch (e) { res.status(400).json({ erreur: messageFr(e) }); }
});

// --- Encaissements reçus (Vos Voyage → Perfecto Booking, §3-§8) ---
app.get("/api/encaissements", auth, async (req, res) => {
  try {
    res.json(await Encaissements.list({ search: req.query.recherche || "", typeId: req.query.typeId || "",
      page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15) }));
  } catch (e) { erreurServeur(res, e); }
});
app.get("/api/encaissements/totaux", auth, async (req, res) => {
  try { res.json(await Encaissements.totals()); }
  catch (e) { erreurServeur(res, e); }
});
app.post("/api/encaissements", auth, async (req, res) => {
  try {
    res.status(201).json(await Encaissements.create({
      dateTransaction: req.body.dateTransaction || null, montantHt: Number(req.body.montantHt),
      vatRateId: req.body.vatRateId ? Number(req.body.vatRateId) : null,
      tauxTva: req.body.tauxTva !== undefined ? Number(req.body.tauxTva) : undefined,
      typeId: Number(req.body.typeId), factureVenteId: req.body.factureVenteId ? Number(req.body.factureVenteId) : null,
      notes: req.body.notes || null,
    }, req.user.id));
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/encaissements/:id", auth, async (req, res) => {
  try {
    const r = await Encaissements.get(req.params.id);
    if (!r) return res.status(404).json({ erreur: "Encaissement introuvable" });
    res.json(r);
  } catch (e) { erreurServeur(res, e); }
});
app.delete("/api/encaissements/:id", auth, async (req, res) => {
  try { res.json(await Encaissements.delete(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});

// --- Paiements fournisseurs (Vos Voyage → fournisseur, §9-§12) ---
app.get("/api/paiements", auth, async (req, res) => {
  try {
    res.json(await Paiements.list({ search: req.query.recherche || "", fournisseurId: req.query.fournisseurId || "",
      page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 15) }));
  } catch (e) { erreurServeur(res, e); }
});
app.get("/api/paiements/totaux", auth, async (req, res) => {
  try { res.json(await Paiements.totals()); }
  catch (e) { erreurServeur(res, e); }
});
app.get("/api/paiements/impayees", auth, async (req, res) => {
  try { res.json({ lignes: await Paiements.impayees(req.query.fournisseurId || null) }); }
  catch (e) { erreurServeur(res, e); }
});
app.post("/api/paiements", auth, async (req, res) => {
  try {
    res.status(201).json(await Paiements.create({
      datePaiement: req.body.datePaiement || null, fournisseurId: req.body.fournisseurId ? Number(req.body.fournisseurId) : null,
      factureAchatId: Number(req.body.factureAchatId), montantHt: Number(req.body.montantHt),
      vatRateId: req.body.vatRateId ? Number(req.body.vatRateId) : null,
      tauxTva: req.body.tauxTva !== undefined ? Number(req.body.tauxTva) : undefined,
      typeId: Number(req.body.typeId), notes: req.body.notes || null,
    }, req.user.id));
  } catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});
app.get("/api/paiements/:id", auth, async (req, res) => {
  try {
    const r = await Paiements.get(req.params.id);
    if (!r) return res.status(404).json({ erreur: "Paiement introuvable" });
    res.json(r);
  } catch (e) { erreurServeur(res, e); }
});
app.delete("/api/paiements/:id", auth, async (req, res) => {
  try { res.json(await Paiements.delete(req.params.id, req.user.id)); }
  catch (e) { res.status(e.status || 400).json({ erreur: e.message }); }
});

// --- Tableau de bord ---
app.get("/api/tableau-de-bord", auth, async (req, res) => {
  try {
    const db = getDb();
    const s = async (st) => await db.get("SELECT COUNT(*) c, COALESCE(SUM(total_ttc),0) t, COALESCE(SUM(total_marge_notre_agence),0) m FROM projects WHERE status=$1", st);
    const b = await s("BROUILLON"), v = await s("VALIDE");
    const recents = await db.all(`SELECT p.*, c.name customer_name FROM projects p JOIN customers c ON c.id=p.customer_id ORDER BY p.updated_at DESC LIMIT 8`);
    res.json({ brouillon: b, valide: v, recents, finance: await pilotageFinancier() });
  } catch (e) { erreurServeur(res, e); }
});

// --- Pilotage : statistiques agrégées côté SQL (§14), filtres globaux ---
app.get("/api/tableau-de-bord/pilotage", auth, async (req, res) => {
  try {
    res.json(await pilotage({ debut: req.query.debut || null, fin: req.query.fin || null,
      clientId: req.query.clientId || null, fournisseurId: req.query.fournisseurId || null,
      categorieId: req.query.categorieId || null, statut: req.query.statut || "" }));
  } catch (e) { res.status(500).json({ erreur: "Calcul du pilotage impossible" }); }
});

function messageFr(e) {
  const msg = String(e.message);
  if (msg.includes("UNIQUE") || msg.includes("duplicate key") || msg.includes("unique constraint")) {
    if (msg.includes("customers")) return "Ce code client existe déjà";
    if (msg.includes("suppliers")) return "Ce code fournisseur existe déjà";
    if (msg.includes("articles")) return "Ce code article existe déjà";
    return "Cette référence existe déjà";
  }
  return "Enregistrement impossible, vérifiez les champs";
}

// SPA fallback
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(join(__dirname, "web", "index.html")));

export default app;

// Local / Render : serveur Node persistant. Sur Vercel (VERCEL=1, positionné
// automatiquement), l'app est importée par api/index.js et servie en
// serverless : pas de listen() dans ce cas.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`ERP événementiel : http://localhost:${PORT} — compte directeur@agence.tn / Directeur123!`));
}
