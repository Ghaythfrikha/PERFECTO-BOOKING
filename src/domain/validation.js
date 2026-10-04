// Validation métier des invariants (§25, §45).
import { PROJECT_STATUS, MARGIN_TYPE } from "./constants.js";
import { assertMoney, assertQuantity } from "./money.js";

export function validateProjectHeader({ reference, titre, clientId, dateDebut, dateFin, statut }) {
  const errors = [];
  if (!titre || !String(titre).trim()) errors.push("Le nom du projet est obligatoire");
  if (!clientId) errors.push("Le client est obligatoire");
  if (!Object.values(PROJECT_STATUS).includes(statut)) errors.push("Statut invalide");
  if (dateDebut && dateFin && dateDebut > dateFin)
    errors.push("La date de fin doit être postérieure à la date de début");
  if (reference !== undefined && reference !== null && !String(reference).trim())
    errors.push("Référence invalide");
  return errors;
}

export function validateProjectLineInput(l) {
  const errors = [];
  if (!l.articleId) errors.push("Article obligatoire");
  if (!l.fournisseurId) errors.push("Fournisseur obligatoire");
  try { assertQuantity(l.quantite); } catch (e) { errors.push(e.message); }
  try { assertMoney(l.prixAchatGrandeAgence, "Prix d'achat Vos Voyage"); } catch (e) { errors.push(e.message); }
  if (!Object.values(MARGIN_TYPE).includes(l.typeMargeGrandeAgence)) errors.push("Type de marge Vos Voyage invalide");
  if (!Object.values(MARGIN_TYPE).includes(l.typeMargeNotreAgence)) errors.push("Type de marge Perfecto Booking invalide");
  for (const [v, lbl] of [[l.valeurMargeGrandeAgence, "Marge Vos Voyage"], [l.valeurMargeNotreAgence, "Marge Perfecto Booking"]]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(`${lbl} invalide`);
  }
  if (typeof l.tauxTva !== "number" || !Number.isFinite(l.tauxTva) || l.tauxTva < 0 || l.tauxTva > 100)
    errors.push("Taux de TVA invalide");
  return errors;
}

export function validateProjectForValidation(project, lines) {
  const errors = validateProjectHeader(project);
  if (!project.clientId) errors.push("Un client est requis avant validation");
  if (!lines || lines.length === 0) errors.push("Le projet doit contenir au moins une prestation");
  (lines || []).forEach((l, i) => {
    for (const e of validateProjectLineInput(l)) errors.push(`Ligne ${i + 1} : ${e}`);
    if (l.articleInactif) errors.push(`Ligne ${i + 1} : article inactif`);
    if (l.fournisseurInactif) errors.push(`Ligne ${i + 1} : fournisseur inactif`);
  });
  if (project.statut !== PROJECT_STATUS.BROUILLON)
    errors.push("Seul un projet en brouillon peut être validé");
  return errors;
}
