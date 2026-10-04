import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8000", ws: true }, "/health": { target: "http://127.0.0.1:8000" } },
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    // LiveKit is loaded only with the call surface and currently minifies to
    // about 515 KB. Every other JavaScript chunk remains below 500 KB.
    chunkSizeWarningLimit: 520,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 60,
            },
            {
              name: "charts-vendor",
              test: /node_modules[\\/](?:recharts|d3-|victory-vendor)[\\/]/,
              priority: 50,
            },
            {
              name: "pdf-vendor",
              test: /node_modules[\\/](?:jspdf|pdfjs-dist|html2canvas|fflate|@babel)[\\/]/,
              priority: 50,
            },
            {
              name: "realtime-vendor",
              test: /node_modules[\\/](?:livekit-client|@livekit|sdp-transform|webrtc-adapter)[\\/]/,
              priority: 50,
              maxSize: 450_000,
            },
            {
              name: "markdown-vendor",
              test: /node_modules[\\/](?:react-markdown|remark-|rehype-|unified|micromark|mdast|hast)[\\/]/,
              priority: 50,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
