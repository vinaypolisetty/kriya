import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `pnpm dev` serves the app with hot reload; the API comes from `kriya web` running in the project.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:4317" } },
});
