-- Extension financière : types de transactions, encaissements (Vos Voyage → Perfecto Booking),
-- paiements fournisseurs (Vos Voyage → fournisseur). Deux flux séparés (§14),
-- vraies clés étrangères (§15), statuts de paiement DÉRIVÉS (jamais stockés, §11).
PRAGMA foreign_keys = ON;

-- Master data extensible (§5) : aucun type en dur dans le code métier.
CREATE TABLE IF NOT EXISTS transaction_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Argent effectivement reçu par Perfecto Booking depuis Vos Voyage (§3-§8).
-- Lien facture de vente optionnel (1 facture → N encaissements) ; lien N→N futur
-- passera par une table d'affectation sans toucher à celle-ci.
CREATE TABLE IF NOT EXISTS received_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  transaction_date TEXT NOT NULL DEFAULT (date('now')),
  amount_ht REAL NOT NULL CHECK (amount_ht > 0),
  vat_rate_id INTEGER REFERENCES vat_rates(id),
  taux_tva REAL NOT NULL CHECK (taux_tva >= 0 AND taux_tva <= 100),
  vat_label_snapshot TEXT,
  tva_amount REAL NOT NULL DEFAULT 0,
  amount_ttc REAL NOT NULL DEFAULT 0,
  transaction_type_id INTEGER NOT NULL REFERENCES transaction_types(id),
  sales_invoice_id INTEGER REFERENCES sales_invoices(id),
  project_id INTEGER REFERENCES projects(id),
  project_reference TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rt_invoice ON received_transactions(sales_invoice_id);
CREATE INDEX IF NOT EXISTS idx_rt_project ON received_transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_rt_date ON received_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_rt_type ON received_transactions(transaction_type_id);

-- Montants versés par Vos Voyage aux fournisseurs (§9-§12).
-- Références réelles (jamais de texte libre, §10).
CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  payment_date TEXT NOT NULL DEFAULT (date('now')),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
  amount_ht REAL NOT NULL CHECK (amount_ht > 0),
  vat_rate_id INTEGER REFERENCES vat_rates(id),
  taux_tva REAL NOT NULL CHECK (taux_tva >= 0 AND taux_tva <= 100),
  vat_label_snapshot TEXT,
  tva_amount REAL NOT NULL DEFAULT 0,
  amount_ttc REAL NOT NULL DEFAULT 0,
  transaction_type_id INTEGER NOT NULL REFERENCES transaction_types(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sp_invoice ON supplier_payments(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_sp_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sp_date ON supplier_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_sp_type ON supplier_payments(transaction_type_id);
