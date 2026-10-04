// Domaine financier (§6, §11, §27, §29) — fonctions pures.
// Mêmes règles que le moteur pricing : DT 3 décimales, arrondi half-up, TVA par
// montant arrondie. Le backend recalcule toujours ; le frontend n'est qu'un aperçu.
//
// DÉCISIONS PoC (isolées ici, modifiables sans toucher au reste, §31) :
// - un règlement (encaissement ou paiement) ne peut pas dépasser le restant du
//   document lié (assertWithinRemaining) ;
// - statuts de règlement DÉRIVÉS des sommes (jamais stockés, §11).
import { roundMoney } from "./money.js";

export const PAYMENT_STATUS = Object.freeze({
  NON_PAYE: "NON_PAYE",
  PARTIEL: "PARTIEL",
  TOTAL: "TOTAL",
});
export const PAYMENT_STATUS_LABELS = Object.freeze({
  NON_PAYE: "Non payée",
  PARTIEL: "Partiellement payée",
  TOTAL: "Totalement payée",
});
export const RECEIPT_STATUS_LABELS = Object.freeze({
  NON_PAYE: "Non reçu",
  PARTIEL: "Partiellement reçu",
  TOTAL: "Totalement reçu",
});

/** Montants d'une transaction à partir du HT saisi + taux TVA. Backend autoritatif. */
export function calculateTransactionAmounts(montantHt, tauxTva) {
  if (typeof montantHt !== "number" || !Number.isFinite(montantHt)) {
    throw Object.assign(new Error("Montant HT invalide"), { code: "INVALID_AMOUNT" });
  }
  if (montantHt <= 0) {
    throw Object.assign(new Error("Le montant doit être supérieur à zéro"), { code: "INVALID_AMOUNT" });
  }
  if (montantHt > 999999999.999) {
    throw Object.assign(new Error("Montant trop élevé"), { code: "AMOUNT_OVERFLOW" });
  }
  if (typeof tauxTva !== "number" || !Number.isFinite(tauxTva) || tauxTva < 0 || tauxTva > 100) {
    throw Object.assign(new Error("Taux de TVA invalide"), { code: "INVALID_VAT" });
  }
  const ht = roundMoney(montantHt);
  const tva = roundMoney((ht * tauxTva) / 100);
  return { montantHt: ht, montantTva: tva, montantTtc: roundMoney(ht + tva) };
}

/** Reste à régler : total − déjà réglé. */
export function remainingAmount(total, dejaRegle) {
  return roundMoney((Number(total) || 0) - (Number(dejaRegle) || 0));
}

/** Statut dérivé d'un document à partir de son total et du cumulé réglé. */
export function derivePaymentStatus(total, dejaRegle) {
  const t = roundMoney(Number(total) || 0);
  const p = roundMoney(Number(dejaRegle) || 0);
  if (p <= 0) return PAYMENT_STATUS.NON_PAYE;
  if (p < t) return PAYMENT_STATUS.PARTIEL;
  return PAYMENT_STATUS.TOTAL;
}

/** Garde-fou : un règlement ne dépasse pas le restant du document lié. */
export function assertWithinRemaining(total, dejaRegle, nouveauMontantTtc, quoi = "règlement") {
  const reste = remainingAmount(total, dejaRegle);
  if (nouveauMontantTtc - reste > 0.0005) {
    throw Object.assign(
      new Error(`Ce ${quoi} dépasse le restant à régler (${reste} DT)`),
      { code: "OVERPAYMENT" }
    );
  }
}
