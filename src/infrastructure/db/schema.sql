-- Schéma ERP événementiel (§38) — PostgreSQL (Supabase).
-- Monétaire : NUMERIC(12,3) (millimes DT), parsé en nombre côté Node.
-- Dates : TEXT ISO (cohérent avec les appels .slice() existants).
-- Règle d'arrondi unique : half-up dans src/domain/money.js.

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

CREATE TABLE IF NOT EXISTS article_categories (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  designation TEXT NOT NULL,
  category_id INTEGER REFERENCES article_categories(id),
  unit TEXT NOT NULL DEFAULT 'Unité',
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_articles_designation ON articles(designation);

CREATE TABLE IF NOT EXISTS vat_rates (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  rate NUMERIC(12,3) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Document : projet (transaction, §24, §47)
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  start_date TEXT,
  end_date TEXT CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  status TEXT NOT NULL DEFAULT 'BROUILLON' CHECK (status IN ('BROUILLON','VALIDE','ANNULE')),
  notes TEXT,
  -- Totaux persistés (recalculés backend, jamais confiés au navigateur §21)
  total_cout_grande_agence NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_marge_grande_agence NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_achat_notre_agence NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_marge_notre_agence NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0,
  -- Snapshots historiques (§24) : figent l'identité commerciale à la validation
  customer_name_snapshot TEXT,
  validated_by INTEGER REFERENCES users(id),
  validated_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_by INTEGER REFERENCES users(id),
  -- Confirmation client + numéro de devis (migrations si base antérieure)
  quote_reference TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  confirmation_note TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);
CREATE INDEX IF NOT EXISTS idx_projects_validated ON projects(validated_at);
CREATE INDEX IF NOT EXISTS idx_projects_start ON projects(start_date);

-- Lignes : appartiennent au projet (§7), prix unitaires + snapshots
CREATE TABLE IF NOT EXISTS project_lines (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  description TEXT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  unit TEXT NOT NULL DEFAULT 'Unité',
  prix_achat_grande_agence NUMERIC(12,3) NOT NULL CHECK (prix_achat_grande_agence >= 0),
  type_marge_grande_agence TEXT NOT NULL CHECK (type_marge_grande_agence IN ('POURCENTAGE','MONTANT_FIXE')),
  valeur_marge_grande_agence NUMERIC(12,3) NOT NULL CHECK (valeur_marge_grande_agence >= 0),
  type_marge_notre_agence TEXT NOT NULL CHECK (type_marge_notre_agence IN ('POURCENTAGE','MONTANT_FIXE')),
  valeur_marge_notre_agence NUMERIC(12,3) NOT NULL CHECK (valeur_marge_notre_agence >= 0),
  -- Résultats calculés (backend autoritatif)
  prix_achat_notre_agence NUMERIC(12,3) NOT NULL DEFAULT 0,
  prix_vente_notre_agence NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  montant_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0,
  vat_rate_id INTEGER REFERENCES vat_rates(id),
  taux_tva NUMERIC(12,3) NOT NULL CHECK (taux_tva >= 0 AND taux_tva <= 100),
  -- Snapshots historiques
  article_designation_snapshot TEXT,
  article_code_snapshot TEXT,
  supplier_name_snapshot TEXT,
  vat_label_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_lines_project ON project_lines(project_id);
CREATE INDEX IF NOT EXISTS idx_lines_article ON project_lines(article_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
