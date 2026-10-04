// Domaine documentaire (§54–§60, §67) — fonctions pures, testables sans DB.
// Règles cardinales :
// - Commande/facture d'achat : PRIX D'ACHAT GRANDE AGENCE uniquement, jamais le prix de vente.
// - Facture de vente : PRIX DE VENTE de Perfecto Booking uniquement, jamais le prix d'achat.
// - Une commande par fournisseur et par projet. Idempotence gérée en couche application.
import { roundMoney } from "./money.js";

/** Regroupe les lignes de projet par fournisseur. Lève si une ligne n'a pas de fournisseur. */
export function groupProjectLinesBySupplier(projectLines) {
  const groups = new Map();
  for (const l of projectLines) {
    if (!l.supplier_id && !l.fournisseurId) {
      throw Object.assign(new Error("Une ligne sans fournisseur ne peut pas générer de commande d'achat"), { code: "PO_NO_SUPPLIER" });
    }
    const key = l.supplier_id ?? l.fournisseurId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  return groups;
}

function lineAmount(quantity, unitPrice, tauxTva) {
  const totalHt = roundMoney(quantity * unitPrice);
  const montantTva = roundMoney((totalHt * tauxTva) / 100);
  return { totalHt, montantTva, totalTtc: roundMoney(totalHt + montantTva) };
}

/** Construit les lignes de commande d'achat depuis un groupe (prix = PA Vos Voyage). */
export function buildPurchaseOrderLines(group) {
  return group.map((l) => {
    const unitPrice = l.prix_achat_grande_agence ?? l.prixAchatGrandeAgence;
    if (typeof unitPrice !== "number" || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw Object.assign(new Error("Prix d'achat Vos Voyage invalide pour la commande"), { code: "INVALID_PO_PRICE" });
    }
    const quantity = l.quantity ?? l.quantite;
    const tauxTva = l.taux_tva ?? l.tauxTva ?? 0;
    const m = lineAmount(quantity, unitPrice, tauxTva);
    return {
      projectLineId: l.id ?? null,
      designation: l.article_designation_snapshot || l.article_designation || l.designation || "Prestation",
      code: l.article_code_snapshot || l.article_code || null,
      description: l.description || null,
      quantity, unit: l.unit || "Unité",
      unitPrice, tauxTva,
      vatLabel: l.vat_label_snapshot || l.vat_label || null,
      ...m,
    };
  });
}

/** Construit les lignes de facture de vente (prix = prix de vente validé, jamais recalculé). */
export function buildSalesInvoiceLines(projectLines) {
  return projectLines.map((l) => {
    const unitPrice = l.prix_vente_notre_agence ?? l.prixVenteNotreAgence;
    if (typeof unitPrice !== "number" || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw Object.assign(new Error("Prix de vente invalide pour la facturation"), { code: "INVALID_SI_PRICE" });
    }
    const coutAchat = l.prix_achat_notre_agence ?? l.prixAchatNotreAgence ?? null;
    const quantity = l.quantity ?? l.quantite;
    const tauxTva = l.taux_tva ?? l.tauxTva ?? 0;
    const m = lineAmount(quantity, unitPrice, tauxTva);
    return {
      projectLineId: l.id ?? null,
      designation: l.article_designation_snapshot || l.article_designation || l.designation || "Prestation",
      code: l.article_code_snapshot || l.article_code || null,
      description: l.description || null,
      quantity, unit: l.unit || "Unité",
      unitPrice, tauxTva,
      coutAchat,
      vatLabel: l.vat_label_snapshot || l.vat_label || null,
      ...m,
    };
  });
}

/** Marge HT d'une ligne de facture de vente : (prix de vente − coût d'achat) × quantité.
 *  Sans coût connu : marge 0 (jamais gonflée artificiellement). */
export function calculateInvoiceLineMargin(unitPrice, coutAchat, quantity) {
  const cout = typeof coutAchat === "number" && Number.isFinite(coutAchat) ? coutAchat : unitPrice;
  return roundMoney((unitPrice - cout) * quantity);
}

/** Construit les lignes de facture d'achat depuis les lignes de commande (traçabilité fine). */
export function buildPurchaseInvoiceLines(poLines) {
  return poLines.map((l) => {
    const m = lineAmount(l.quantity, l.unit_price, l.taux_tva);
    return {
      purchaseOrderLineId: l.id ?? null,
      projectLineId: l.project_line_id ?? null,
      designation: l.article_designation_snapshot,
      code: l.article_code_snapshot,
      description: l.description,
      quantity: l.quantity, unit: l.unit,
      unitPrice: l.unit_price, tauxTva: l.taux_tva,
      vatLabel: l.vat_label_snapshot,
      ...m,
    };
  });
}

/** Somme HT/TVA/TTC d'un ensemble de lignes construites. */
export function sumDocLines(lines) {
  return lines.reduce(
    (t, l) => ({
      totalHt: roundMoney(t.totalHt + l.totalHt),
      totalTva: roundMoney(t.totalTva + l.montantTva),
      totalTtc: roundMoney(t.totalTtc + l.totalTtc),
    }),
    { totalHt: 0, totalTva: 0, totalTtc: 0 }
  );
}
