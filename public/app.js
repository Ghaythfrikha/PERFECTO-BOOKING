/* ERP Événementiel — présentation (FR). Le backend recalcule tout : l'aperçu ici n'est qu'un confort UX. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const etat = { jeton: localStorage.getItem("erp_jeton"), vue: "tableau-de-bord", params: {}, selection: null };
const STATUTS = { BROUILLON: "Brouillon", VALIDE: "Validé", ANNULE: "Annulé" };
const STATUT_DOC = { BROUILLON: "Brouillon", VALIDEE: "Validée", CLOTUREE: "Clôturée", ANNULEE: "Annulée" };
const DOCS = {
  po: { url: "/api/commandes-achat", titre: "Commande d'achat", acte2: ["cloturer", "Clôturer"] },
  si: { url: "/api/factures-vente", titre: "Facture de vente", acte2: ["annuler", "Annuler"] },
  pi: { url: "/api/factures-achat", titre: "Facture d'achat", acte2: ["annuler", "Annuler"] },
};
async function telechargerPdf(url) {
  const r = await fetch(url, { headers: etat.jeton ? { Authorization: "Bearer " + etat.jeton } : {} });
  if (!r.ok) throw new Error("Génération PDF impossible");
  const blob = await r.blob();
  window.open(URL.createObjectURL(blob), "_blank");
}
// Actions possibles selon le statut documentaire (§59) : jamais d'action impossible affichée.
function actionsDoc(kind, d) {
  const a = [["voir", "Voir"], ["pdf", "PDF"]];
  if (d.status === "BROUILLON") a.push(["valider", "Valider"], ["supprimer", "Supprimer"]);
  else if (d.status === "VALIDEE") a.push([DOCS[kind].acte2[0], DOCS[kind].acte2[1]]);
  return `<span class="menu"><button data-menu>⋮</button><span class="liste">${a
    .map(([act, lib]) => `<button data-dact="${act}" data-dkind="${kind}" data-did="${d.id}" class="${act === "supprimer" || act === "annuler" ? "danger" : ""}">${lib}</button>`).join("")}</span></span>`;
}
function brancherActionsDocs(c, rafraichir) {
  brancherMenus(c);
  $$("[data-dact]", c).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    fermerMenuFlottant();
    const kind = b.dataset.dkind, id = b.dataset.did, act = b.dataset.dact;
    const url = DOCS[kind].url;
    try {
      if (act === "voir") voirDocument(kind, id, rafraichir);
      else if (act === "pdf") await telechargerPdf(`${url}/${id}/pdf`);
      else if (act === "valider") {
        if (!confirm(`Valider ce document ${DOCS[kind].titre.toLowerCase()} ?`)) return;
        await api(`${url}/${id}/valider`, { method: "POST" }); toast("Document validé"); rafraichir();
      } else if (act === "cloturer" || act === "annuler") {
        if (!confirm("Confirmer cette opération ?")) return;
        await api(`${url}/${id}/${act}`, { method: "POST" }); toast("Opération enregistrée"); rafraichir();
      } else if (act === "supprimer") {
        if (!confirm("Supprimer ce brouillon ? Un document validé ne peut pas être supprimé.")) return;
        await api(`${url}/${id}`, { method: "DELETE" }); toast("Brouillon supprimé"); rafraichir();
      }
    } catch (err) { toast(err.message, true); }
  }));
}
// Fiche document : snapshots historiques, lignes, totaux, traçabilité vers le projet.
async function voirDocument(kind, id, apres) {
  const cfg = DOCS[kind];
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<div class="dialogue" style="max-width:760px"><div class="card-h"><h2>Chargement…</h2></div></div>`;
  document.body.appendChild(fond);
  const rendre = async () => {
    let d;
    try { d = await api(`${cfg.url}/${id}`); }
    catch (e) { fond.querySelector(".dialogue").innerHTML = `<div class="card-b"><p class="erreur">${esc(e.message)}</p></div>`; return; }
    const tiers = d.supplier_name_snapshot || d.customer_name_snapshot || "—";
    const adresse = d.supplier_address_snapshot || d.customer_address_snapshot || "";
    const ht = d.subtotal_ht ?? d.total_ht;
    fond.querySelector(".dialogue").innerHTML = `<div class="card-h"><h2>${cfg.titre} ${d.reference}</h2>
      <span class="badge ${d.status}">${STATUT_DOC[d.status]}</span></div><div class="card-b">
      <div class="grid3"><div><div class="hint">Projet d'origine</div><b>${esc(d.project_reference)}</b></div>
      <div><div class="hint">${d.supplier_name_snapshot ? "Fournisseur" : "Client"}</div><b>${esc(tiers)}</b>${adresse ? `<br><span class="hint">${esc(adresse)}</span>` : ""}</div>
      <div><div class="hint">Date</div><b>${(d.issue_date || d.created_at || "").slice(0, 10)}</b></div></div>
      ${d.purchase_order_reference ? `<p class="hint">Commande d'origine : ${esc(d.purchase_order_reference)}</p>` : ""}
      <div class="tablewrap"><table><thead><tr><th>Prestation</th><th class="num">Qté</th><th class="num">P.U. HT</th><th>TVA</th><th class="num">Montant HT</th><th class="num">TTC</th></tr></thead>
      <tbody>${d.lines.map((l) => `<tr><td><b>${esc(l.article_designation_snapshot)}</b>${l.description ? `<br><span class="hint">${esc(l.description)}</span>` : ""}</td>
      <td class="num">${l.quantity} ${esc(l.unit || "")}</td><td class="num">${fmt(l.unit_price)}</td><td>${l.taux_tva} %</td>
      <td class="num">${fmt(l.total_ht)}</td><td class="num"><b>${fmt(l.total_ttc)}</b></td></tr>`).join("")}</tbody></table></div>
      <dl class="synth" style="margin-top:12px"><dt>Total HT</dt><dd>${fmt(ht)}</dd><dt>TVA</dt><dd>${fmt(d.total_tva)}</dd>
      <div class="total" style="display:contents"><dt>Total TTC</dt><dd>${fmt(d.total_ttc)}</dd></div></dl>
      ${d.finance ? `<dl class="synth" style="margin-top:8px"><dt>${kind === "si" ? "Montant reçu" : "Montant payé"}</dt><dd>${fmt(d.finance.totalRegle)}</dd>
      <dt>${kind === "si" ? "Reste à recevoir" : "Reste à payer"}</dt><dd>${fmt(d.finance.reste)}</dd>
      <dt>Statut règlement</dt><dd>${{ NON_PAYE: kind === "si" ? "Non reçu" : "Non payée", PARTIEL: kind === "si" ? "Partiellement reçu" : "Partiellement payée", TOTAL: kind === "si" ? "Totalement reçu" : "Totalement payée" }[d.finance.statut]}</dd></dl>
      <p class="hint">Facturé ≠ ${kind === "si" ? "reçu" : "payé"} : soldes calculés depuis les mouvements réels.</p>` : ""}
      <div class="toolbar" style="margin-top:12px" id="acts"></div>
      <div class="toolbar" style="margin-top:8px"><button class="btn" id="x">Fermer</button></div></div>`;
    const acts = $("#x", fond).parentElement.previousElementSibling;
    const btn = (lib, cls, fn) => { const x = document.createElement("button"); x.className = "btn " + cls; x.textContent = lib; x.onclick = fn; acts.appendChild(x); };
    btn("PDF", "", () => telechargerPdf(`${cfg.url}/${id}/pdf`).catch((e) => toast(e.message, true)));
    if (d.status === "BROUILLON") {
      btn("Valider", "succes", async () => { if (!confirm("Valider ce document ?")) return;
        try { await api(`${cfg.url}/${id}/valider`, { method: "POST" }); toast("Document validé"); rendre(); apres && apres(); }
        catch (e) { toast(e.message, true); } });
      btn("Supprimer", "danger", async () => { if (!confirm("Supprimer ce brouillon ?")) return;
        try { await api(`${cfg.url}/${id}`, { method: "DELETE" }); fond.remove(); toast("Brouillon supprimé"); apres && apres(); }
        catch (e) { toast(e.message, true); } });
    } else if (d.status === "VALIDEE") {
      btn(cfg.acte2[1], "", async () => { if (!confirm("Confirmer cette opération ?")) return;
        try { await api(`${cfg.url}/${id}/${cfg.acte2[0]}`, { method: "POST" }); toast("Opération enregistrée"); rendre(); apres && apres(); }
        catch (e) { toast(e.message, true); } });
    }
    $("#x", fond).onclick = () => fond.remove();
  };
  await rendre();
}

function fmt(n) {
  return (Number(n) || 0).toLocaleString("fr-TN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + " DT";
}
function toast(msg, erreur = false) {
  const d = document.createElement("div");
  if (erreur) d.className = "erreur";
  d.textContent = msg;
  $("#toasts").appendChild(d);
  setTimeout(() => d.remove(), 4200);
}
async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(etat.jeton ? { Authorization: "Bearer " + etat.jeton } : {}), ...(options.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { deconnecter(); throw new Error("Session expirée"); }
  if (!r.ok) throw new Error(data.erreur || "Erreur inattendue");
  return data;
}
function deconnecter() { localStorage.removeItem("erp_jeton"); etat.jeton = null; afficher(); }

// Aperçu local (mêmes formules que le domaine — backend autoritatif)
function appliquerMajoration(base, type, valeur) {
  if (type === "MONTANT_FIXE") return Math.round((base + valeur) * 1000) / 1000;
  return Math.round(base * (1 + valeur / 100) * 1000) / 1000;
}
function apercuLigne(l) {
  const pa = Number(l.prixAchatGrandeAgence) || 0;
  const achat = appliquerMajoration(pa, l.typeMargeGrandeAgence, Number(l.valeurMargeGrandeAgence) || 0);
  const vente = appliquerMajoration(achat, l.typeMargeNotreAgence, Number(l.valeurMargeNotreAgence) || 0);
  return { achat, vente };
}

function afficher() {
  const racine = $("#racine");
  if (!etat.jeton) return vueConnexion(racine);
  // Navigation groupée (§19) : Pilotage / Ventes / Achats / Finance / Référentiels / Système.
  const GROUPES = [
    ["Pilotage", [["tableau-de-bord", "Tableau de bord", null]]],
    ["Ventes", [["projets", "Projets", null], ["factures", "Factures de vente", "vente"]]],
    ["Achats", [["commandes", "Commandes d'achat", null], ["factures", "Factures d'achat", "achat"], ["paiements", "Paiements fournisseurs", null]]],
    ["Finance", [["encaissements", "Encaissements reçus", null], ["types-transactions", "Types de transactions", null]]],
    ["Référentiels", [["clients", "Clients", null], ["fournisseurs", "Fournisseurs", null], ["articles", "Articles / Prestations", null], ["tva", "TVA", null]]],
    ["Système", [["parametres", "Paramètres", null]]],
  ];
  racine.innerHTML = `<div class="app">
    <aside class="sidebar"><div class="brand"><b>ERP Événementiel</b><span>Agence — usage interne</span></div>
      <nav class="nav">${GROUPES.map(([g, items]) => `<div class="groupe">${g}</div>` + items.map(([v, l, o]) =>
        `<button data-vue="${v}" data-onglet="${o || ""}" class="${etat.vue === v && (o == null || etat.params.onglet === o) ? "actif" : ""}">${l}</button>`).join("")).join("")}</nav>
      <div class="userbox"><div id="qui"></div><button class="btn petit" id="btn-sortie">Se déconnecter</button></div>
    </aside>
    <div class="main"><div class="topbar"><button class="btn petit burger" id="btn-menu">☰</button><h1 id="titre"></h1></div>
      <div class="content" id="contenu"></div></div></div>`;
  $$(".nav button", racine).forEach((b) => (b.onclick = () => {
    etat.vue = b.dataset.vue;
    etat.params = b.dataset.onglet ? { onglet: b.dataset.onglet } : {};
    afficher(); document.body.classList.remove("menu-ouvert");
  }));
  $("#btn-sortie").onclick = deconnecter;
  $("#btn-menu").onclick = () => document.body.classList.toggle("menu-ouvert");
  api("/api/auth/me").then((d) => { $("#qui").textContent = d.utilisateur.name + " — " + d.utilisateur.role; }).catch(() => {});
  const c = $("#contenu"), t = $("#titre");
  ({ "tableau-de-bord": [vTableauDeBord, "Tableau de bord"], projets: [vProjets, "Projets"],
    projet: [vProjet, "Projet / Devis"], commandes: [vCommandes, "Commandes d'achat"], factures: [vFactures, "Factures"],
    encaissements: [vEncaissements, "Encaissements"], paiements: [vPaiements, "Paiements"],
    "types-transactions": [vTypesTransactions, "Types de transactions"],
    clients: [() => vRef("clients", "Clients"), "Clients"],
    fournisseurs: [() => vRef("fournisseurs", "Fournisseurs"), "Fournisseurs"],
    articles: [vArticles, "Articles / Prestations"], tva: [vTva, "Taux de TVA"], parametres: [vParametres, "Paramètres"] }[etat.vue] || [vTableauDeBord, ""])[0](c);
  const TITRES = { "tableau-de-bord": "Tableau de bord", projets: "Projets", projet: "Projet / Devis", commandes: "Commandes d'achat", clients: "Clients", fournisseurs: "Fournisseurs", articles: "Articles / Prestations", tva: "Taux de TVA", parametres: "Paramètres", encaissements: "Encaissements reçus", paiements: "Paiements fournisseurs", "types-transactions": "Types de transactions" };
  t.textContent = etat.vue === "factures" ? (etat.params.onglet === "achat" ? "Factures d'achat" : "Factures de vente") : (TITRES[etat.vue] || "");
}

// --- Connexion ---
function vueConnexion(racine) {
  racine.innerHTML = `<div class="login-wrap"><form class="login" id="f">
    <h1>ERP Événementiel</h1><p>Connectez-vous pour accéder à la gestion des projets.</p>
    <label class="champ">Email<input name="email" value="directeur@agence.tn" required></label><br>
    <label class="champ">Mot de passe<input name="motDePasse" type="password" required></label><br>
    <button class="btn primaire" style="width:100%;justify-content:center">Se connecter</button>
    <p class="hint">Compte PoC : directeur@agence.tn / Directeur123!</p><p class="erreur" id="e"></p></form></div>`;
  $("#f").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const fd = new FormData(ev.target);
      const d = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: fd.get("email"), motDePasse: fd.get("motDePasse") }) });
      localStorage.setItem("erp_jeton", d.jeton); etat.jeton = d.jeton; etat.vue = "tableau-de-bord"; afficher();
    } catch (e) { $("#e").textContent = e.message; }
  };
}

// --- Tableau de bord : pilotage directeur, données réelles uniquement ---
function allerVue(vue, params) { etat.vue = vue; etat.params = params || {}; afficher(); }
function fmtMois(k) { return k.slice(5, 7) + "/" + k.slice(2, 4); }
function periodePredefinie(code) {
  const j = (d) => d.toISOString().slice(0, 10);
  const t = new Date();
  const premJour = new Date(t.getFullYear(), t.getMonth(), 1);
  if (code === "annee") return { debut: `${t.getFullYear()}-01-01`, fin: j(t) };
  if (code === "trimestre") { const q = Math.floor(t.getMonth() / 3) * 3; return { debut: j(new Date(t.getFullYear(), q, 1)), fin: j(t) }; }
  if (code === "mois") return { debut: j(premJour), fin: j(t) };
  if (code === "mois-prec") { const d = new Date(t.getFullYear(), t.getMonth() - 1, 1); return { debut: j(d), fin: j(new Date(t.getFullYear(), t.getMonth(), 0)) }; }
  if (code === "semaine") { const d = new Date(t); d.setDate(t.getDate() - 6); return { debut: j(d), fin: j(t) }; }
  if (code === "jour") return { debut: j(t), fin: j(t) };
  return { debut: null, fin: null };
}
// Courbe SVG sobre (3 séries max) — pas de librairie, montants HT.
function courbeCA(data) {
  const W = 620, H = 200, P = 34;
  const max = Math.max(1, ...data.flatMap((d) => [d.vendu, d.facture, d.recu]));
  const X = (i) => P + (i * (W - 2 * P)) / Math.max(1, data.length - 1);
  const Y = (v) => H - 22 - ((v / max) * (H - 60));
  const serie = (k, couleur) => `<polyline fill="none" stroke="${couleur}" stroke-width="2" points="${data.map((d, i) => `${X(i).toFixed(1)},${Y(d[k]).toFixed(1)}`).join(" ")}"/>` +
    data.map((d, i) => `<circle cx="${X(i)}" cy="${Y(d[k])}" r="2.5" fill="${couleur}"><title>${fmtMois(d.mois)} : ${fmt(d[k])}</title></circle>`).join("");
  const labels = data.map((d, i) => (i % Math.ceil(data.length / 6) === 0 || data.length <= 6)
    ? `<text x="${X(i)}" y="${H - 6}" font-size="9" fill="#5d6b80" text-anchor="middle">${fmtMois(d.mois)}</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Évolution du chiffre d'affaires">
    ${[0.25, 0.5, 0.75, 1].map((f) => `<line x1="${P}" x2="${W - 8}" y1="${Y(max * f)}" y2="${Y(max * f)}" stroke="#e3e9f0" stroke-width="1"/>`).join("")}
    ${serie("vendu", "#1b4f72")}${serie("facture", "#1e7e46")}${serie("recu", "#9a6b0f")}${labels}</svg>
    <div class="legende"><span><i style="background:#1b4f72"></i>CA vendu</span><span><i style="background:#1e7e46"></i>CA facturé</span><span><i style="background:#9a6b0f"></i>CA reçu</span></div>`;
}
async function vTableauDeBord(c) {
  const F = { periode: "annee", debut: null, fin: null, clientId: "", fournisseurId: "", categorieId: "", statut: "" };
  c.innerHTML = `<div class="card"><div class="card-h"><h2>Filtres</h2><span class="hint">Période, client, fournisseur, prestation, statut</span></div>
    <div class="card-b"><div class="toolbar">
      <select id="f-periode"><option value="annee">Cette année</option><option value="trimestre">Ce trimestre</option><option value="mois">Ce mois</option><option value="mois-prec">Mois précédent</option><option value="semaine">7 derniers jours</option><option value="jour">Aujourd'hui</option><option value="perso">Période personnalisée</option><option value="tout">Toute période</option></select>
      <input id="f-debut" type="date" style="display:none"><input id="f-fin" type="date" style="display:none">
      <select id="f-client"><option value="">Tous clients</option></select>
      <select id="f-fournisseur"><option value="">Tous fournisseurs</option></select>
      <select id="f-categorie"><option value="">Toutes prestations</option></select>
      <select id="f-statut"><option value="">Tous statuts</option><option value="BROUILLON">Brouillon</option><option value="VALIDE">Validé</option><option value="ANNULE">Annulé</option></select>
      <button class="btn primaire" id="f-ok">Appliquer</button></div></div></div>
    <div class="kpis" id="k"></div>
    <div class="grid2"><div class="card"><div class="card-h"><h2>CA par mois (HT)</h2></div><div class="card-b" id="ca"></div></div>
    <div class="card"><div class="card-h"><h2>Situation des projets</h2><button class="btn petit" id="v-projets">Tous les projets</button></div><div class="card-b" id="sit-p"></div></div></div>
    <div class="grid2"><div class="card"><div class="card-h"><h2>Factures d'achat</h2><button class="btn petit" id="v-fa">Voir les factures</button></div><div class="card-b" id="sit-fa"></div></div>
    <div class="card"><div class="card-h"><h2>Alertes / actions requises</h2></div><div class="card-b" id="alertes"></div></div></div>
    <div class="grid2"><div class="card"><div class="card-h"><h2>Top fournisseurs</h2></div><div class="card-b" id="top-f"></div></div>
    <div class="card"><div class="card-h"><h2>Top clients</h2></div><div class="card-b" id="top-c"></div></div></div>
    <div class="grid2"><div class="card"><div class="card-h"><h2>CA par type de prestation (HT)</h2></div><div class="card-b" id="ca-cat"></div></div>
    <div class="card"><div class="card-h"><h2>Rentabilité par projet</h2><span class="hint" id="renta-tot"></span></div><div class="card-b" id="renta"></div></div></div>
    <div class="card"><div class="card-h"><h2>Activité récente</h2></div><div class="card-b" id="acti"></div></div>`;
  try {
    const [clients, frns, cats] = await Promise.all([
      api("/api/clients?pageSize=200").catch(() => ({ lignes: [] })),
      api("/api/fournisseurs?pageSize=200").catch(() => ({ lignes: [] })),
      api("/api/categories").catch(() => ({ lignes: [] })),
    ]);
    $("#f-client").innerHTML += clients.lignes.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
    $("#f-fournisseur").innerHTML += frns.lignes.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
    $("#f-categorie").innerHTML += cats.lignes.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join("");
  } catch { /* filtres optionnels */ }
  $("#f-periode").onchange = (e) => {
    const perso = e.target.value === "perso";
    $("#f-debut").style.display = perso ? "" : "none";
    $("#f-fin").style.display = perso ? "" : "none";
  };
  const charger = async () => {
    F.periode = $("#f-periode").value;
    const pp = periodePredefinie(F.periode);
    F.debut = F.periode === "perso" ? $("#f-debut").value || null : pp.debut;
    F.fin = F.periode === "perso" ? $("#f-fin").value || null : pp.fin;
    F.clientId = $("#f-client").value; F.fournisseurId = $("#f-fournisseur").value;
    F.categorieId = $("#f-categorie").value; F.statut = $("#f-statut").value;
    const q = new URLSearchParams({ ...(F.debut ? { debut: F.debut } : {}), ...(F.fin ? { fin: F.fin } : {}),
      ...(F.clientId ? { clientId: F.clientId } : {}), ...(F.fournisseurId ? { fournisseurId: F.fournisseurId } : {}),
      ...(F.categorieId ? { categorieId: F.categorieId } : {}), ...(F.statut ? { statut: F.statut } : {}) }).toString();
    const d = await api(`/api/tableau-de-bord/pilotage?${q}`);
    // KPI : vendu / facturé / reçu + achats (données réelles, même source que les listes)
    const totV = d.caMensuel.reduce((t, m) => t + m.vendu, 0), totF = d.caMensuel.reduce((t, m) => t + m.facture, 0), totR = d.caMensuel.reduce((t, m) => t + m.recu, 0);
    $("#k").innerHTML = `<div class="kpi"><div class="v">${fmt(totV)}</div><div class="l">CA vendu HT (période)</div></div>
      <div class="kpi"><div class="v">${fmt(totF)}</div><div class="l">CA facturé HT</div></div>
      <div class="kpi"><div class="v">${fmt(totR)}</div><div class="l">CA reçu HT</div></div>
      <div class="kpi"><div class="v">${fmt(d.facturesAchat.reste)}</div><div class="l">Reste à payer (achats)</div></div>`;
    $("#ca").innerHTML = d.caMensuel.some((m) => m.vendu || m.facture || m.recu) ? courbeCA(d.caMensuel)
      : `<div class="vide"><b>Aucune activité sur la période</b>Modifiez les filtres.</div>`;
    const p = d.projets;
    $("#sit-p").innerHTML = `<div class="grid3">
      <div class="kpi"><div class="v">${p.BROUILLON}</div><div class="l">Brouillons</div></div>
      <div class="kpi"><div class="v">${p.VALIDE}</div><div class="l">Validés</div></div>
      <div class="kpi"><div class="v">${p.ANNULE}</div><div class="l">Annulés</div></div></div>
      ${p.brouillons.length ? `<div class="tablewrap"><table><thead><tr><th>Référence</th><th>Projet</th><th class="num">Total TTC</th><th></th></tr></thead><tbody>
      ${p.brouillons.map((b) => `<tr><td><b>${b.reference}</b></td><td>${esc(b.title)}${b.nb_lignes === 0 ? ' <span class="badge ANNULE">Sans prestation</span>' : ""}</td>
      <td class="num">${fmt(b.total_ttc)}</td><td class="actions"><button class="btn petit" data-ouvrir-projet="${b.id}">Ouvrir</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">Aucun brouillon sur la période.</p>`}
      ${p.margesNegatives.length ? `<p class="erreur">Marges négatives : ${p.margesNegatives.map((m) => m.reference).join(", ")}</p>` : ""}`;
    const fa = d.facturesAchat;
    $("#sit-fa").innerHTML = `<dl class="synth"><dt>Total facturé TTC</dt><dd>${fmt(fa.totalTtc)}</dd><dt>Payé</dt><dd>${fmt(fa.paye)}</dd>
      <dt>Reste à payer</dt><dd>${fmt(fa.reste)}</dd></dl>
      <p class="hint">Non payées : <b>${fa.nonPayees}</b> · Partiellement payées : <b>${fa.partielles}</b> · Soldées : <b>${fa.soldees}</b></p>
      ${fa.surveiller.length ? `<div class="tablewrap"><table><thead><tr><th>Facture</th><th>Fournisseur</th><th class="num">Reste</th><th></th></tr></thead><tbody>
      ${fa.surveiller.slice(0, 5).map((x) => `<tr><td><b>${x.reference}</b></td><td>${esc(x.fournisseur)}</td><td class="num"><b>${fmt(x.reste)}</b></td>
      <td class="actions"><button class="btn petit" data-voir-fa="${x.id}">Voir</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">Aucune facture à surveiller.</p>`}`;
    $("#alertes").innerHTML = d.alertes.length ? d.alertes.map((a) => `<div class="alerte ${a.niveau}">
      <div><b>${esc(a.libelle)}</b><br><span class="hint">${esc(a.detail || "")}</span></div>
      <button class="btn petit" data-alerte='${esc(JSON.stringify(a.cible))}'>Ouvrir</button></div>`).join("")
      : `<div class="vide"><b>Rien à signaler</b>Aucune action requise.</div>`;
    $("#top-f").innerHTML = d.topFournisseurs.length ? `<div class="tablewrap"><table><thead><tr><th>Fournisseur</th><th class="num">Achats TTC</th><th class="num">Reste</th></tr></thead><tbody>
      ${d.topFournisseurs.map((t) => `<tr><td>${esc(t.nom)}</td><td class="num"><b>${fmt(t.total)}</b></td><td class="num">${fmt(t.reste)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="vide"><b>Aucun achat</b></div>`;
    $("#top-c").innerHTML = d.topClients.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th class="num">CA vendu</th><th class="num">CA facturé</th></tr></thead><tbody>
      ${d.topClients.map((t) => `<tr><td>${esc(t.nom)}</td><td class="num"><b>${fmt(t.vendu)}</b></td><td class="num">${fmt(t.facture)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="vide"><b>Aucun client</b></div>`;
    const maxCat = Math.max(1, ...d.caParCategorie.map((x) => x.ht));
    $("#ca-cat").innerHTML = d.caParCategorie.length ? d.caParCategorie.map((x) => `<div class="barre">
      <div class="barre-l">${esc(x.categorie)} <span class="hint">${x.part} %</span></div>
      <div class="barre-f"><div class="barre-v" style="width:${Math.max(2, (x.ht / maxCat) * 100)}%"></div></div>
      <div class="num"><b>${fmt(x.ht)}</b></div></div>`).join("") : `<div class="vide"><b>Aucune donnée</b></div>`;
    $("#renta-tot").textContent = `Marge totale : ${fmt(d.rentabilite.totalMarge)} (CA − coût, montants)`;
    $("#renta").innerHTML = `${d.rentabilite.top.length ? `<div class="tablewrap"><table><thead><tr><th>Projet</th><th class="num">CA HT</th><th class="num">Coût</th><th class="num">Marge</th><th></th></tr></thead><tbody>
      ${d.rentabilite.top.map((r) => `<tr><td><b>${r.reference}</b><br><span class="hint">${esc(r.client)}</span></td>
      <td class="num">${fmt(r.ca)}</td><td class="num">${fmt(r.cout)}</td><td class="num"><b>${fmt(r.marge)}</b></td>
      <td class="actions"><button class="btn petit" data-ouvrir-projet="${r.id}">Ouvrir</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">Aucun projet validé.</p>`}
      ${d.rentabilite.surveiller.length ? `<p class="erreur">À surveiller (marge négative) : ${d.rentabilite.surveiller.map((r) => r.reference).join(", ")}</p>` : ""}`;
    $("#acti").innerHTML = d.activite.length ? d.activite.map((a) => `<div class="mcard" style="margin-bottom:6px"><div class="row"><span>${esc(a.texte)}</span><span class="k">${esc(a.quand)}</span></div>
      <div class="row"><span class="k">${esc(a.auteur)}</span></div></div>`).join("") : `<div class="vide"><b>Aucune activité</b></div>`;
    // Navigation depuis le dashboard (§17)
    $$("[data-ouvrir-projet]").forEach((b) => (b.onclick = () => allerVue("projet", { id: b.dataset.ouvrirProjet })));
    $$("[data-voir-fa]").forEach((b) => (b.onclick = () => voirDocument("pi", b.dataset.voirFa, charger)));
    $$("[data-alerte]").forEach((b) => (b.onclick = () => {
      const cib = JSON.parse(b.dataset.alerte);
      if (cib.vue === "projet") allerVue("projet", { id: cib.id });
      else if (cib.vue === "factures") allerVue("factures", { onglet: cib.onglet });
      else allerVue(cib.vue, {});
    }));
    $("#v-projets").onclick = () => allerVue("projets", {});
    $("#v-fa").onclick = () => allerVue("factures", { onglet: "achat" });
  };
  $("#f-ok").onclick = () => charger().catch((e) => toast(e.message, true));
  await charger().catch((e) => { c.innerHTML = `<p class="erreur">${esc(e.message)}</p>`; });
}

// --- Liste projets ---
async function vProjets(c) {
  c.innerHTML = `<div class="card"><div class="card-h"><div class="toolbar">
      <input id="q" placeholder="Rechercher (référence, projet, client)…" style="min-width:260px">
      <select id="fstatut"><option value="">Tous statuts</option><option value="BROUILLON">Brouillon</option><option value="VALIDE">Validé</option><option value="ANNULE">Annulé</option></select>
      <button class="btn" id="filtrer">Filtrer</button></div>
      <button class="btn primaire" id="nouveau">+ Nouveau projet</button></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Référence</th><th>Projet</th><th>Client</th><th>Début</th><th>Fin</th><th>Statut</th><th class="num">Total HT</th><th class="num">TVA</th><th class="num">Total TTC</th><th>Dernière modification</th><th class="actions">Actions</th></tr></thead><tbody id="tb"></tbody></table></div>
    <div class="cards-mobile" id="cm"></div><div class="pager"><button class="btn petit" id="prev">← Précédent</button><span id="pg"></span><button class="btn petit" id="next">Suivant →</button></div></div>
    <div id="dlg"></div>`;
  let page = 1;
  const charger = async () => {
    const d = await api(`/api/projets?recherche=${encodeURIComponent($("#q").value)}&statut=${$("#fstatut").value}&page=${page}&pageSize=15`);
    $("#pg").textContent = `Page ${d.page} — ${d.total} projet(s)`;
    const actionsPour = (p) => {
      if (p.status === "BROUILLON") return [["consulter", "Consulter"], ["modifier", "Modifier"], ["dupliquer", "Dupliquer"], ["valider", "Valider"], ["supprimer", "Supprimer"]];
      if (p.status === "VALIDE") return [["consulter", "Consulter"], ["dupliquer", "Dupliquer"]];
      return [["consulter", "Consulter"]];
    };
    $("#tb").innerHTML = d.rows.map((p) => `<tr><td><b>${p.reference}</b></td><td>${esc(p.title)}</td><td>${esc(p.customer_name)}</td>
      <td>${p.start_date || "—"}</td><td>${p.end_date || "—"}</td><td><span class="badge ${p.status}">${STATUTS[p.status]}</span></td>
      <td class="num">${fmt(p.total_ht)}</td><td class="num">${fmt(p.total_tva)}</td><td class="num"><b>${fmt(p.total_ttc)}</b></td>
      <td>${(p.updated_at || "").slice(0, 16).replace("T", " ")}</td>
      <td class="actions">${menuActions(p, actionsPour(p))}</td></tr>`).join("") ||
      `<tr><td colspan="11"><div class="vide"><b>Aucun projet trouvé</b>Modifiez la recherche ou créez un nouveau projet.</div></td></tr>`;
    $("#cm").innerHTML = d.rows.map((p) => `<div class="mcard"><div class="t">${p.reference} — ${esc(p.title)}</div>
      <div class="row"><span class="k">Client</span><span>${esc(p.customer_name)}</span></div>
      <div class="row"><span class="k">Période</span><span>${p.start_date || "?"} → ${p.end_date || "?"}</span></div>
      <div class="row"><span class="k">Statut</span><span class="badge ${p.status}">${STATUTS[p.status]}</span></div>
      <div class="row"><span class="k">Total TTC</span><b>${fmt(p.total_ttc)}</b></div>
      <div class="row">${menuActions(p, actionsPour(p))}</div></div>`).join("");
    brancherMenus(c); brancherActions(c, charger);
  };
  $("#filtrer").onclick = () => { page = 1; charger().catch((e) => toast(e.message, true)); };
  $("#prev").onclick = () => { if (page > 1) { page--; charger(); } };
  $("#next").onclick = () => { page++; charger(); };
  $("#nouveau").onclick = () => formulaireProjet(null, charger);
  await charger().catch((e) => toast(e.message, true));
}

function menuActions(p, actions) {
  return `<span class="menu"><button data-menu>⋮</button><span class="liste">${actions
    .map(([a, l]) => `<button data-act="${a}" data-id="${p.id}" class="${a === "supprimer" ? "danger" : ""}">${l}</button>`).join("")}</span></span>`;
}
// Menu d'actions flottant (position:fixed) : jamais rogné par le défilement du tableau.
// S'ouvre vers le bas, ou vers le haut si la place manque en bas ; se referme au
// défilement, au redimensionnement ou au clic ailleurs.
function fermerMenuFlottant() {
  const f = document.getElementById("menu-flottant");
  $$(".menu.open").forEach((x) => x.classList.remove("open"));
  if (f) {
    if (f.firstChild && f._parent && f._parent.isConnected) f._parent.appendChild(f.firstChild);
    f._parent = null;
    f.style.display = "none";
  }
}
function brancherMenus(c) {
  $$("[data-menu]", c).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const m = b.closest(".menu");
    const liste = m.querySelector(".liste");
    if (!liste) return;
    let f = document.getElementById("menu-flottant");
    if (!f) { f = document.createElement("div"); f.id = "menu-flottant"; f.style.display = "none"; document.body.appendChild(f); }
    const dejaOuvert = m.classList.contains("open");
    fermerMenuFlottant();
    if (dejaOuvert) return;
    m.classList.add("open");
    f._parent = m;
    f.appendChild(liste);
    f.style.display = "block";
    f.style.top = "0px"; f.style.left = "0px";
    const r = b.getBoundingClientRect();
    const h = f.offsetHeight, w = f.offsetWidth;
    let haut = r.bottom + 4;
    if (haut + h > window.innerHeight - 8) haut = Math.max(8, r.top - h - 4);
    let gauche = Math.min(r.right - w, window.innerWidth - w - 8);
    f.style.top = haut + "px"; f.style.left = Math.max(8, gauche) + "px";
  }));
}
if (!window.__erpMenuGlobal) {
  window.__erpMenuGlobal = true;
  document.addEventListener("click", (e) => {
    if (e.target.closest && (e.target.closest("#menu-flottant") || e.target.closest("[data-menu]"))) return;
    fermerMenuFlottant();
  }, true);
  document.addEventListener("scroll", () => fermerMenuFlottant(), true);
  window.addEventListener("resize", () => fermerMenuFlottant());
}
function brancherActions(c, recharger) {
  $$("[data-act]", c).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    fermerMenuFlottant();
    const id = b.dataset.id, a = b.dataset.act;
    if (a === "consulter" || a === "modifier") { etat.vue = "projet"; etat.params = { id, lecture: a === "consulter" }; afficher(); }
    else if (a === "dupliquer") { await api(`/api/projets/${id}/dupliquer`, { method: "POST" }); toast("Projet dupliqué en brouillon"); recharger(); }
    else if (a === "valider") {
      if (!confirm("Valider ce projet ? Il deviendra protégé et historiquement figé.")) return;
      try { await api(`/api/projets/${id}/valider`, { method: "POST" }); toast("Devis validé — commandes d'achat générées"); recharger(); }
      catch (err) { toast(err.message, true); }
    } else if (a === "supprimer") {
      if (!confirm("Supprimer ce brouillon ?")) return;
      try { await api(`/api/projets/${id}`, { method: "DELETE" }); toast("Projet supprimé"); recharger(); }
      catch (err) { toast(err.message, true); }
    }
  }));
}

async function formulaireProjet(id, apres) {
  let clients = await api("/api/clients?pageSize=200").catch(() => ({ lignes: [] }));
  const estCreation = !id;
  const p = id ? await api(`/api/projets/${id}`) : { title: "", customer_id: clients.lignes[0]?.id || "", start_date: "", end_date: "", notes: "" };
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>${estCreation ? "Nouveau projet" : "Modifier le projet"}</h2></div>
    <div class="card-b"><label class="champ">Client *<select name="clientId" required>${clients.lignes.map((cl) => `<option value="${cl.id}" ${cl.id === p.customer_id ? "selected" : ""}>${esc(cl.name)} (${esc(cl.code)})</option>`).join("")}</select></label><br>
    <label class="champ">Nom du projet *<input name="titre" value="${esc(p.title || "")}" required placeholder="Ex. Séminaire Société ABC"></label><br>
    <div class="grid2"><label class="champ">Date de début<input name="dateDebut" type="date" value="${p.start_date || ""}"></label>
    <label class="champ">Date de fin<input name="dateFin" type="date" value="${p.end_date || ""}"></label></div><br>
    <label class="champ">Notes<textarea name="notes" rows="2">${esc(p.notes || "")}</textarea></label><br>
    <p class="erreur" id="e"></p><div class="toolbar"><button class="btn primaire">Enregistrer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  $("#x", fond).onclick = () => fond.remove();
  fond.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const corps = { clientId: Number(fd.get("clientId")), titre: fd.get("titre"), dateDebut: fd.get("dateDebut") || null, dateFin: fd.get("dateFin") || null, notes: fd.get("notes") || null };
    try {
      const res = estCreation ? await api("/api/projets", { method: "POST", body: JSON.stringify(corps) })
        : await api(`/api/projets/${id}`, { method: "PUT", body: JSON.stringify(corps) });
      fond.remove(); toast(estCreation ? "Projet créé" : "Projet enregistré");
      if (apres) apres(); else { etat.vue = "projet"; etat.params = { id: res.id }; afficher(); }
    } catch (err) { $("#e", fond).textContent = err.message; }
  };
}

// --- Confirmation client (§56) : opération métier explicite ---
function dialogueConfirmer(projet, apres) {
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>Confirmer l'acceptation du client</h2></div><div class="card-b">
    <p>Le client a accepté le devis <b>${esc(projet.quote_reference || projet.reference)}</b> (${fmt(projet.total_ttc)} TTC).</p>
    <p class="hint">La confirmation génère la facture de vente (prix de vente) et les factures d'achat (une par commande). Opération atomique et non rejouable.</p>
    <label class="champ">Référence / commentaire de confirmation <span class="opt">(bon pour accord, email…)</span><input name="note" placeholder="Ex. Bon pour accord reçu le…"></label><br>
    <p class="erreur" id="e"></p><div class="toolbar"><button class="btn primaire">Confirmer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  $("#x", fond).onclick = () => fond.remove();
  fond.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api(`/api/projets/${projet.id}/confirmer`, { method: "POST", body: JSON.stringify({ note: new FormData(ev.target).get("note") || null }) });
      fond.remove(); toast("Projet confirmé — factures générées"); apres();
    } catch (err) { $("#e", fond).textContent = err.message; }
  };
}

// --- Fiche projet ---
async function vProjet(c) {
  const { id } = etat.params;
  if (!id) { etat.vue = "projets"; return afficher(); }
  c.innerHTML = `<p>Chargement…</p>`;
  let p;
  try { p = await api(`/api/projets/${id}`); }
  catch (e) { c.innerHTML = `<p class="erreur">${esc(e.message)}</p>`; return; }
  const brouillon = p.status === "BROUILLON";
  const lecture = etat.params.lecture && !brouillon;
  const confirme = !!p.confirmed_at;
  c.innerHTML = `
  <div class="card"><div class="card-h"><h2>${p.reference} — ${esc(p.title)}</h2>
    <div class="toolbar"><span class="badge ${p.status}">${STATUTS[p.status]}</span>
    ${confirme ? `<span class="badge VALIDEE">Confirmé par le client</span>` : ""}
    <button class="btn" id="b-devis-pdf">Devis PDF</button>
    ${brouillon ? `<button class="btn" id="b-modif">Modifier</button><button class="btn succes" id="b-valider">Valider</button><button class="btn danger" id="b-annuler">Annuler le projet</button>` : `<button class="btn" id="b-dupliquer">Dupliquer</button>`}
    ${p.status === "VALIDE" && !confirme ? `<button class="btn primaire" id="b-confirmer">Confirmer (client accepté)</button>` : ""}
    <button class="btn" id="b-retour">← Retour</button></div></div>
    <div class="card-b"><div class="grid4">
      <div><div class="hint">Client</div><b>${esc(p.customer_name)}</b></div>
      <div><div class="hint">Période</div><b>${p.start_date || "—"} → ${p.end_date || "—"}</b></div>
      <div><div class="hint">Devis</div><b>${p.quote_reference ? esc(p.quote_reference) : "—"}</b></div>
      <div><div class="hint">Modifié le</div><b>${(p.updated_at || "").slice(0, 16).replace("T", " ")}</b></div>
    </div>${p.notes ? `<p><span class="hint">Notes : </span>${esc(p.notes)}</p>` : ""}
    ${p.status === "VALIDE" ? `<p class="hint">Projet validé ${p.validated_at ? "le " + p.validated_at.slice(0, 16).replace("T", " ") : ""} — document protégé et historiquement figé. Les libellés affichés sont ceux du jour de validation.</p>` : ""}
    ${confirme ? `<p class="hint">Confirmé par le client ${p.confirmed_at ? "le " + p.confirmed_at.slice(0, 16).replace("T", " ") : ""}${p.confirmation_note ? " — " + esc(p.confirmation_note) : ""} — facture de vente et factures d'achat générées.</p>` : ""}</div></div>
  <div class="card"><div class="card-h"><h2>Prestations</h2>${brouillon ? `<button class="btn primaire petit" id="b-ajouter">+ Ajouter une prestation</button>` : ""}</div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Article</th><th class="num">Qté</th><th>Fournisseur</th><th class="num">Achat Vos Voyage (u.)</th><th>Marge Vos Voyage</th><th class="num">Achat Perfecto Booking (u.)</th><th>Marge Perfecto Booking</th><th class="num">Vente (u.)</th><th>TVA</th><th class="num">Total HT</th><th class="num">Total TTC</th>${brouillon ? `<th class="actions">Actions</th>` : ""}</tr></thead>
    <tbody>${p.lines.map((l) => `<tr><td><b>${esc(l.article_designation_snapshot || l.article_designation)}</b><br><span class="hint">${esc(l.description || "")} · ${esc(l.unit)}</span></td>
      <td class="num">${l.quantity}</td><td>${esc(l.supplier_name_snapshot || l.supplier_name)}</td>
      <td class="num">${fmt(l.prix_achat_grande_agence)}</td><td>${l.valeur_marge_grande_agence} ${l.type_marge_grande_agence === "POURCENTAGE" ? "%" : "DT"}</td>
      <td class="num calcule" style="background:var(--surface-2)">${fmt(l.prix_achat_notre_agence)}</td>
      <td>${l.valeur_marge_notre_agence} ${l.type_marge_notre_agence === "POURCENTAGE" ? "%" : "DT"}</td>
      <td class="num" style="background:var(--surface-2)"><b>${fmt(l.prix_vente_notre_agence)}</b></td>
      <td>${l.taux_tva} %</td><td class="num">${fmt(l.total_ht)}</td><td class="num"><b>${fmt(l.total_ttc)}</b></td>
      ${brouillon ? `<td class="actions">${menuActions({ id: l.id }, [["modifier-l", "Modifier"], ["supprimer-l", "Supprimer"]]).replaceAll(`data-id="${l.id}"`, `data-lid="${l.id}"`)}</td>` : ""}</tr>`).join("") ||
      `<tr><td colspan="12"><div class="vide"><b>Aucune prestation</b>Ajoutez la première prestation pour chiffrer le projet.</div></td></tr>`}</tbody></table></div>
    <div class="cards-mobile">${p.lines.map((l) => `<div class="mcard"><div class="t">${esc(l.article_designation_snapshot || l.article_designation)} × ${l.quantity}</div>
      <div class="row"><span class="k">Fournisseur</span><span>${esc(l.supplier_name_snapshot || l.supplier_name)}</span></div>
      <div class="row"><span class="k">Vente unit.</span><b>${fmt(l.prix_vente_notre_agence)}</b></div>
      <div class="row"><span class="k">Total TTC</span><b>${fmt(l.total_ttc)}</b></div></div>`).join("")}</div></div>
  <div class="card"><div class="card-h"><h2>Synthèse financière</h2><span class="hint">Calculée par le serveur — non modifiable</span></div>
    <div class="card-b"><dl class="synth">
      <dt>Coût Vos Voyage</dt><dd>${fmt(p.total_cout_grande_agence)}</dd>
      <dt>Marge Vos Voyage</dt><dd>${fmt(p.total_marge_grande_agence)}</dd>
      <dt>Achat Perfecto Booking</dt><dd>${fmt(p.total_achat_notre_agence)}</dd>
      <dt>Marge Perfecto Booking</dt><dd>${fmt(p.total_marge_notre_agence)}</dd>
      <dt>Prix de vente HT</dt><dd>${fmt(p.total_ht)}</dd>
      <dt>TVA</dt><dd>${fmt(p.total_tva)}</dd>
      <div class="total" style="display:contents"><dt>Total TTC</dt><dd>${fmt(p.total_ttc)}</dd></div>
    </dl></div></div>
  <div class="card"><div class="card-h"><h2>Documents liés</h2><span class="hint">Traçabilité de pièce : devis → commandes → factures</span></div>
    <div class="card-b" id="docs-lies"><p class="hint">Chargement…</p></div></div>`;
  $("#b-retour").onclick = () => { etat.vue = "projets"; afficher(); };
  $("#b-devis-pdf").onclick = () => telechargerPdf(`/api/projets/${p.id}/devis/pdf`).catch((e) => toast(e.message, true));
  const bc = $("#b-confirmer");
  if (bc) bc.onclick = () => dialogueConfirmer(p, () => afficher());
  // Documents liés (§66)
  try {
    const docs = await api(`/api/projets/${p.id}/documents`);
    const rangee = (kind, d, preciser) => `<tr><td><b>${d.reference}</b></td><td>${preciser}</td>
      <td><span class="badge ${d.status}">${STATUT_DOC[d.status] || d.status}</span></td>
      <td class="num"><b>${fmt(d.total_ttc)}</b></td>
      <td class="actions"><button class="btn petit" data-voir-doc="${kind}:${d.id}">Voir</button>
      <button class="btn petit" data-pdf-doc="${kind}:${d.id}">PDF</button></td></tr>`;
    let html = `<div class="tablewrap"><table><thead><tr><th>Pièce</th><th>Détail</th><th>Statut</th><th class="num">Total TTC</th><th class="actions">Actions</th></tr></thead><tbody>`;
    html += `<tr><td><b>Devis ${docs.devis ? esc(docs.devis) : "—"}</b></td><td>Devis du projet ${esc(p.reference)}</td>
      <td><span class="badge ${p.status}">${STATUTS[p.status]}</span></td><td class="num"><b>${fmt(p.total_ttc)}</b></td>
      <td class="actions"><button class="btn petit" id="dl-devis-pdf">PDF</button></td></tr>`;
    for (const o of docs.purchaseOrders) html += rangee("po", o, `Commande d'achat — ${esc(o.supplier_name_snapshot)}`);
    if (docs.salesInvoice) html += rangee("si", docs.salesInvoice, "Facture de vente");
    for (const f of docs.purchaseInvoices) html += rangee("pi", f, `Facture d'achat — ${esc(f.supplier_name_snapshot)} (${esc(f.purchase_order_reference)})`);
    html += `</tbody></table></div>`;
    if (!docs.purchaseOrders.length && !docs.salesInvoice) html += `<p class="hint">Validez le devis pour générer les commandes d'achat, puis confirmez pour générer les factures.</p>`;
    $("#docs-lies").innerHTML = html;
    const dlPdf = $("#dl-devis-pdf");
    if (dlPdf) dlPdf.onclick = () => telechargerPdf(`/api/projets/${p.id}/devis/pdf`).catch((e) => toast(e.message, true));
    $$("[data-voir-doc]", $("#docs-lies")).forEach((b) => (b.onclick = () => {
      const [kind, id] = b.dataset.voirDoc.split(":");
      voirDocument(kind, id, () => afficher());
    }));
    $$("[data-pdf-doc]", $("#docs-lies")).forEach((b) => (b.onclick = () => {
      const [kind, id] = b.dataset.pdfDoc.split(":");
      telechargerPdf(`${DOCS[kind].url}/${id}/pdf`).catch((e) => toast(e.message, true));
    }));
  } catch (e) { $("#docs-lies").innerHTML = `<p class="erreur">${esc(e.message)}</p>`; }
  if (brouillon) {
    $("#b-modif").onclick = () => formulaireProjet(p.id, () => { afficher(); });
    $("#b-ajouter").onclick = () => formulaireLigne(p, null, () => afficher());
    $("#b-valider").onclick = async () => {
      if (!confirm("Valider ce projet ? Recalcul serveur, snapshots historiques, protection du document.")) return;
      try { await api(`/api/projets/${p.id}/valider`, { method: "POST" }); toast("Devis validé — commandes d'achat générées"); afficher(); }
      catch (e) { toast(e.message, true); }
    };
    $("#b-annuler").onclick = async () => {
      if (!confirm("Annuler ce projet ?")) return;
      try { await api(`/api/projets/${p.id}/annuler`, { method: "POST" }); toast("Projet annulé"); afficher(); }
      catch (e) { toast(e.message, true); }
    };
    brancherMenus(c);
    $$("[data-act]", c).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      fermerMenuFlottant();
      const lid = b.dataset.lid;
      if (b.dataset.act === "modifier-l") formulaireLigne(p, p.lines.find((l) => l.id == lid), () => afficher());
      if (b.dataset.act === "supprimer-l") {
        if (!confirm("Retirer cette prestation ?")) return;
        try { await api(`/api/projets/${p.id}/lignes/${lid}`, { method: "DELETE" }); toast("Prestation retirée"); afficher(); }
        catch (err) { toast(err.message, true); }
      }
    }));
  } else {
    const bd = $("#b-dupliquer");
    if (bd) bd.onclick = async () => { const n = await api(`/api/projets/${p.id}/dupliquer`, { method: "POST" }); toast("Projet dupliqué en brouillon"); etat.params = { id: n.id }; afficher(); };
  }
}

async function formulaireLigne(projet, ligne, apres) {
  const [arts, frns, tvas] = await Promise.all([
    api("/api/articles?pageSize=200").catch(() => ({ lignes: [] })),
    api("/api/fournisseurs?pageSize=200").catch(() => ({ lignes: [] })),
    api("/api/tva").catch(() => ({ lignes: [] })),
  ]);
  const l = ligne ? {
    articleId: ligne.article_id, fournisseurId: ligne.supplier_id, description: ligne.description || "",
    quantite: ligne.quantity, unit: ligne.unit, prixAchatGrandeAgence: ligne.prix_achat_grande_agence,
    typeMargeGrandeAgence: ligne.type_marge_grande_agence, valeurMargeGrandeAgence: ligne.valeur_marge_grande_agence,
    typeMargeNotreAgence: ligne.type_marge_notre_agence, valeurMargeNotreAgence: ligne.valeur_marge_notre_agence,
    tauxTva: ligne.taux_tva, vatRateId: ligne.vat_rate_id,
  } : { articleId: arts.lignes[0]?.id || "", fournisseurId: frns.lignes[0]?.id || "", description: "", quantite: 1, unit: "Personne", prixAchatGrandeAgence: 0, typeMargeGrandeAgence: "POURCENTAGE", valeurMargeGrandeAgence: 20, typeMargeNotreAgence: "POURCENTAGE", valeurMargeNotreAgence: 15, tauxTva: 19, vatRateId: tvas.lignes.find((t) => t.rate === 19)?.id || tvas.lignes[0]?.id || "" };
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>${ligne ? "Modifier la prestation" : "Ajouter une prestation"}</h2></div><div class="card-b">
    <div class="grid2"><label class="champ">Article *<select name="articleId">${arts.lignes.map((a) => `<option value="${a.id}" ${a.id === l.articleId ? "selected" : ""}>${esc(a.designation)} (${esc(a.code)})</option>`).join("")}</select></label>
    <label class="champ">Fournisseur *<select name="fournisseurId">${frns.lignes.map((f) => `<option value="${f.id}" ${f.id === l.fournisseurId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label></div><br>
    <div class="grid3"><label class="champ">Quantité *<input name="quantite" type="number" min="0.001" step="0.001" value="${l.quantite}" required></label>
    <label class="champ">Unité<select name="unit">${["Nuit", "Personne", "Bus", "Jour", "Forfait", "Unité"].map((u) => `<option ${u === l.unit ? "selected" : ""}>${u}</option>`).join("")}</select></label>
    <label class="champ">TVA *<select name="vatRateId">${tvas.lignes.map((t) => `<option value="${t.id}" data-taux="${t.rate}" ${t.id === l.vatRateId ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label></div><br>
    <label class="champ">Description / précision<textarea name="description" rows="2">${esc(l.description)}</textarea></label><br>
    <div class="grid2"><label class="champ">Prix d'achat Vos Voyage (unit.) *<input name="prixAchatGrandeAgence" type="number" min="0" step="0.001" value="${l.prixAchatGrandeAgence}" required></label>
    <div></div></div><br>
    <div class="grid2"><label class="champ">Marge Vos Voyage *<div class="saisie-calcule"><input name="valeurMargeGrandeAgence" type="number" min="0" step="0.01" value="${l.valeurMargeGrandeAgence}" required><select name="typeMargeGrandeAgence"><option value="POURCENTAGE" ${l.typeMargeGrandeAgence === "POURCENTAGE" ? "selected" : ""}>%</option><option value="MONTANT_FIXE" ${l.typeMargeGrandeAgence === "MONTANT_FIXE" ? "selected" : ""}>DT</option></select></div></label>
    <label class="champ">Prix d'achat Perfecto Booking (calculé)<input id="ap-achat" class="calcule" readonly></label></div><br>
    <div class="grid2"><label class="champ">Marge Perfecto Booking *<div class="saisie-calcule"><input name="valeurMargeNotreAgence" type="number" min="0" step="0.01" value="${l.valeurMargeNotreAgence}" required><select name="typeMargeNotreAgence"><option value="POURCENTAGE" ${l.typeMargeNotreAgence === "POURCENTAGE" ? "selected" : ""}>%</option><option value="MONTANT_FIXE" ${l.typeMargeNotreAgence === "MONTANT_FIXE" ? "selected" : ""}>DT</option></select></div></label>
    <label class="champ">Prix de vente Perfecto Booking (calculé)<input id="ap-vente" class="calcule" readonly></label></div>
    <p class="hint" id="ap-total"></p>
    <p class="erreur" id="e"></p><div class="toolbar"><button class="btn primaire">Enregistrer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  const f = fond.querySelector("form");
  const maj = () => {
    const fd = new FormData(f);
    const a = apercuLigne({ prixAchatGrandeAgence: Number(fd.get("prixAchatGrandeAgence")), typeMargeGrandeAgence: fd.get("typeMargeGrandeAgence"), valeurMargeGrandeAgence: Number(fd.get("valeurMargeGrandeAgence")), typeMargeNotreAgence: fd.get("typeMargeNotreAgence"), valeurMargeNotreAgence: Number(fd.get("valeurMargeNotreAgence")) });
    $("#ap-achat", fond).value = fmt(a.achat); $("#ap-vente", fond).value = fmt(a.vente);
    const sel = $("select[name=vatRateId]", fond); const taux = Number(sel.selectedOptions[0]?.dataset.taux ?? l.tauxTva);
    $("#ap-total", fond).textContent = `Aperçu : ${fd.get("quantite")} × ${fmt(a.vente)} HT, TVA ${taux} % → vérification finale effectuée par le serveur.`;
  };
  f.oninput = maj; f.onchange = maj; maj();
  $("#x", fond).onclick = () => fond.remove();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(f);
    const sel = $("select[name=vatRateId]", fond);
    const corps = { articleId: Number(fd.get("articleId")), fournisseurId: Number(fd.get("fournisseurId")), description: fd.get("description") || null, quantite: Number(fd.get("quantite")), unit: fd.get("unit"), prixAchatGrandeAgence: Number(fd.get("prixAchatGrandeAgence")), typeMargeGrandeAgence: fd.get("typeMargeGrandeAgence"), valeurMargeGrandeAgence: Number(fd.get("valeurMargeGrandeAgence")), typeMargeNotreAgence: fd.get("typeMargeNotreAgence"), valeurMargeNotreAgence: Number(fd.get("valeurMargeNotreAgence")), vatRateId: Number(fd.get("vatRateId")), tauxTva: Number(sel.selectedOptions[0].dataset.taux) };
    try {
      if (ligne) await api(`/api/projets/${projet.id}/lignes/${ligne.id}`, { method: "PUT", body: JSON.stringify(corps) });
      else await api(`/api/projets/${projet.id}/lignes`, { method: "POST", body: JSON.stringify(corps) });
      fond.remove(); toast("Prestation enregistrée"); apres();
    } catch (err) { $("#e", fond).textContent = err.message; }
  };
}

// --- Commandes d'achat ---
async function vCommandes(c) {
  c.innerHTML = `<div class="card"><div class="card-h"><div class="toolbar">
    <input id="q" placeholder="Rechercher (référence, projet)…" style="min-width:240px">
    <select id="fs"><option value="">Tous statuts</option><option value="BROUILLON">Brouillon</option><option value="VALIDEE">Validée</option><option value="CLOTUREE">Clôturée</option></select>
    <button class="btn" id="filtrer">Filtrer</button></div><span class="hint">Générées automatiquement à la validation du devis (1 par fournisseur)</span></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Référence</th><th>Projet</th><th>Fournisseur</th><th>Statut</th><th class="num">Total TTC</th><th>Dernière modification</th><th class="actions">Actions</th></tr></thead><tbody id="tb"></tbody></table></div>
    <div class="cards-mobile" id="cm"></div><div class="pager"><button class="btn petit" id="prev">← Précédent</button><span id="pg"></span><button class="btn petit" id="next">Suivant →</button></div></div>`;
  let page = 1;
  const charger = async () => {
    const d = await api(`/api/commandes-achat?recherche=${encodeURIComponent($("#q").value)}&statut=${$("#fs").value}&page=${page}&pageSize=15`);
    $("#pg").textContent = `Page ${d.page} — ${d.total} commande(s)`;
    const ligne = (x) => `<td><b>${x.reference}</b></td><td>${esc(x.project_reference)}</td><td>${esc(x.supplier_name_snapshot)}</td>
      <td><span class="badge ${x.status}">${STATUT_DOC[x.status]}</span></td><td class="num"><b>${fmt(x.total_ttc)}</b></td>
      <td>${(x.updated_at || "").slice(0, 16).replace("T", " ")}</td><td class="actions">${actionsDoc("po", x)}</td>`;
    $("#tb").innerHTML = d.rows.map((x) => `<tr>${ligne(x)}</tr>`).join("") ||
      `<tr><td colspan="7"><div class="vide"><b>Aucune commande d'achat</b>Validez un devis pour générer les commandes fournisseurs.</div></td></tr>`;
    $("#cm").innerHTML = d.rows.map((x) => `<div class="mcard"><div class="t">${x.reference} — ${esc(x.supplier_name_snapshot)}</div>
      <div class="row"><span class="k">Projet</span><span>${esc(x.project_reference)}</span></div>
      <div class="row"><span class="k">Statut</span><span class="badge ${x.status}">${STATUT_DOC[x.status]}</span></div>
      <div class="row"><span class="k">Total TTC</span><b>${fmt(x.total_ttc)}</b></div><div class="row">${actionsDoc("po", x)}</div></div>`).join("");
    brancherActionsDocs(c, charger);
  };
  $("#filtrer").onclick = () => { page = 1; charger().catch((e) => toast(e.message, true)); };
  $("#prev").onclick = () => { if (page > 1) { page--; charger(); } };
  $("#next").onclick = () => { page++; charger(); };
  await charger().catch((e) => toast(e.message, true));
}

// --- Factures (vente / achat) ---
async function vFactures(c) {
  const onglet = etat.params.onglet || "vente";
  c.innerHTML = `<div class="card"><div class="card-h"><div class="toolbar">
    <button class="btn ${onglet === "vente" ? "primaire" : ""}" id="t-vente">Factures de vente</button>
    <button class="btn ${onglet === "achat" ? "primaire" : ""}" id="t-achat">Factures d'achat</button></div>
    <div class="toolbar"><input id="q" placeholder="Rechercher (référence, projet)…">
    <select id="fs"><option value="">Tous statuts</option><option value="BROUILLON">Brouillon</option><option value="VALIDEE">Validée</option><option value="ANNULEE">Annulée</option></select>
    <button class="btn" id="filtrer">Filtrer</button></div></div>
    <div class="tablewrap"><table class="bureau"><thead><tr id="th"></tr></thead><tbody id="tb"></tbody></table></div>
    <div class="cards-mobile" id="cm"></div></div>`;
  $("#t-vente").onclick = () => { etat.params.onglet = "vente"; afficher(); };
  $("#t-achat").onclick = () => { etat.params.onglet = "achat"; afficher(); };
  const kind = onglet === "vente" ? "si" : "pi";
  const url = DOCS[kind].url;
  $("#th").innerHTML = onglet === "vente"
    ? `<th>Référence</th><th>Projet</th><th>Client</th><th>Statut</th><th class="num">Total TTC</th><th class="actions">Actions</th>`
    : `<th>Référence</th><th>Projet</th><th>Fournisseur</th><th>Commande</th><th>Statut</th><th class="num">Total TTC</th><th class="actions">Actions</th>`;
  const charger = async () => {
    const d = await api(`${url}?recherche=${encodeURIComponent($("#q").value)}&statut=${$("#fs").value}&pageSize=50`);
    $("#tb").innerHTML = d.rows.map((x) => {
      const tiers = `<td>${esc(x.customer_name_snapshot || x.supplier_name_snapshot)}</td>`;
      const cmd = onglet === "achat" ? `<td>${esc(x.purchase_order_reference || "—")}</td>` : "";
      return `<tr><td><b>${x.reference}</b></td><td>${esc(x.project_reference)}</td>${tiers}${cmd}
        <td><span class="badge ${x.status}">${STATUT_DOC[x.status]}</span></td>
        <td class="num"><b>${fmt(x.total_ttc)}</b></td><td class="actions">${actionsDoc(kind, x)}</td></tr>`;
    }).join("") || `<tr><td colspan="7"><div class="vide"><b>Aucune facture</b>Confirmez un projet validé pour générer les factures.</div></td></tr>`;
    $("#cm").innerHTML = d.rows.map((x) => `<div class="mcard"><div class="t">${x.reference}</div>
      <div class="row"><span class="k">Projet</span><span>${esc(x.project_reference)}</span></div>
      <div class="row"><span class="k">Statut</span><span class="badge ${x.status}">${STATUT_DOC[x.status]}</span></div>
      <div class="row"><span class="k">Total TTC</span><b>${fmt(x.total_ttc)}</b></div><div class="row">${actionsDoc(kind, x)}</div></div>`).join("");
    brancherActionsDocs(c, charger);
  };
  $("#filtrer").onclick = () => charger().catch((e) => toast(e.message, true));
  await charger().catch((e) => toast(e.message, true));
}

// --- Encaissements reçus (§20) : argent effectivement reçu de Vos Voyage ---
async function vEncaissements(c) {
  c.innerHTML = `<div class="kpis" id="k"></div>
  <div class="card"><div class="card-h"><div class="toolbar"><input id="q" placeholder="Rechercher (référence, projet, facture)…" style="min-width:240px">
    <button class="btn" id="filtrer">Filtrer</button></div><button class="btn primaire petit" id="n">+ Nouvel encaissement</button></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Référence</th><th>Date</th><th>Type</th><th class="num">Montant HT</th><th class="num">TVA</th><th class="num">Montant TTC</th><th>Projet / facture</th><th>Créé par</th><th class="actions">Actions</th></tr></thead><tbody id="tb"></tbody></table></div>
    <div class="cards-mobile" id="cm"></div><div class="pager"><button class="btn petit" id="prev">← Précédent</button><span id="pg"></span><button class="btn petit" id="next">Suivant →</button></div></div>`;
  let page = 1;
  const charger = async () => {
    const [d, tot] = await Promise.all([
      api(`/api/encaissements?recherche=${encodeURIComponent($("#q").value)}&page=${page}&pageSize=15`),
      api("/api/encaissements/totaux"),
    ]);
    $("#k").innerHTML = `<div class="kpi"><div class="v">${fmt(tot.totalHt)}</div><div class="l">Total HT reçu</div></div>
      <div class="kpi"><div class="v">${fmt(tot.totalTva)}</div><div class="l">TVA reçue</div></div>
      <div class="kpi"><div class="v">${fmt(tot.totalTtc)}</div><div class="l">Total TTC reçu (CA reçu)</div></div>`;
    $("#pg").textContent = `Page ${d.page} — ${d.total} encaissement(s)`;
    const lig = (r) => `<td><b>${r.reference}</b></td><td>${(r.transaction_date || "").slice(0, 10)}</td><td>${esc(r.type_label)}</td>
      <td class="num">${fmt(r.amount_ht)}</td><td class="num">${fmt(r.tva_amount)}</td><td class="num"><b>${fmt(r.amount_ttc)}</b></td>
      <td>${r.invoice_reference ? `Facture ${esc(r.invoice_reference)}<br>` : ""}<span class="hint">${esc(r.project_reference || "—")}</span></td>
      <td>${esc(r.created_by_email || "—")}</td>
      <td class="actions"><span class="menu"><button data-menu>⋮</button><span class="liste">
        <button data-eact="voir" data-eid="${r.id}">Consulter</button>
        <button data-eact="supprimer" data-eid="${r.id}" class="danger">Supprimer</button></span></span></td>`;
    $("#tb").innerHTML = d.rows.map((r) => `<tr>${lig(r)}</tr>`).join("") ||
      `<tr><td colspan="9"><div class="vide"><b>Aucun encaissement</b>Enregistrez les sommes reçues de Vos Voyage.</div></td></tr>`;
    $("#cm").innerHTML = d.rows.map((r) => `<div class="mcard"><div class="t">${r.reference} — ${esc(r.type_label)}</div>
      <div class="row"><span class="k">Date</span><span>${(r.transaction_date || "").slice(0, 10)}</span></div>
      <div class="row"><span class="k">TTC</span><b>${fmt(r.amount_ttc)}</b></div>
      <div class="row"><span class="k">Projet</span><span>${esc(r.project_reference || "—")}</span></div></div>`).join("");
    brancherMenus(c);
    $$("[data-eact]", c).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation(); fermerMenuFlottant();
      const id = b.dataset.eid;
      if (b.dataset.eact === "voir") voirEncaissement(id, charger);
      else if (confirm("Supprimer cet encaissement ? Le solde de la facture sera recalculé.")) {
        try { await api(`/api/encaissements/${id}`, { method: "DELETE" }); toast("Encaissement supprimé"); charger(); }
        catch (err) { toast(err.message, true); }
      }
    }));
  };
  $("#filtrer").onclick = () => { page = 1; charger().catch((e) => toast(e.message, true)); };
  $("#prev").onclick = () => { if (page > 1) { page--; charger(); } };
  $("#next").onclick = () => { page++; charger(); };
  $("#n").onclick = () => dialogueEncaissement(null, charger);
  await charger().catch((e) => toast(e.message, true));
}

