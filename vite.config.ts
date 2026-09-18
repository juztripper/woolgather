import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  root: "apps/web",
  plugins: [
    tailwindcss(),
    react(),
    cloudflare({ configPath: "../../wrangler.jsonc" }),
  ],
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
