// Entrée serverless Vercel : réutilise l'application Express telle quelle.
// Aucune logique métier ici — tout reste dans src/ (domaine, application, PDF).
import app from "../src/presentation/api/server.js";

export default app;
