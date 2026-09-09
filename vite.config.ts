import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localPawPlugin } from "./tools/paw.ts";

export default defineConfig({
  plugins: [react(), localPawPlugin()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
