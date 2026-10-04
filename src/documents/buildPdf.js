// Couche documentaire (§62) : Application → Document Generation Service → Template → PDF Renderer → PDF.
// Déterministe : utilise UNIQUEMENT les snapshots persistés (jamais les référentiels courants).
import PDFDocument from "pdfkit";

function fmt(n) {
  return (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function header(doc, { titre, reference, date, refProjet, refExtra }) {
  const imprimeLe = new Date().toLocaleDateString("fr-FR");
  doc.fontSize(9).fillColor("#5d6b80").font("Helvetica")
    .text("AGENCE ÉVÉNEMENTIELLE — ERP interne", 40, 40)
    .fontSize(20).fillColor("#1b4f72").font("Helvetica-Bold").text(titre, 40, 58);
  doc.fontSize(10).fillColor("#1a2433").font("Helvetica")
    .text(`N° ${reference}`, 40, 86)
    .text(`Date : ${date}`, 40, 100)
    .font("Helvetica-Bold").text(`Référence projet : ${refProjet}`, 40, 114).font("Helvetica");
  if (refExtra) doc.text(refExtra, 40, 128);
  doc.fontSize(8).fillColor("#5d6b80").text(`Imprimé le ${imprimeLe}`, 400, 40, { align: "right", width: 155 });
  return refExtra ? 150 : 136;
}

function blocTiers(doc, y, titre, lignes) {
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#1b4f72").text(titre, 40, y);
  doc.fontSize(9).font("Helvetica").fillColor("#1a2433");
  lignes.filter(Boolean).forEach((l) => { doc.text(l, 40, (y += 13)); });
  return y + 22;
}

// Colonnes fixes = en-têtes stables, générés depuis la définition du tableau (§20).
// En-têtes présents même à 0 ligne, répétés sur chaque page (§18-19), nombres alignés à droite.
const COLS = [40, 270, 330, 390, 440, 500]; // Prestation | Qté | P.U. HT | TVA | Montant HT | TTC
const ENTETES = ["Prestation", "Qté", "P.U. HT", "TVA", "Montant HT", "TTC"];
const NUMERIQUES = new Set([1, 2, 3, 4, 5]);

function dessinerEntetes(doc, y) {
  doc.fontSize(8).font("Helvetica-Bold").fillColor("#ffffff");
  doc.rect(40, y, 515, 18).fill("#1b4f72");
  ENTETES.forEach((h, i) => {
    const x = COLS[i] + 4, w = (COLS[i + 1] || 555) - COLS[i] - 8;
    doc.text(h, x, y + 5, { width: w, align: NUMERIQUES.has(i) ? "right" : "left" });
  });
  return y + 18;
}

function tableau(doc, y, lignes) {
  y = dessinerEntetes(doc, y);
  doc.font("Helvetica").fillColor("#1a2433");
  const ligneH = 30;
  const corps = (lignes && lignes.length ? lignes : [null]); // en-têtes même à zéro ligne
  for (const l of corps) {
    if (y + ligneH > 760) { doc.addPage(); y = dessinerEntetes(doc, 50); doc.font("Helvetica").fillColor("#1a2433"); }
    if (l === null) {
      doc.fontSize(8).fillColor("#5d6b80").text("Aucune ligne", COLS[0] + 4, y + 8);
      doc.fillColor("#1a2433");
      y += ligneH;
      continue;
    }
    if (Math.floor(y / ligneH) % 2 === 0) { doc.rect(40, y, 515, ligneH).fill("#f3f5f7"); doc.fillColor("#1a2433"); }
    doc.fontSize(8).font("Helvetica-Bold").text(l.designation || "—", COLS[0] + 4, y + 4, { width: COLS[1] - COLS[0] - 8 });
    doc.font("Helvetica").fontSize(7).fillColor("#5d6b80");
    if (l.description) doc.text(String(l.description).slice(0, 120), COLS[0] + 4, y + 15, { width: COLS[1] - COLS[0] - 8 });
    doc.fillColor("#1a2433").fontSize(8);
    const num = (i, txt) => doc.text(txt, COLS[i] + 4, y + 8, { width: (COLS[i + 1] || 555) - COLS[i] - 8, align: "right" });
    num(1, `${l.quantity} ${l.unit || ""}`);
    num(2, `${fmt(l.unitPrice)}`);
    num(3, `${l.tauxTva} %`);
    num(4, `${fmt(l.totalHt)}`);
    doc.font("Helvetica-Bold");
    num(5, `${fmt(l.totalTtc)}`);
    doc.font("Helvetica");
    y += ligneH;
  }
  return y + 6;
}

function totaux(doc, y, lignes) {
  const x = 340;
  doc.fontSize(9).font("Helvetica").fillColor("#1a2433");
  for (const [lib, val] of lignes) {
    doc.text(lib, x, y); doc.text(`${fmt(val)} DT`, 460, y, { align: "right", width: 95 });
    y += 14;
  }
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#1b4f72");
  return y;
}

/** Génère un PDF. Retourne un Buffer. */
export function genererPdf({ titre, reference, date, refProjet, refExtra = null, tiersTitre, tiersLignes, lignes, totauxLignes, totalTtc, notes = null }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, compress: false, bufferPages: true, info: { Title: `${titre} ${reference}`, Author: "ERP Événementiel" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let y = header(doc, { titre, reference, date: (date || "").slice(0, 10), refProjet, refExtra });
    y = blocTiers(doc, y, tiersTitre, tiersLignes);
    y = tableau(doc, y, lignes);
    y = totaux(doc, y, totauxLignes);
    doc.fontSize(11).text(`TOTAL TTC : ${fmt(totalTtc)} DT`, 340, y + 4);
    y += 30;
    if (notes) {
      if (y > 700) { doc.addPage(); y = 50; }
      doc.fontSize(9).font("Helvetica").fillColor("#5d6b80").text(`Notes : ${notes}`, 40, y, { width: 515 });
    }
    // Pied de page + pagination
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor("#8a97ab").font("Helvetica")
        .text(`${titre} ${reference} — Réf. projet ${refProjet} — Document généré par l'ERP (valeur interne)`,
          40, 812, { width: 440 })
        .text(`Page ${i + 1} / ${pages.count}`, 480, 812, { width: 75, align: "right" });
    }
    doc.end();
  });
}