async function voirEncaissement(id, apres) {
  const r = await api(`/api/encaissements/${id}`).catch((e) => { toast(e.message, true); return null; });
  if (!r) return;
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<div class="dialogue"><div class="card-h"><h2>Encaissement ${r.reference}</h2></div><div class="card-b">
    <div class="grid2"><div><div class="hint">Date</div><b>${(r.transaction_date || "").slice(0, 10)}</b></div>
    <div><div class="hint">Type</div><b>${esc(r.type_label)}</b></div></div><br>
    <dl class="synth"><dt>Montant HT</dt><dd>${fmt(r.amount_ht)}</dd><dt>TVA (${r.taux_tva} %)</dt><dd>${fmt(r.tva_amount)}</dd>
    <div class="total" style="display:contents"><dt>Montant TTC</dt><dd>${fmt(r.amount_ttc)}</dd></div></dl>
    <p><span class="hint">Facture de vente : </span><b>${esc(r.invoice_reference || "—")}</b>
    <span class="hint"> · Projet : </span><b>${esc(r.project_reference || "—")}</b></p>
    ${r.notes ? `<p><span class="hint">Notes : </span>${esc(r.notes)}</p>` : ""}
    <div class="toolbar"><button class="btn" id="x">Fermer</button></div></div></div>`;
  document.body.appendChild(fond);
  $("#x", fond).onclick = () => fond.remove();
}

async function dialogueEncaissement(defaut, apres) {
  const [types, tvas] = await Promise.all([
    api("/api/types-transactions").catch(() => ({ lignes: [] })),
    api("/api/tva").catch(() => ({ lignes: [] })),
  ]);
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>Nouvel encaissement</h2></div><div class="card-b">
    <p class="hint">Somme reçue de Vos Voyage. Le TTC est recalculé par le serveur.</p>
    <div class="grid2"><label class="champ">Date<input name="dateTransaction" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
    <label class="champ">Type *<select name="typeId" required>${types.lignes.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("")}</select></label></div><br>
    <div class="grid2"><label class="champ">Montant HT *<input name="montantHt" type="number" min="0.001" step="0.001" value="1000" required></label>
    <label class="champ">TVA *<select name="vatRateId">${tvas.lignes.map((t) => `<option value="${t.id}" data-taux="${t.rate}">${esc(t.label)}</option>`).join("")}</select></label></div>
    <p class="hint" id="ap">TTC calculé : —</p>
    <label class="champ">Facture de vente liée <span class="opt">(optionnel — contrôle du restant)</span><input name="factureVenteId" placeholder="N° de facture (ex. FV-2026-001)"></label><br>
    <label class="champ">Notes<textarea name="notes" rows="2"></textarea></label><br>
    <p class="erreur" id="e"></p><div class="toolbar"><button class="btn primaire">Enregistrer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  const f = fond.querySelector("form");
  const maj = () => {
    const ht = Number(new FormData(f).get("montantHt")) || 0;
    const taux = Number($("select[name=vatRateId]", fond).selectedOptions[0]?.dataset.taux || 0);
    $("#ap", fond).textContent = `TTC calculé : ${fmt(ht + ht * taux / 100)} (aperçu — le serveur recalcule)`;
  };
  f.oninput = maj; maj();
  $("#x", fond).onclick = () => fond.remove();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(f);
    const sel = $("select[name=vatRateId]", fond);
    // Résout la facture par sa référence si saisie
    let factureId = null;
    const refFact = (fd.get("factureVenteId") || "").trim();
    if (refFact) {
      const r = await api(`/api/factures-vente?recherche=${encodeURIComponent(refFact)}&pageSize=50`).catch(() => ({ rows: [] }));
      const trouvee = r.rows.find((x) => x.reference === refFact) || r.rows[0];
      if (!trouvee) { $("#e", fond).textContent = "Facture de vente introuvable"; return; }
      factureId = trouvee.id;
    }
    try {
      await api("/api/encaissements", { method: "POST", body: JSON.stringify({
        dateTransaction: fd.get("dateTransaction") || null, montantHt: Number(fd.get("montantHt")),
        vatRateId: Number(fd.get("vatRateId")), tauxTva: Number(sel.selectedOptions[0].dataset.taux),
        typeId: Number(fd.get("typeId")), factureVenteId: factureId, notes: fd.get("notes") || null }) });
      fond.remove(); toast("Encaissement enregistré"); apres();
    } catch (err) { $("#e", fond).textContent = err.message; }
  };
}

// --- Paiements fournisseurs (§21) : montants versés par Vos Voyage aux fournisseurs ---
async function vPaiements(c) {
  c.innerHTML = `<div class="kpis" id="k"></div>
  <div class="card"><div class="card-h"><div class="toolbar"><input id="q" placeholder="Rechercher (référence, facture, fournisseur)…" style="min-width:240px">
    <button class="btn" id="filtrer">Filtrer</button></div><button class="btn primaire petit" id="n">+ Nouveau paiement</button></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Référence</th><th>Date</th><th>Fournisseur</th><th>Facture d'achat</th><th class="num">Montant HT</th><th class="num">TVA</th><th class="num">Montant TTC</th><th>Type</th><th>Projet</th><th class="actions">Actions</th></tr></thead><tbody id="tb"></tbody></table></div>
    <div class="cards-mobile" id="cm"></div><div class="pager"><button class="btn petit" id="prev">← Précédent</button><span id="pg"></span><button class="btn petit" id="next">Suivant →</button></div></div>`;
  let page = 1;
  const charger = async () => {
    const [d, tot] = await Promise.all([
      api(`/api/paiements?recherche=${encodeURIComponent($("#q").value)}&page=${page}&pageSize=15`),
      api("/api/paiements/totaux"),
    ]);
    $("#k").innerHTML = `<div class="kpi"><div class="v">${fmt(tot.totalPaye)}</div><div class="l">Total payé</div></div>
      <div class="kpi"><div class="v">${fmt(tot.resteAPayer)}</div><div class="l">Reste à payer</div></div>
      <div class="kpi"><div class="v">${tot.soldees}</div><div class="l">Factures soldées</div></div>
      <div class="kpi"><div class="v">${tot.partielles}</div><div class="l">Partiellement payées</div></div>
      <div class="kpi"><div class="v">${tot.nonPayees}</div><div class="l">Non payées</div></div>`;
    $("#pg").textContent = `Page ${d.page} — ${d.total} paiement(s)`;
    $("#tb").innerHTML = d.rows.map((r) => `<tr><td><b>${r.reference}</b></td><td>${(r.payment_date || "").slice(0, 10)}</td>
      <td>${esc(r.supplier_name)}</td><td>${esc(r.invoice_reference)}</td>
      <td class="num">${fmt(r.amount_ht)}</td><td class="num">${fmt(r.tva_amount)}</td><td class="num"><b>${fmt(r.amount_ttc)}</b></td>
      <td>${esc(r.type_label)}</td><td>${esc(r.project_reference || "—")}</td>
      <td class="actions"><span class="menu"><button data-menu>⋮</button><span class="liste">
        <button data-pact="voir" data-pid="${r.id}">Consulter</button>
        <button data-pact="supprimer" data-pid="${r.id}" class="danger">Supprimer</button></span></span></td></tr>`).join("") ||
      `<tr><td colspan="10"><div class="vide"><b>Aucun paiement</b>Enregistrez les paiements versés aux fournisseurs.</div></td></tr>`;
    $("#cm").innerHTML = d.rows.map((r) => `<div class="mcard"><div class="t">${r.reference} — ${esc(r.supplier_name)}</div>
      <div class="row"><span class="k">Facture</span><span>${esc(r.invoice_reference)}</span></div>
      <div class="row"><span class="k">TTC</span><b>${fmt(r.amount_ttc)}</b></div></div>`).join("");
    brancherMenus(c);
    $$("[data-pact]", c).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation(); fermerMenuFlottant();
      const id = b.dataset.pid;
      if (b.dataset.pact === "voir") voirPaiement(id);
      else if (confirm("Supprimer ce paiement ? Le solde de la facture sera recalculé.")) {
        try { await api(`/api/paiements/${id}`, { method: "DELETE" }); toast("Paiement supprimé"); charger(); }
        catch (err) { toast(err.message, true); }
      }
    }));
  };
  $("#filtrer").onclick = () => { page = 1; charger().catch((e) => toast(e.message, true)); };
  $("#prev").onclick = () => { if (page > 1) { page--; charger(); } };
  $("#next").onclick = () => { page++; charger(); };
  $("#n").onclick = () => dialoguePaiement(charger);
  await charger().catch((e) => toast(e.message, true));
}

async function voirPaiement(id) {
  const r = await api(`/api/paiements/${id}`).catch((e) => { toast(e.message, true); return null; });
  if (!r) return;
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<div class="dialogue"><div class="card-h"><h2>Paiement ${r.reference}</h2></div><div class="card-b">
    <div class="grid2"><div><div class="hint">Date</div><b>${(r.payment_date || "").slice(0, 10)}</b></div>
    <div><div class="hint">Type</div><b>${esc(r.type_label)}</b></div></div><br>
    <div class="grid2"><div><div class="hint">Fournisseur</div><b>${esc(r.supplier_name)}</b></div>
    <div><div class="hint">Facture d'achat</div><b>${esc(r.invoice_reference)}</b> <span class="hint">${esc(r.project_reference || "")}</span></div></div><br>
    <dl class="synth"><dt>Montant HT</dt><dd>${fmt(r.amount_ht)}</dd><dt>TVA (${r.taux_tva} %)</dt><dd>${fmt(r.tva_amount)}</dd>
    <div class="total" style="display:contents"><dt>Montant TTC</dt><dd>${fmt(r.amount_ttc)}</dd></div></dl>
    ${r.notes ? `<p><span class="hint">Notes : </span>${esc(r.notes)}</p>` : ""}
    <div class="toolbar"><button class="btn" id="x">Fermer</button></div></div></div>`;
  document.body.appendChild(fond);
  $("#x", fond).onclick = () => fond.remove();
}

