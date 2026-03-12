import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Ouverture en mode lecture seule pour la sécurité
const db = new Database('./database.db', { readonly: true });
sqliteVec.load(db);

console.log("=== DIAGNOSTIC DE LA BASE DE DONNÉES ===\n");

try {
  // 1. Comptage brutal
  const { totalMails } = db.prepare("SELECT COUNT(*) as totalMails FROM emails").get();
  const { totalProfiles } = db.prepare("SELECT COUNT(*) as totalProfiles FROM sender_profiles").get();
  const { totalVectors } = db.prepare("SELECT COUNT(*) as totalVectors FROM vec_emails").get();

  console.log(`📧 Table 'emails'          : ${totalMails} lignes`);
  console.log(`🤝 Table 'sender_profiles' : ${totalProfiles} profils uniques`);
  console.log(`🧠 Table 'vec_emails'      : ${totalVectors} vecteurs\n`);

  // 2. Vérification de l'intégrité relationnelle
  if (totalMails === totalVectors) {
    console.log("✅ Intégrité validée : 100% des mails ont leur vecteur.");
  } else {
    console.log(`⚠️ ALERTE : Différence détectée. ${totalMails - totalVectors} mails n'ont pas été vectorisés.`);
  }

  // 3. Vérification mathématique du vecteur (S'assurer que c'est bien un espace à 768 dimensions)
  const sample = db.prepare("SELECT rowid, vec_length(embedding) as dimensions FROM vec_emails LIMIT 1").get();
  
  if (sample) {
    console.log(`\n📐 Test du vecteur ID ${sample.rowid} : ${sample.dimensions} dimensions (Attendu: 768)`);
    if (sample.dimensions !== 768) {
      console.log("❌ ERREUR : Les vecteurs n'ont pas la bonne taille. Le modèle nomic-embed-text a planté.");
    } else {
      console.log("✅ Format vectoriel valide.");
    }
  } else {
    console.log("❌ ERREUR : La table vectorielle est vide.");
  }

  // 4. Test du Graphe (Qui est ton plus gros expéditeur ?)
  const topSender = db.prepare(`
    SELECT sender_email, interaction_count 
    FROM sender_profiles 
    ORDER BY interaction_count DESC 
    LIMIT 1
  `).get();
  
  console.log(`\n🏆 Plus gros expéditeur   : ${topSender.sender_email} (${topSender.interaction_count} mails)`);

} catch (err) {
  console.error("❌ Erreur SQL :", err.message);
} finally {
  db.close();
}