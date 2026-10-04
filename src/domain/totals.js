// Totaux projet (§22) : somme des lignes, jamais éditable manuellement.
import { roundMoney } from "./money.js";
import { calculateLinePricing, calculateLineTotals } from "./pricing.js";

export function calculateProjectTotals(lines) {
  const t = {
    coutGrandeAgence: 0,
    margeGrandeAgence: 0,
    achatNotreAgence: 0,
    margeNotreAgence: 0,
    prixVenteHt: 0,
    tva: 0,
    totalTtc: 0,
  };
  for (const l of lines) {
    const pricing = calculateLinePricing({
      prixAchatGrandeAgence: l.prixAchatGrandeAgence,
      typeMargeGrandeAgence: l.typeMargeGrandeAgence,
      valeurMargeGrandeAgence: l.valeurMargeGrandeAgence,
      typeMargeNotreAgence: l.typeMargeNotreAgence,
      valeurMargeNotreAgence: l.valeurMargeNotreAgence,
    });
    const lt = calculateLineTotals({
      quantite: l.quantite,
      prixAchatGrandeAgence: l.prixAchatGrandeAgence,
      prixAchatNotreAgence: pricing.prixAchatNotreAgence,
      prixVenteNotreAgence: pricing.prixVenteNotreAgence,
      tauxTva: l.tauxTva,
    });
    t.coutGrandeAgence = roundMoney(t.coutGrandeAgence + lt.totalAchatGrandeAgence);
    t.achatNotreAgence = roundMoney(t.achatNotreAgence + lt.totalAchatNotreAgence);
    t.margeGrandeAgence = roundMoney(t.margeGrandeAgence + roundMoney(lt.totalAchatNotreAgence - lt.totalAchatGrandeAgence));
    t.margeNotreAgence = roundMoney(t.margeNotreAgence + roundMoney(lt.totalHt - lt.totalAchatNotreAgence));
    t.prixVenteHt = roundMoney(t.prixVenteHt + lt.totalHt);
    t.tva = roundMoney(t.tva + lt.montantTva);
    t.totalTtc = roundMoney(t.totalTtc + lt.totalTtc);
  }
  return t;
}
