// Accès PostgreSQL (Supabase) — même interface synchrone getDb(), méthodes async.
// NUMERIC parsé en nombre JS ; SSL activé pour Supabase ; migrations idempotentes.
// Schémas de test : TEST_SCHEMA isole chaque fichier de test (search_path) sans
// jamais toucher aux autres données.
import pg from "pg";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const { Pool, types } = pg;
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveConnStr() {
  if (process.env.TEST_SCHEMA) {
    if (!process.env.TEST_DATABASE_URL || process.env.TEST_DATABASE_URL.includes("[MOT-DE-PASSE")) {
      throw new Error("TEST_DATABASE_URL manquant : les tests exigent une base PostgreSQL dédiée (2ᵉ projet Supabase gratuit, jamais la base réelle). Renseignez-la dans .env.");
    }
    return process.env.TEST_DATABASE_URL;
  }
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("[MOT-DE-PASSE")) {
    throw new Error("DATABASE_URL manquant : renseignez-le dans .env (Dashboard Supabase → Project Settings → Database → Connection string URI).");
  }
  return process.env.DATABASE_URL;
}

function sslFor(connStr) {
  // SSL partout sauf en local explicite : Supabase, Neon et tout hébergeur distant l'exigent.
  if (/sslmode=disable/.test(connStr)) return undefined;
  try {
    const host = new URL(connStr.replace(/^postgresql:\/\//, "http://")).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return undefined;
  } catch { /* URL inanalysable : SSL par sécurité */ }
  return { rejectUnauthorized: false };
}

function hostForLogs(connStr) {
  try {
    return new URL(connStr.replace(/^postgresql:\/\//, "http://")).host;
  } catch {
    return "?";
  }
}

class Db {
  constructor(runner) { this.runner = runner; }
  async query(sql, params = []) { return this.runner.query(sql, params); }
  async get(sql, ...params) {
    const r = await this.runner.query(sql, params);
    return r.rows[0];
  }
  async all(sql, ...params) {
    const r = await this.runner.query(sql, params);
    return r.rows;
  }
  async run(sql, ...params) {
    const r = await this.runner.query(sql, params);
    return { lastInsertRowid: r.rows[0]?.id ?? null, changes: r.rowCount ?? 0 };
  }
  async exec(sql) { await this.runner.query(sql); }
  async transaction(fn) {
    if (this.runner !== pool) throw new Error("Transactions imbriquées interdites");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new Db(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* déjà en échec */ }
      throw e;
    } finally {
      client.release();
    }
  }
}

let pool = null;
let poolKey = null;
const migrated = new Set();

async function hasColumn(db, table, column) {
  const r = await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
    [table, column]
  );
  return r.rowCount > 0;
}

/** Initialise le pool + applique schémas et migrations (à appeler une fois au démarrage). */
export async function initDb() {
  const connStr = resolveConnStr();
  const schema = process.env.TEST_SCHEMA || null;
  if (schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("TEST_SCHEMA invalide");
  const key = connStr + "|" + (schema || "public");
  if (!pool || poolKey !== key) {
    if (pool) await pool.end().catch(() => {});
    pool = new Pool({
      connectionString: connStr,
      // Render/local : 10. Vercel serverless : PGPOOL_MAX=2 (instances éphémères).
      max: Number(process.env.PGPOOL_MAX || 10),
      ...(sslFor(connStr) ? { ssl: sslFor(connStr) } : {}),
      ...(schema ? { options: `-c search_path="${schema}"` } : {}),
    });
    poolKey = key;
  }
  if (migrated.has(key)) return;
  console.log(`Base PostgreSQL : ${hostForLogs(connStr)}${schema ? ` (schéma ${schema})` : ""}`);
  if (schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  for (const f of ["schema.sql", "schema_documents.sql", "schema_finance.sql"]) {
    await pool.query(readFileSync(join(__dirname, f), "utf8"));
  }
  // Migrations de colonnes (bases créées avant leur ajout) — strictement additives.
  for (const [table, column, ddl] of [
    ["projects", "quote_reference", "TEXT"],
    ["projects", "confirmed_by", "INTEGER REFERENCES users(id)"],
    ["projects", "confirmed_at", "TEXT"],
    ["projects", "confirmation_note", "TEXT"],
    ["sales_invoice_lines", "cout_achat_snapshot", "NUMERIC(12,3)"],
  ]) {
    if (!(await hasColumn(pool, table, column))) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
  // Remplissage du coût snapshoté pour les lignes facturées antérieures (nouvelle colonne NULL uniquement).
  await pool.query(`UPDATE sales_invoice_lines SET cout_achat_snapshot =
    (SELECT prix_achat_notre_agence FROM project_lines WHERE project_lines.id = sales_invoice_lines.project_line_id)
    WHERE cout_achat_snapshot IS NULL AND project_line_id IS NOT NULL`);
  // Types de transactions de base (idempotent : n'écrase jamais les types personnalisés).
  const seedType = "INSERT INTO transaction_types (code,label,is_active) VALUES ($1,$2,1) ON CONFLICT (code) DO NOTHING";
  for (const [code, label] of [["ESPECES", "Espèces"], ["VIREMENT", "Virement"], ["CHEQUE", "Chèque"], ["CARTE", "Carte"], ["AUTRE", "Autre"]]) {
    await pool.query(seedType, [code, label]);
  }
  migrated.add(key);
}

export function getDb() {
  if (!pool) throw new Error("Base non initialisée : appelez await initDb() au démarrage.");
  return new Db(pool);
}

export async function closeDb() {
  migrated.clear();
  if (pool) { await pool.end().catch(() => {}); pool = null; poolKey = null; }
}