async function dialoguePaiement(apres) {
  const [types, tvas, frns] = await Promise.all([
    api("/api/types-transactions").catch(() => ({ lignes: [] })),
    api("/api/tva").catch(() => ({ lignes: [] })),
    api("/api/fournisseurs?pageSize=200").catch(() => ({ lignes: [] })),
  ]);
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>Nouveau paiement fournisseur</h2></div><div class="card-b">
    <p class="hint">Le serveur refuse tout paiement dépassant le restant de la facture.</p>
    <div class="grid2"><label class="champ">Date<input name="datePaiement" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
    <label class="champ">Type *<select name="typeId" required>${types.lignes.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("")}</select></label></div><br>
    <label class="champ">Fournisseur *<select name="fournisseurId" required>${frns.lignes.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}</select></label><br>
    <label class="champ">Facture d'achat *<select name="factureAchatId" required><option value="">— Choisir d'abord le fournisseur —</option></select></label>
    <p class="hint" id="reste"></p>
    <div class="grid2"><label class="champ">Montant HT *<input name="montantHt" type="number" min="0.001" step="0.001" value="1000" required></label>
    <label class="champ">TVA *<select name="vatRateId">${tvas.lignes.map((t) => `<option value="${t.id}" data-taux="${t.rate}">${esc(t.label)}</option>`).join("")}</select></label></div>
    <p class="hint" id="ap"></p>
    <label class="champ">Notes<textarea name="notes" rows="2"></textarea></label><br>
    <p class="erreur" id="e"></p><div class="toolbar"><button class="btn primaire">Enregistrer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  const f = fond.querySelector("form");
  const selF = $("select[name=factureAchatId]", fond);
  const majFactures = async () => {
    const fid = $("select[name=fournisseurId]", fond).value;
    const r = await api(`/api/paiements/impayees?fournisseurId=${fid}`).catch(() => ({ lignes: [] }));
    selF.innerHTML = r.lignes.map((x) => `<option value="${x.id}">${esc(x.reference)} — reste ${fmt(x.reste)} (projet ${esc(x.project_reference)})</option>`).join("") || `<option value="">Aucune facture impayée</option>`;
    maj();
  };
  const maj = () => {
    const ht = Number(new FormData(f).get("montantHt")) || 0;
    const taux = Number($("select[name=vatRateId]", fond).selectedOptions[0]?.dataset.taux || 0);
    $("#ap", fond).textContent = `TTC calculé : ${fmt(ht + ht * taux / 100)} (aperçu — le serveur recalcule et contrôle le restant)`;
    const opt = selF.selectedOptions[0]?.textContent || "";
    $("#reste", fond).textContent = opt;
  };
  $("select[name=fournisseurId]", fond).onchange = majFactures;
  f.oninput = maj; majFactures();
  $("#x", fond).onclick = () => fond.remove();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(f);
    if (!fd.get("factureAchatId")) { $("#e", fond).textContent = "Choisir une facture d'achat"; return; }
    try {
      await api("/api/paiements", { method: "POST", body: JSON.stringify({
        datePaiement: fd.get("datePaiement") || null, fournisseurId: Number(fd.get("fournisseurId")),
        factureAchatId: Number(fd.get("factureAchatId")), montantHt: Number(fd.get("montantHt")),
        vatRateId: Number(fd.get("vatRateId")),
        tauxTva: Number($("select[name=vatRateId]", fond).selectedOptions[0].dataset.taux),
        typeId: Number(fd.get("typeId")), notes: fd.get("notes") || null }) });
      fond.remove(); toast("Paiement enregistré"); apres();
    } catch (err) { $("#e", fond).textContent = err.message; }
  };
}

