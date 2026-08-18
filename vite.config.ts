import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const ELYSIA = `http://localhost:${process.env.PORT ?? 4321}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  server: {
    proxy: {
      // Same-origin in dev, so `src/lib/eden.ts` needs no base URL and the
      // coach endpoint needs no CORS.
      "/api": { target: ELYSIA, changeOrigin: true },
      // `ws: true` is what makes Vite forward the Upgrade request. Note the
      // http:// target — Vite does the protocol switch itself and a ws://
      // target fails silently.
      "/ws": { target: ELYSIA, ws: true, changeOrigin: true, rewriteWsOrigin: true },
    },
  },
});
