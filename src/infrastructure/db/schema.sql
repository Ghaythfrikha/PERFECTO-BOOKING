-- Schéma ERP événementiel (§38). SQLite PoC ; migration Postgres : REAL -> NUMERIC(12,3).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

CREATE TABLE IF NOT EXISTS article_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  designation TEXT NOT NULL,
  category_id INTEGER REFERENCES article_categories(id),
  unit TEXT NOT NULL DEFAULT 'Unité',
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_articles_designation ON articles(designation);

CREATE TABLE IF NOT EXISTS vat_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  rate REAL NOT NULL CHECK (rate >= 0 AND rate <= 100),
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Document : projet (transaction, §24, §47)
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  start_date TEXT,
  end_date TEXT CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  status TEXT NOT NULL DEFAULT 'BROUILLON' CHECK (status IN ('BROUILLON','VALIDE','ANNULE')),
  notes TEXT,
  -- Totaux persistés (recalculés backend, jamais confiés au navigateur §21)
  total_cout_grande_agence REAL NOT NULL DEFAULT 0,
  total_marge_grande_agence REAL NOT NULL DEFAULT 0,
  total_achat_notre_agence REAL NOT NULL DEFAULT 0,
  total_marge_notre_agence REAL NOT NULL DEFAULT 0,
  total_ht REAL NOT NULL DEFAULT 0,
  total_tva REAL NOT NULL DEFAULT 0,
  total_ttc REAL NOT NULL DEFAULT 0,
  -- Snapshots historiques (§24) : figent l'identité commerciale à la validation
  customer_name_snapshot TEXT,
  validated_by INTEGER REFERENCES users(id),
  validated_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);

-- Lignes : appartiennent au projet (§7), prix unitaires + snapshots
CREATE TABLE IF NOT EXISTS project_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  description TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  unit TEXT NOT NULL DEFAULT 'Unité',
  prix_achat_grande_agence REAL NOT NULL CHECK (prix_achat_grande_agence >= 0),
  type_marge_grande_agence TEXT NOT NULL CHECK (type_marge_grande_agence IN ('POURCENTAGE','MONTANT_FIXE')),
  valeur_marge_grande_agence REAL NOT NULL CHECK (valeur_marge_grande_agence >= 0),
  type_marge_notre_agence TEXT NOT NULL CHECK (type_marge_notre_agence IN ('POURCENTAGE','MONTANT_FIXE')),
  valeur_marge_notre_agence REAL NOT NULL CHECK (valeur_marge_notre_agence >= 0),
  -- Résultats calculés (backend autoritatif)
  prix_achat_notre_agence REAL NOT NULL DEFAULT 0,
  prix_vente_notre_agence REAL NOT NULL DEFAULT 0,
  total_ht REAL NOT NULL DEFAULT 0,
  montant_tva REAL NOT NULL DEFAULT 0,
  total_ttc REAL NOT NULL DEFAULT 0,
  vat_rate_id INTEGER REFERENCES vat_rates(id),
  taux_tva REAL NOT NULL CHECK (taux_tva >= 0 AND taux_tva <= 100),
  -- Snapshots historiques
  article_designation_snapshot TEXT,
  article_code_snapshot TEXT,
  supplier_name_snapshot TEXT,
  vat_label_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lines_project ON project_lines(project_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
