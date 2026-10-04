// Moteur de pricing — UNIQUE implémentation autoritative (§14, §16, §20, §21).
// Indépendant de React/HTTP/DB. Testable isolément.
//
// Chaîne :
//   prixAchatGrandeAgence                (prix d'achat Vos Voyage)
//     --(+majoration Vos Voyage)--> prixAchatNotreAgence
//     --(+majoration Perfecto Booking) --> prixVenteNotreAgence
//
// NOTE TERMINOLOGIE (§14) : le "%" décrit est une MAJORATION
// (prix × (1 + t/100)), pas une marge comptable vraie
// ((PV-PR)/PV). Nommage domaine explicite : "markup".
// Le libellé UI reste "Marge" (exigence métier), mais le code
// utilise markup* pour permettre un changement futur isolé ici.

import { MARGIN_TYPE } from "./constants.js";
import { roundMoney, assertMoney, assertQuantity } from "./money.js";

function applyMarkup(basePrice, marginType, marginValue) {
  assertMoney(basePrice, "Prix de base");
  if (typeof marginValue !== "number" || !Number.isFinite(marginValue)) {
    throw Object.assign(new Error("Valeur de marge invalide"), { code: "INVALID_MARGIN" });
  }
  if (marginValue < 0) {
    throw Object.assign(new Error("La marge ne peut pas être négative"), { code: "INVALID_MARGIN" });
  }
  if (marginType === MARGIN_TYPE.POURCENTAGE) {
    if (marginValue > 1000) {
      throw Object.assign(new Error("Pourcentage de marge trop élevé"), { code: "INVALID_MARGIN" });
    }
    return roundMoney(basePrice * (1 + marginValue / 100));
  }
  if (marginType === MARGIN_TYPE.MONTANT_FIXE) {
    assertMoney(marginValue, "Marge (montant)");
    return roundMoney(basePrice + marginValue);
  }
  throw Object.assign(new Error("Type de marge invalide"), { code: "INVALID_MARGIN_TYPE" });
}

/**
 * Calcule les prix unitaires d'une ligne.
 * @returns {{ prixAchatNotreAgence, prixVenteNotreAgence, margeGrandeAgenceMontant, margeNotreAgenceMontant }}
 */
export function calculateLinePricing({
  prixAchatGrandeAgence,
  typeMargeGrandeAgence,
  valeurMargeGrandeAgence,
  typeMargeNotreAgence,
  valeurMargeNotreAgence,
}) {
  assertMoney(prixAchatGrandeAgence, "Prix d'achat Vos Voyage");
  const prixAchatNotreAgence = applyMarkup(
    prixAchatGrandeAgence,
    typeMargeGrandeAgence,
    valeurMargeGrandeAgence
  );
  const prixVenteNotreAgence = applyMarkup(
    prixAchatNotreAgence,
    typeMargeNotreAgence,
    valeurMargeNotreAgence
  );
  return {
    prixAchatNotreAgence,
    prixVenteNotreAgence,
    // montants de majoration effectifs (pour synthèse financière)
    margeGrandeAgenceMontant: roundMoney(prixAchatNotreAgence - prixAchatGrandeAgence),
    margeNotreAgenceMontant: roundMoney(prixVenteNotreAgence - prixAchatNotreAgence),
  };
}

/**
 * Calcule les totaux d'une ligne (quantité × prix unitaires + TVA).
 */
export function calculateLineTotals({ quantite, prixAchatGrandeAgence, prixAchatNotreAgence, prixVenteNotreAgence, tauxTva }) {
  assertQuantity(quantite);
  if (typeof tauxTva !== "number" || !Number.isFinite(tauxTva) || tauxTva < 0 || tauxTva > 100) {
    throw Object.assign(new Error("Taux de TVA invalide"), { code: "INVALID_VAT" });
  }
  const totalAchatGrandeAgence = roundMoney(quantite * prixAchatGrandeAgence);
  const totalAchatNotreAgence = roundMoney(quantite * prixAchatNotreAgence);
  const totalHt = roundMoney(quantite * prixVenteNotreAgence);
  const montantTva = roundMoney((totalHt * tauxTva) / 100);
  const totalTtc = roundMoney(totalHt + montantTva);
  return { totalAchatGrandeAgence, totalAchatNotreAgence, totalHt, montantTva, totalTtc };
}
