import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API requests to the Express server
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
