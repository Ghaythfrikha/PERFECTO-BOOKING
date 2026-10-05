import bcrypt from "bcryptjs";
import { initDb, getDb } from "./database.js";

async function seed() {
  await initDb();
  const db = getDb();
  const hasUsers = (await db.get("SELECT COUNT(*) c FROM users")).c;
  if (hasUsers > 0) { console.log("Base déjà initialisée."); return; }

  await db.transaction(async (tx) => {
    await tx.run("INSERT INTO roles (code,label) VALUES ('DIRECTOR','Directeur'),('COMMERCIAL','Commercial'),('AGENT','Agent'),('ACCOUNTING','Comptabilité'),('MANAGER','Manager'),('READONLY','Lecture seule'),('ADMIN','Administrateur')");
    const roleId = (await tx.get("SELECT id FROM roles WHERE code='DIRECTOR'")).id;
    const hash = bcrypt.hashSync("Directeur123!", 10);
    await tx.run("INSERT INTO users (email,password_hash,full_name,role_id) VALUES ($1,$2,$3,$4)",
      "directeur@agence.tn", hash, "Directeur Agence", roleId);

    for (const [code, name, contact, phone, email, address] of [
      ["CLI-001", "Société ABC", "Mme Ben Ali", "+216 71 000 001", "contact@abc.tn", "Tunis"],
      ["CLI-002", "Société XYZ", "M. Trabelsi", "+216 71 000 002", "contact@xyz.tn", "Sfax"],
      ["CLI-003", "Groupe Delta", "Mme Mansour", "+216 71 000 003", "contact@delta.tn", "Sousse"],
    ]) {
      await tx.run("INSERT INTO customers (code,name,contact,phone,email,address,is_active) VALUES ($1,$2,$3,$4,$5,$6,1)",
        code, name, contact, phone, email, address);
    }
    for (const [code, name, contact, phone, email, address] of [
      ["FRN-001", "Hôtel XYZ", "Réception", "+216 73 100 100", "resa@hotelxyz.tn", "Hammamet"],
      ["FRN-002", "Transport ABC", "M. Chauffeur", "+216 98 200 200", "contact@transportabc.tn", "Tunis"],
      ["FRN-003", "Traiteur DEF", "Mme Cuisine", "+216 71 300 300", "contact@traiteurdef.tn", "Tunis"],
      ["FRN-004", "Centre de conférence GHI", "Accueil", "+216 71 400 400", "contact@conf-ghi.tn", "Tunis"],
    ]) {
      await tx.run("INSERT INTO suppliers (code,name,contact,phone,email,address,is_active) VALUES ($1,$2,$3,$4,$5,$6,1)",
        code, name, contact, phone, email, address);
    }

    await tx.run("INSERT INTO article_categories (code,label) VALUES ('HEB','Hébergement'),('TRS','Transport'),('RES','Restauration'),('SAL','Salles'),('MAT','Matériel'),('DIV','Divers')");
    const cat = async (c) => (await tx.get("SELECT id FROM article_categories WHERE code=$1", c)).id;
    for (const [code, designation, category, unit, description] of [
      ["ART-HEB-01", "Hébergement", "HEB", "Nuit", "Nuitée hôtel"],
      ["ART-TRS-01", "Transport", "TRS", "Bus", "Bus + chauffeur"],
      ["ART-CAF-01", "Pause café", "RES", "Personne", "Pause café"],
      ["ART-DEJ-01", "Déjeuner", "RES", "Personne", "Déjeuner assis"],
      ["ART-DIN-01", "Dîner", "RES", "Personne", "Dîner"],
      ["ART-SAL-01", "Salle de réunion", "SAL", "Jour", "Salle équipée"],
      ["ART-MAT-01", "Location matériel", "MAT", "Forfait", "Sonorisation / projection"],
    ]) {
      await tx.run("INSERT INTO articles (code,designation,category_id,unit,description,is_active) VALUES ($1,$2,$3,$4,$5,1)",
        code, designation, await cat(category), unit, description);
    }

    for (const [code, label, rate] of [["TVA-0", "TVA 0 %", 0], ["TVA-7", "TVA 7 %", 7], ["TVA-13", "TVA 13 %", 13], ["TVA-19", "TVA 19 %", 19]]) {
      await tx.run("INSERT INTO vat_rates (code,label,rate,is_active) VALUES ($1,$2,$3,1)", code, label, rate);
    }
    // Types de transactions : déjà seedés par database.js (ON CONFLICT DO NOTHING).
  });
  console.log("Base initialisée. Compte : directeur@agence.tn / Directeur123!");
}
await seed();
