// Monnaie — calculs décimaux sûrs (§23).
// Stratégie PoC : arrondi half-up à 3 décimales après CHAQUE étape de prix,
// totaux de lignes arrondis à 3 décimales, TVA par ligne arrondie à 3 décimales
// puis sommée. Règle unique et centralisée (ne pas dupliquer ailleurs).
// Migration Postgres future : NUMERIC(12,3).

import { CURRENCY_DECIMALS } from "./constants.js";

const FACTOR = 10 ** CURRENCY_DECIMALS;

export function roundMoney(value) {
  if (!Number.isFinite(value)) throw new Error("Montant invalide");
  // half-up, évite les erreurs binaires flottantes
  return Math.round((value + Number.EPSILON) * FACTOR) / FACTOR;
}

export function assertMoney(value, field = "montant") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Object.assign(new Error(`${field} : montant invalide`), { code: "INVALID_MONEY" });
  }
  if (value < 0) {
    throw Object.assign(new Error(`${field} : ne peut pas être négatif`), { code: "NEGATIVE_MONEY" });
  }
  if (value > 999999999.999) {
    throw Object.assign(new Error(`${field} : montant trop élevé`), { code: "MONEY_OVERFLOW" });
  }
}

export function assertQuantity(qte) {
  if (typeof qte !== "number" || !Number.isFinite(qte)) {
    throw Object.assign(new Error("Quantité invalide"), { code: "INVALID_QUANTITY" });
  }
  if (qte <= 0) {
    throw Object.assign(new Error("La quantité doit être supérieure à zéro"), { code: "INVALID_QUANTITY" });
  }
  if (qte > 1000000) {
    throw Object.assign(new Error("Quantité trop élevée"), { code: "INVALID_QUANTITY" });
  }
}

export function formatMoney(value) {
  const n = Number(value) || 0;
  return (
    n.toLocaleString("fr-TN", {
      minimumFractionDigits: CURRENCY_DECIMALS,
      maximumFractionDigits: CURRENCY_DECIMALS,
    }) + " DT"
  );
}
