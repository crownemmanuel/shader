import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "shader-development-ipc",
      configureServer(server) {
        server.middlewares.use("/api/rpc", async (req, res) => {
          res.setHeader("Content-Type", "application/json");
          if (
            req.method !== "POST" ||
            (req.headers.origin &&
              req.headers.origin !== "http://127.0.0.1:1420") ||
            req.headers.host !== "127.0.0.1:1420"
          ) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Forbidden development origin" }));
            return;
          }
          try {
            let body = "";
            for await (const b of req) {
              body += b;
              if (body.length > 1024 * 1024)
                throw new Error("Request too large");
            }
            const session = JSON.parse(
              await readFile(
                path.join(
                  process.env.SHADER_DATA_DIR ||
                    path.join(os.homedir(), ".shader"),
                  "session.json",
                ),
                "utf8",
              ),
            );
            if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(session.url))
              throw new Error("Invalid engine session");
            const request = JSON.parse(body);
            const response = await fetch(session.url + "/rpc", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.token}`,
              },
              body: JSON.stringify({ ...request, actor: "ui" }),
            });
            res.statusCode = response.status;
            res.end(await response.text());
          } catch {
            res.statusCode = 503;
            res.end(
              JSON.stringify({
                error:
                  "Camera engine unavailable. Run npm run engine, or launch the desktop app.",
              }),
            );
          }
        });
      },
    },
  ],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
});
