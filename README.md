# ERP Événementiel — PoC

Application ERP interne (en français) pour une agence d'organisation d'événements :
projets/devis, chaîne de prix (fournisseur → Vos Voyage → Perfecto Booking), TVA, validation
protégée, référentiels clients / fournisseurs / articles / TVA.

## Démarrage

## Démarrage (PostgreSQL / Supabase)

1. Créez **2 projets gratuits** sur Supabase (base réelle + base de tests) :
   Dashboard Supabase → New Project (×2).
2. Pour chaque projet : Project Settings → Database → **Connection string (URI)**
   et copiez-la.
3. Renseignez `.env` (jamais commité, voir `.gitignore`) :
   `DATABASE_URL` = URI du projet réel, `TEST_DATABASE_URL` = URI du projet de test.
   Format : `postgresql://postgres:[MOT-DE-PASSE]@db.[REF].supabase.co:5432/postgres`
4. Puis :

```powershell
npm install
npm run init-db   # crée le schéma + compte directeur sur Supabase
npm test          # 42 tests (schémas de test isolés, jamais la base réelle)
npm start         # http://localhost:3000
```

## Déploiement Vercel (frontend + API, base Supabase)

Le projet est prêt pour Vercel : `api/index.js` expose l'app Express en serverless,
`vercel.json` route tout vers elle, `.vercelignore` exclut l'ancienne base locale.