// --- Types de transactions (master data extensible, §5) ---
async function vTypesTransactions(c) {
  c.innerHTML = `<div class="card"><div class="card-h"><h2>Types de transactions</h2><button class="btn primaire petit" id="n">+ Créer</button></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Code</th><th>Libellé</th><th>Statut</th><th class="actions">Actions</th></tr></thead><tbody id="tb"></tbody></table></div></div>
  <div class="card"><div class="card-b"><p class="hint">Référentiel utilisé par les encaissements et les paiements. Ajoutez de nouveaux types sans modifier le code (ex. espèces, virement, chèque…). Les types utilisés restent requis par l'historique.</p></div></div>`;
  const charger = async () => {
    const d = await api("/api/types-transactions?inactifs=1");
    $("#tb").innerHTML = d.lignes.map((r) => `<tr><td><b>${esc(r.code)}</b></td><td>${esc(r.label)}</td>
      <td>${r.is_active ? "Actif" : "Inactif"}</td><td class="actions">${menuActions(r, [["m", "Modifier"], ["s", r.is_active ? "Désactiver" : "Activer"]])}</td></tr>`).join("");
    brancherMenus(c);
    $$("[data-act]", c).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation(); fermerMenuFlottant();
      const obj = d.lignes.find((x) => x.id == b.dataset.id);
      if (b.dataset.act === "m") dialogueType(obj, charger);
      else { await api(`/api/types-transactions/${obj.id}`, { method: "PUT", body: JSON.stringify({ ...obj, is_active: obj.is_active ? 0 : 1 }) }); charger(); }
    }));
  };
  $("#n").onclick = () => dialogueType(null, charger);
  await charger().catch((e) => toast(e.message, true));
}
function dialogueType(obj, apres) {
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>${obj ? "Modifier le type" : "Créer un type"}</h2></div><div class="card-b">
    <label class="champ">Code *<input name="code" value="${esc(obj?.code || "")}" required placeholder="Ex. ESPECES"></label><br>
    <label class="champ">Libellé *<input name="label" value="${esc(obj?.label || "")}" required placeholder="Ex. Espèces"></label><br>
    <div class="toolbar"><button class="btn primaire">Enregistrer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  $("#x", fond).onclick = () => fond.remove();
  fond.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    const corps = Object.fromEntries(new FormData(ev.target).entries());
    try {
      if (obj) await api(`/api/types-transactions/${obj.id}`, { method: "PUT", body: JSON.stringify(corps) });
      else await api("/api/types-transactions", { method: "POST", body: JSON.stringify(corps) });
      fond.remove(); apres();
    } catch (e) { toast(e.message, true); }
  };
}

