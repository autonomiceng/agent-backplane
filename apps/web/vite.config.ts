// Builds assets for the combined server and proxies API/SSE during local development.
import { defineConfig } from "vite";

export default defineConfig({
  base: "/dashboard/",
  build: { outDir: "dist" },
  server: { host: "127.0.0.1", port: 5173, strictPort: true,
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } } },
});
