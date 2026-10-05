-- Extension cycle métier §63 : commandes d'achat, factures de vente, factures d'achat.
-- Chaque document porte project_id + project_reference (traçabilité §55) et des
-- snapshots documentaires (§60) : jamais reconstruit depuis les référentiels courants.
-- PostgreSQL (Supabase) : SERIAL, NUMERIC(12,3), dates TEXT ISO.

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  project_reference TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name_snapshot TEXT NOT NULL,
  supplier_address_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'BROUILLON' CHECK (status IN ('BROUILLON','VALIDEE','CLOTUREE')),
  subtotal_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  validated_by INTEGER REFERENCES users(id),
  validated_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (project_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS idx_po_project ON purchase_orders(project_id);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  project_line_id INTEGER REFERENCES project_lines(id),
  article_designation_snapshot TEXT NOT NULL,
  article_code_snapshot TEXT,
  description TEXT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'Unité',
  -- Prix d'achat Vos Voyage uniquement (§54, §67 : jamais le prix de vente)
  unit_price NUMERIC(12,3) NOT NULL CHECK (unit_price >= 0),
  taux_tva NUMERIC(12,3) NOT NULL CHECK (taux_tva >= 0 AND taux_tva <= 100),
  vat_label_snapshot TEXT,
  total_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  montant_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pol_po ON purchase_order_lines(purchase_order_id);

CREATE TABLE IF NOT EXISTS sales_invoices (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) UNIQUE,
  project_reference TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  customer_name_snapshot TEXT NOT NULL,
  customer_address_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'BROUILLON' CHECK (status IN ('BROUILLON','VALIDEE','ANNULEE')),
  total_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0,
  issue_date TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  validated_by INTEGER REFERENCES users(id),
  validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_si_project ON sales_invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_si_status ON sales_invoices(status);
CREATE INDEX IF NOT EXISTS idx_si_issue ON sales_invoices(issue_date);
CREATE INDEX IF NOT EXISTS idx_si_customer ON sales_invoices(customer_id);

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id SERIAL PRIMARY KEY,
  sales_invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  project_line_id INTEGER REFERENCES project_lines(id),
  article_designation_snapshot TEXT NOT NULL,
  article_code_snapshot TEXT,
  description TEXT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'Unité',
  -- Prix de VENTE de Perfecto Booking uniquement (§57, §67 : jamais le prix d'achat)
  unit_price NUMERIC(12,3) NOT NULL CHECK (unit_price >= 0),
  taux_tva NUMERIC(12,3) NOT NULL CHECK (taux_tva >= 0 AND taux_tva <= 100),
  -- Coût d'achat snapshoté : base de la marge facturée (rempli à la génération,
  -- ou par migration depuis la prestation d'origine pour les lignes antérieures)
  cout_achat_snapshot NUMERIC(12,3),
  vat_label_snapshot TEXT,
  total_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  montant_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sil_si ON sales_invoice_lines(sales_invoice_id);

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  project_reference TEXT NOT NULL,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) UNIQUE,
  purchase_order_reference TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name_snapshot TEXT NOT NULL,
  supplier_address_snapshot TEXT,
  supplier_invoice_ref TEXT,
  status TEXT NOT NULL DEFAULT 'BROUILLON' CHECK (status IN ('BROUILLON','VALIDEE','ANNULEE')),
  total_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0,
  issue_date TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  validated_by INTEGER REFERENCES users(id),
  validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_pi_project ON purchase_invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_pi_status ON purchase_invoices(status);
CREATE INDEX IF NOT EXISTS idx_pi_issue ON purchase_invoices(issue_date);

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id SERIAL PRIMARY KEY,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  purchase_order_line_id INTEGER REFERENCES purchase_order_lines(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  project_line_id INTEGER REFERENCES project_lines(id),
  article_designation_snapshot TEXT NOT NULL,
  article_code_snapshot TEXT,
  description TEXT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'Unité',
  unit_price NUMERIC(12,3) NOT NULL CHECK (unit_price >= 0),
  taux_tva NUMERIC(12,3) NOT NULL CHECK (taux_tva >= 0 AND taux_tva <= 100),
  vat_label_snapshot TEXT,
  total_ht NUMERIC(12,3) NOT NULL DEFAULT 0,
  montant_tva NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(12,3) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pil_pi ON purchase_invoice_lines(purchase_invoice_id);
