import bcrypt from "bcryptjs";
import { getDb } from "./database.js";

function seed() {
  const db = getDb();
  const hasUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (hasUsers > 0) { console.log("Base déjà initialisée."); return; }

  const tx = db.transaction(() => {
    db.prepare("INSERT INTO roles (code,label) VALUES ('DIRECTOR','Directeur'),('COMMERCIAL','Commercial'),('AGENT','Agent'),('ACCOUNTING','Comptabilité'),('MANAGER','Manager'),('READONLY','Lecture seule'),('ADMIN','Administrateur')").run();
    const roleId = db.prepare("SELECT id FROM roles WHERE code='DIRECTOR'").get().id;
    const hash = bcrypt.hashSync("Directeur123!", 10);
    db.prepare("INSERT INTO users (email,password_hash,full_name,role_id) VALUES (?,?,?,?)")
      .run("directeur@agence.tn", hash, "Directeur Agence", roleId);

    const cust = db.prepare("INSERT INTO customers (code,name,contact,phone,email,address,is_active) VALUES (?,?,?,?,?,?,1)");
    cust.run("CLI-001", "Société ABC", "Mme Ben Ali", "+216 71 000 001", "contact@abc.tn", "Tunis");
    cust.run("CLI-002", "Société XYZ", "M. Trabelsi", "+216 71 000 002", "contact@xyz.tn", "Sfax");
    cust.run("CLI-003", "Groupe Delta", "Mme Mansour", "+216 71 000 003", "contact@delta.tn", "Sousse");

    const sup = db.prepare("INSERT INTO suppliers (code,name,contact,phone,email,address,is_active) VALUES (?,?,?,?,?,?,1)");
    sup.run("FRN-001", "Hôtel XYZ", "Réception", "+216 73 100 100", "resa@hotelxyz.tn", "Hammamet");
    sup.run("FRN-002", "Transport ABC", "M. Chauffeur", "+216 98 200 200", "contact@transportabc.tn", "Tunis");
    sup.run("FRN-003", "Traiteur DEF", "Mme Cuisine", "+216 71 300 300", "contact@traiteurdef.tn", "Tunis");
    sup.run("FRN-004", "Centre de conférence GHI", "Accueil", "+216 71 400 400", "contact@conf-ghi.tn", "Tunis");

    db.prepare("INSERT INTO article_categories (code,label) VALUES ('HEB','Hébergement'),('TRS','Transport'),('RES','Restauration'),('SAL','Salles'),('MAT','Matériel'),('DIV','Divers')").run();
    const cat = (c) => db.prepare("SELECT id FROM article_categories WHERE code=?").get(c).id;
    const art = db.prepare("INSERT INTO articles (code,designation,category_id,unit,description,is_active) VALUES (?,?,?,?,?,1)");
    art.run("ART-HEB-01", "Hébergement", cat("HEB"), "Nuit", "Nuitée hôtel");
    art.run("ART-TRS-01", "Transport", cat("TRS"), "Bus", "Bus + chauffeur");
    art.run("ART-CAF-01", "Pause café", cat("RES"), "Personne", "Pause café");
    art.run("ART-DEJ-01", "Déjeuner", cat("RES"), "Personne", "Déjeuner assis");
    art.run("ART-DIN-01", "Dîner", cat("RES"), "Personne", "Dîner");
    art.run("ART-SAL-01", "Salle de réunion", cat("SAL"), "Jour", "Salle équipée");
    art.run("ART-MAT-01", "Location matériel", cat("MAT"), "Forfait", "Sonorisation / projection");

    const vat = db.prepare("INSERT INTO vat_rates (code,label,rate,is_active) VALUES (?,?,?,1)");
    vat.run("TVA-0", "TVA 0 %", 0);
    vat.run("TVA-7", "TVA 7 %", 7);
    vat.run("TVA-13", "TVA 13 %", 13);
    vat.run("TVA-19", "TVA 19 %", 19);
    // Types de transactions : déjà seedés par database.js (INSERT OR IGNORE).
  });
  tx();
  console.log("Base initialisée. Compte : directeur@agence.tn / Directeur123!");
}
seed();