1. `npm i -g vercel` puis `vercel` dans le dossier (suivez l'assistant, Hobby gratuit).
2. Variables d'environnement Vercel (Settings → Environment Variables) :
   - `DATABASE_URL` = **URI pooler** Supabase (port `6543`, mode transaction) :
     `postgresql://postgres.[REF]:[MOT-DE-PASSE]@aws-0-[REGION].pooler.supabase.com:6543/postgres`
   - `PGPOOL_MAX` = `2` (instances serverless éphémères)
   - `JWT_SECRET` = chaîne longue et aléatoire
3. `npm run init-db` **une fois** en local avec `DATABASE_URL` pointant sur Supabase
   (crée le schéma + le compte directeur), puis `vercel --prod`.
4. Limites connues (Hobby) : cold start ~1 s occasionnel, timeout de fonction
   adapté aux PDF et requêtes courantes ; rien à changer dans le code métier.

Compte PoC : `directeur@agence.tn` / `Directeur123!`

## Cycle métier

```text
Brouillon → Devis validé (DEV-) → Commandes d'achat auto (CA-, 1/fournisseur, au PA Vos Voyage)
→ Confirmé par le client → Facture de vente (FV-, aux prix de vente) + Factures d'achat (FA-, 1/commande)
```

## Extension financière : documents validés + transactions

- **Documents auto-générés directement `VALIDÉE`** (jamais `BROUILLON`) : CA, FA, FV naissent
  avec `validated_by/at` en base ; protection backend (ni modification ni suppression).
  Cycles : commande `Brouillon → Validée → Clôturée`, factures `Brouillon → Validée → Annulée`.
- **Encaissements reçus** (`received_transactions`, `ENC-…`) : argent effectivement reçu de
  Vos Voyage. Saisie HT + taux TVA → TTC recalculé serveur. Lien optionnel vers 1 facture
  de vente (1 facture → N encaissements) ; `CA reçu = Σ encaissements`.
- **Paiements fournisseurs** (`supplier_payments`, `PAY-…`) : Vos Voyage → fournisseur,
  `supplier_id` + `purchase_invoice_id` en vraies FK. Dépassement du restant refusé ;
  solde et statut (`Non payée / Partiellement / Totalement`) **dérivés** des mouvements.
- **Types de transactions** en master data (`transaction_types` : Espèces, Virement, Chèque,
  Carte, Autre) — extensible sans code. Suppression d'un mouvement autorisée (correction
  d'erreur, auditée) ; suppression d'un document validé interdite.
- **Traçabilité** : `Projet → Lignes → Factures → Transactions`, `project_reference` partout.
- **Dashboard** : CA vendu / facturé / reçu, achats facturés / payés / reste,
  marge facturée (HT) = Σ (prix de vente − coût d'achat snapshoté) × quantité
  sur les lignes des factures de vente validées (sans lien avec les factures d'achat).
- **Décisions PoC isolées** (`src/domain/payments.js`) : pas de dépassement du restant,
  statuts dérivés, 1 encaissement → 1 facture max (N→N futur via table d'affectation).

```powershell
npm test   # 42 tests : pricing, documents, finance, dashboard+PDF (bases isolées)
```

## Dashboard de pilotage

- Endpoint unique agrégé côté SQL : `GET /api/tableau-de-bord/pilotage?debut=&fin=&clientId=&fournisseurId=&categorieId=&statut=` (service `src/application/dashboard.js`, aucune règle dans le frontend).
- Filtres globaux (période prédéfinie/personnalisée, client, fournisseur, catégorie, statut) ; axe temps unique : **mois de l'événement** pour tout ce qui dérive des projets (cohérence sections/KPI), dates d'émission/transaction pour factures et encaissements.
- Sections : KPI (vendu/facturé/reçu HT + reste à payer), courbe CA 3 séries (SVG, sans librairie), situation projets (effectifs + brouillons + marges négatives, sans taux inventé), factures d'achat (totaux + à-surveiller, statuts dérivés), tops fournisseurs/clients (jamais de « reçu par client »), CA par catégorie (barres), rentabilité (CA/coût/marge montants), alertes actionnables (navigation directe, jamais de « vente impayée »), activité récente (audit existant).
- PDF : en-têtes systématiques et répétés à chaque page, date d'impression, nombres alignés à droite, message si zéro ligne (`compress:false` + `bufferPages:true`).

- Validation : recalcul + `DEV-AAAA-NNN` + commandes groupées par fournisseur, **même transaction**.
- Confirmation (`confirmerProjet`) : `confirmed_at/by/note` + FV + FAs, atomique, idempotente.
- Cycles propres : commande `Brouillon → Validée → Clôturée`, factures `Brouillon → Validée → Annulée`.
  Document validé : ni modifiable ni supprimable (serveur).
- Traçabilité : `project_id` + `project_reference` sur chaque pièce ; lignes liées
  (`project_line_id`, `purchase_order_line_id`) ; snapshots (noms, prix, TVA) figés.
- PDF serveur déterministes : `GET /api/projets/:id/devis/pdf`,
  `/api/commandes-achat/:id/pdf`, `/api/factures-vente/:id/pdf`, `/api/factures-achat/:id/pdf`.
- UI : section **Documents liés** sur la fiche projet (Voir/PDF), pages
  **Commandes d'achat** et **Factures** (onglets Vente/Achat), bouton **Confirmer**.

## Architecture

```text
src/domain/            → pricing.js (moteur UNIQUE), totals.js, money.js (DT, 3 déc.,
                         arrondi half-up), validation.js (invariants), constants.js
                         (statuts BROUILLON/VALIDE/ANNULE + transitions)
src/application/       → projects.js : createProject, add/update/removeLine,
                         calculateProject, validateProject (transaction atomique,
                         recalcul serveur, snapshots historiques), cancelProject,
                         duplicateProject. Refuse toute modif d'un projet VALIDE/ANNULE.
src/infrastructure/db/ → schema.sql + database.js (PostgreSQL via `pg` : Pool,
                         NUMERIC(12,3) parsé en nombre, SSL Supabase, migrations
                         idempotentes, transactions), init.js (seed : rôles, directeur,
                         clients, fournisseurs, articles, TVA 0/7/13/19)
src/presentation/api/  → server.js (REST + JWT + bcrypt, référentiels, projets,
                         tableau de bord) + web/ (index.html, styles.css, app.js —
                         UI 100 % française, responsive, design system ERP dense)
tests/pricing.test.js  → nominaux (100+20%=120, 120+15%=138, 20×138=2760, TVA),
                         limites (quantité/prix négatifs, marge zéro, arrondis,
                         TVA invalide), machine à états
```

## Règles métier appliquées

- `Prix suivant = prix précédent × (1 + % / 100)` ou `+ montant fixe` (§14–16).
  Le `%` est une **majoration** (code : `markup*`), libellé UI « Marge ».
- Seul le backend recalcule avant persistance/validation ; totaux jamais éditables.
- Validation : contrôle en-tête + lignes + recalcul + snapshots (noms client/article/
  fournisseur, taux TVA) + `status=VALIDE` + `validated_by/at`, le tout en transaction.
- `BROUILLON → VALIDE | ANNULE` uniquement ; document validé protégé côté serveur.
- Devise DT, 3 décimales, TVA par ligne arrondie puis sommée (règle unique).

## Décisions PoC (isolées, réversibles)

- PostgreSQL hébergé (Supabase) : `DATABASE_URL` pour l'app, `TEST_DATABASE_URL`
  (2ᵉ projet gratuit) + `TEST_SCHEMA` par fichier pour les tests, sans jamais
  toucher la base réelle. L'ancien fichier local `data/erp.db` n'est plus utilisé
  (conservé tel quel sur disque, aucune donnée effacée).
- Référence auto `P-AAAA-NNNN`.
- Auth JWT + rôles extensibles (`roles`), un seul utilisateur seedé.
