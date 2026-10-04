// Domaine — constantes centrales (aucune chaîne de statut dispersée).
// Statuts affichés en FR via PROJECT_STATUS_LABELS.

export const PROJECT_STATUS = Object.freeze({
  BROUILLON: "BROUILLON",
  VALIDE: "VALIDE",
  ANNULE: "ANNULE",
});

export const PROJECT_STATUS_LABELS = Object.freeze({
  BROUILLON: "Brouillon",
  VALIDE: "Validé",
  ANNULE: "Annulé",
});

export const MARGIN_TYPE = Object.freeze({
  POURCENTAGE: "POURCENTAGE",
  MONTANT_FIXE: "MONTANT_FIXE",
});

export const MARGIN_TYPE_LABELS = Object.freeze({
  POURCENTAGE: "%",
  MONTANT_FIXE: "DT",
});

// Devise : Dinar tunisien, 3 décimales (millimes). Arrondi : half-up.
export const CURRENCY = "DT";
export const CURRENCY_DECIMALS = 3;

// Cycles de vie documentaires (§59) — chaque type a son propre cycle, extensible.
export const PO_STATUS = Object.freeze({
  BROUILLON: "BROUILLON",
  VALIDEE: "VALIDEE",
  CLOTUREE: "CLOTUREE",
});
export const PO_STATUS_LABELS = Object.freeze({
  BROUILLON: "Brouillon",
  VALIDEE: "Validée",
  CLOTUREE: "Clôturée",
});
export const INVOICE_STATUS = Object.freeze({
  BROUILLON: "BROUILLON",
  VALIDEE: "VALIDEE",
  ANNULEE: "ANNULEE",
});
export const INVOICE_STATUS_LABELS = Object.freeze({
  BROUILLON: "Brouillon",
  VALIDEE: "Validée",
  ANNULEE: "Annulée",
});

const PO_TRANSITIONS = Object.freeze({
  BROUILLON: ["VALIDEE"],
  VALIDEE: ["CLOTUREE"],
  CLOTUREE: [],
});
const INVOICE_TRANSITIONS = Object.freeze({
  BROUILLON: ["VALIDEE"],
  VALIDEE: ["ANNULEE"],
  ANNULEE: [],
});

export function assertDocTransition(kind, from, to) {
  const table = kind === "PO" ? PO_TRANSITIONS : INVOICE_TRANSITIONS;
  if (!table[from] || !table[from].includes(to)) {
    throw Object.assign(new Error(`Transition documentaire interdite : ${from} → ${to}`), { code: "INVALID_TRANSITION" });
  }
}
// Transitions projet autorisées (§26). Explicite, pas de transition arbitraire.
const ALLOWED_TRANSITIONS = Object.freeze({
  BROUILLON: ["VALIDE", "ANNULE"],
  VALIDE: [],
  ANNULE: [],
});

export function canTransitionProject(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

export function assertTransitionProject(from, to) {
  if (!Object.values(PROJECT_STATUS).includes(from)) {
    throw Object.assign(new Error(`Statut source invalide : ${from}`), { code: "INVALID_STATUS" });
  }
  if (!Object.values(PROJECT_STATUS).includes(to)) {
    throw Object.assign(new Error(`Statut cible invalide : ${to}`), { code: "INVALID_STATUS" });
  }
  if (!canTransitionProject(from, to)) {
    throw Object.assign(
      new Error(`Transition interdite : ${from} → ${to}`),
      { code: "INVALID_TRANSITION" }
    );
  }
}
