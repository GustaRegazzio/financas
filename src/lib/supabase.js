import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // Falha alta e clara: sem secrets configurados o app não deve fingir que funciona
  console.error("Supabase: configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY nos secrets do repositório.");
}

export const supabase = createClient(url, anon);
