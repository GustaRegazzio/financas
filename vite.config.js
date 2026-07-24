import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ATENÇÃO: "base" deve ser "/NOME_DO_SEU_REPO/" — ajuste se o repo não se chamar "financas"
export default defineConfig({
  plugins: [react()],
  base: "/financas/"
});
