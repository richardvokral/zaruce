import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel/serverless";

export default defineConfig({
  site: "https://everyone.example",
  output: "server",
  adapter: vercel({
    edgeMiddleware: false,
    webAnalytics: { enabled: false },
  }),
  build: {
    inlineStylesheets: "auto",
  },
  vite: {
    build: {
      target: "es2022",
    },
  },
});
