// ============================================================================
//  JEITO MIAMI · configuración de conexión.
//  Se edita UNA sola vez con los datos del proyecto de Supabase
//  (Project Settings → API). Después no se toca más: las actualizaciones del
//  sistema son solo del archivo app.js.
// ============================================================================
window.JEITO_CONFIG = {
  // Dirección del proyecto. Ejemplo: "https://abcdefghijklmnop.supabase.co"
  SUPABASE_URL: "https://rseymbjronfjvhcgnjwf.supabase.co",

  // Clave pública "anon" (es larga, empieza con "eyJ..."). Es seguro que esté
  // acá: con ella nadie ve nada si no tiene usuario y contraseña.
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJzZXltYmpyb25manZoY2duandmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2NzkxOTcsImV4cCI6MjEwNjI1NTE5N30.lg7UOnmlMsp-rHtrX0hoHjq7VFnlmA3FGHyvoIOj8EI",

  // Dominio ficticio con el que se arman los mails de login (usuario@dominio).
  // Supabase Auth necesita un mail por usuario aunque no se use para nada.
  AUTH_EMAIL_DOMAIN: "jeitomiami.app"
};
