import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

function resolveDbPath() {
  // ERP_DB_PATH permet aux tests d'utiliser une base isolée (jamais la base réelle).
  if (process.env.ERP_DB_PATH) return process.env.ERP_DB_PATH;
  const dataDir = join(ROOT, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "erp.db");
}

// Cache par chemin : la base réelle et les bases de test ne se mélangent jamais.
const _pool = new Map();
export function getDb() {
  const dbPath = resolveDbPath();
  if (!_pool.has(dbPath)) {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    for (const f of ["schema.sql", "schema_documents.sql", "schema_finance.sql"]) {
      db.exec(readFileSync(join(__dirname, f), "utf8"));
    }
    // Migrations colonnes projet (confirmation, numéro de devis)
    const cols = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
    const addCol = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`); };
    addCol("quote_reference", "quote_reference TEXT");
    addCol("confirmed_by", "confirmed_by INTEGER REFERENCES users(id)");
    addCol("confirmed_at", "confirmed_at TEXT");
    addCol("confirmation_note", "confirmation_note TEXT");
    // Marge facturée depuis les lignes de factures de vente : coût d'achat snapshoté
    // par ligne. STRICTEMENT ADDITIF : aucune donnée existante n'est modifiée ni effacée ;
    // les lignes déjà facturées récupèrent leur coût depuis la prestation d'origine.
    const silCols = db.prepare("PRAGMA table_info(sales_invoice_lines)").all().map((c) => c.name);
    if (!silCols.includes("cout_achat_snapshot")) {
      db.exec("ALTER TABLE sales_invoice_lines ADD COLUMN cout_achat_snapshot REAL");
      db.exec(`UPDATE sales_invoice_lines SET cout_achat_snapshot =
        (SELECT prix_achat_notre_agence FROM project_lines WHERE project_lines.id = sales_invoice_lines.project_line_id)
        WHERE project_line_id IS NOT NULL`);
    }
    // Index complémentaires pour le pilotage (agrégations par dates/statuts, §14)
    for (const idx of [
      "CREATE INDEX IF NOT EXISTS idx_projects_validated ON projects(validated_at)",
      "CREATE INDEX IF NOT EXISTS idx_projects_start ON projects(start_date)",
      "CREATE INDEX IF NOT EXISTS idx_si_issue ON sales_invoices(issue_date)",
      "CREATE INDEX IF NOT EXISTS idx_si_customer ON sales_invoices(customer_id)",
      "CREATE INDEX IF NOT EXISTS idx_pi_issue ON purchase_invoices(issue_date)",
      "CREATE INDEX IF NOT EXISTS idx_lines_article ON project_lines(article_id)",
    ]) db.exec(idx);
    const seedType = db.prepare("INSERT OR IGNORE INTO transaction_types (code,label,is_active) VALUES (?,?,1)");
    seedType.run("ESPECES", "Espèces");
    seedType.run("VIREMENT", "Virement");
    seedType.run("CHEQUE", "Chèque");
    seedType.run("CARTE", "Carte");
    seedType.run("AUTRE", "Autre");
    _pool.set(dbPath, db);
  }
  return _pool.get(dbPath);
}