// --- Référentiels ---
async function vRef(kind, titre) {
  const c = $("#contenu");
  const conf = { clients: { url: "/api/clients", champs: [["code", "Code"], ["name", "Nom / raison sociale"], ["contact", "Contact"], ["phone", "Téléphone"], ["email", "Email"]] },
    fournisseurs: { url: "/api/fournisseurs", champs: [["code", "Code"], ["name", "Nom"], ["contact", "Contact"], ["phone", "Téléphone"], ["email", "Email"]] } }[kind];
  c.innerHTML = `<div class="card"><div class="card-h"><div class="toolbar"><input id="q" placeholder="Rechercher…"></div><button class="btn primaire petit" id="n">+ Créer</button></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Code</th><th>Nom</th><th>Contact</th><th>Téléphone</th><th>Email</th><th>Statut</th><th class="actions">Actions</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  const charger = async () => {
    const d = await api(`${conf.url}?recherche=${encodeURIComponent($("#q").value)}&inactifs=1&pageSize=100`);
    $("#tb", c) || $("#tb");
    document.getElementById("tb").innerHTML = d.lignes.map((r) => `<tr><td><b>${esc(r.code)}</b></td><td>${esc(r.name)}</td><td>${esc(r.contact || "—")}</td><td>${esc(r.phone || "—")}</td><td>${esc(r.email || "—")}</td>
      <td>${r.is_active ? "Actif" : "Inactif"}</td><td class="actions">${menuActions(r, [["m", "Modifier"], ["s", r.is_active ? "Désactiver" : "Activer"]])}</td></tr>`).join("");
    brancherMenus(c);
    $$("[data-act]", c).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      fermerMenuFlottant();
      const id = b.dataset.id;
      const obj = d.lignes.find((x) => x.id == id);
      if (b.dataset.act === "m") dialogueRef(conf, obj, charger);
      else { await api(`${conf.url}/${id}`, { method: "PUT", body: JSON.stringify({ ...obj, is_active: obj.is_active ? 0 : 1 }) }); charger(); }
    }));
  };
  $("#n", c).onclick = () => dialogueRef(conf, null, charger);
  $("#q", c).oninput = () => charger().catch(() => {});
  await charger().catch((e) => toast(e.message, true));
}
function dialogueRef(conf, obj, apres) {
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>${obj ? "Modifier" : "Créer"}</h2></div><div class="card-b">
    ${conf.champs.map(([k, l]) => `<label class="champ">${l}${k === "code" || k === "name" ? " *" : ""}<input name="${k}" value="${esc(obj?.[k] || "")}" ${k === "code" || k === "name" ? "required" : ""}></label><br>`).join("")}
    <label class="champ">Adresse<textarea name="address" rows="2">${esc(obj?.address || "")}</textarea></label><br>
    <div class="toolbar"><button class="btn primaire">Enregistrer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  $("#x", fond).onclick = () => fond.remove();
  fond.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    const corps = Object.fromEntries(new FormData(ev.target).entries());
    try {
      if (obj) await api(`${conf.url}/${obj.id}`, { method: "PUT", body: JSON.stringify(corps) });
      else await api(conf.url, { method: "POST", body: JSON.stringify({ ...corps, code: corps.code || ("REF-" + Date.now()) }) });
      fond.remove(); apres();
    } catch (e) { toast(e.message, true); }
  };
}
async function vArticles(c) {
  c.innerHTML = `<div class="card"><div class="card-h"><h2>Articles / Prestations</h2><button class="btn primaire petit" id="n">+ Créer</button></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Code</th><th>Désignation</th><th>Unité</th><th>Statut</th><th class="actions">Actions</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  const charger = async () => {
    const d = await api("/api/articles?inactifs=1&pageSize=200");
    $("#tb").innerHTML = d.lignes.map((r) => `<tr><td><b>${esc(r.code)}</b></td><td>${esc(r.designation)}</td><td>${esc(r.unit)}</td><td>${r.is_active ? "Actif" : "Inactif"}</td>
      <td class="actions">${menuActions(r, [["m", "Modifier"], ["s", r.is_active ? "Désactiver" : "Activer"]])}</td></tr>`).join("");
    brancherMenus(c);
    $$("[data-act]", c).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      fermerMenuFlottant();
      const obj = d.lignes.find((x) => x.id == b.dataset.id);
      if (b.dataset.act === "m") dialogueArticle(obj, charger);
      else { await api(`/api/articles/${obj.id}`, { method: "PUT", body: JSON.stringify({ ...obj, is_active: obj.is_active ? 0 : 1 }) }); charger(); }
    }));
  };
  $("#n").onclick = () => dialogueArticle(null, charger);
  await charger().catch((e) => toast(e.message, true));
}
function dialogueArticle(obj, apres) {
  const fond = document.createElement("div");
  fond.className = "dialogue-fond";
  fond.innerHTML = `<form class="dialogue"><div class="card-h"><h2>${obj ? "Modifier l'article" : "Créer un article"}</h2></div><div class="card-b">
    <div class="grid2"><label class="champ">Code *<input name="code" value="${esc(obj?.code || "")}" required></label>
    <label class="champ">Unité<select name="unit">${["Nuit", "Personne", "Bus", "Jour", "Forfait", "Unité"].map((u) => `<option ${u === obj?.unit ? "selected" : ""}>${u}</option>`).join("")}</select></label></div><br>
    <label class="champ">Désignation *<input name="designation" value="${esc(obj?.designation || "")}" required></label><br>
    <label class="champ">Description<textarea name="description" rows="2">${esc(obj?.description || "")}</textarea></label><br>
    <div class="toolbar"><button class="btn primaire">Enregistrer</button><button type="button" class="btn" id="x">Annuler</button></div></div></form>`;
  document.body.appendChild(fond);
  $("#x", fond).onclick = () => fond.remove();
  fond.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    const corps = Object.fromEntries(new FormData(ev.target).entries());
    try {
      if (obj) await api(`/api/articles/${obj.id}`, { method: "PUT", body: JSON.stringify(corps) });
      else await api("/api/articles", { method: "POST", body: JSON.stringify(corps) });
      fond.remove(); apres();
    } catch (e) { toast(e.message, true); }
  };
}
async function vTva(c) {
  c.innerHTML = `<div class="card"><div class="card-h"><h2>Taux de TVA</h2><span class="hint">Les projets validés conservent leur taux historique</span></div>
    <div class="tablewrap"><table class="bureau"><thead><tr><th>Code</th><th>Libellé</th><th class="num">Taux</th><th>Statut</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  const d = await api("/api/tva").catch(() => ({ lignes: [] }));
  $("#tb").innerHTML = d.lignes.map((t) => `<tr><td><b>${esc(t.code)}</b></td><td>${esc(t.label)}</td><td class="num">${t.rate} %</td><td>${t.is_active ? "Actif" : "Inactif"}</td></tr>`).join("");
}
function vParametres(c) {
  c.innerHTML = `<div class="card"><div class="card-h"><h2>Paramètres</h2></div><div class="card-b">
    <p><b>Devise :</b> Dinar tunisien (DT) — 3 décimales, arrondi half-up centralisé.</p>
    <p><b>Calcul :</b> Prix suivant = prix précédent × (1 + % / 100), ou + montant fixe. Moteur unique côté serveur.</p>
    <p><b>Statuts :</b> Brouillon → Validé / Annulé. Un projet validé est protégé (serveur) et figé historiquement.</p>
    <p class="hint">PoC — rôles futurs : Directeur, Commercial, Agent, Comptabilité, Manager, Lecture seule, Administrateur. Audit enregistré en base (table audit_logs).</p></div></div>`;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

afficher();
