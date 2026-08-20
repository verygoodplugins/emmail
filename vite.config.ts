import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workerOrigin = "http://127.0.0.1:8787";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: workerOrigin,
        changeOrigin: true
      },
      "/login": {
        target: workerOrigin,
        changeOrigin: true
      }
    }
  }
});
