import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");

if (fs.existsSync(distDir)) {
  try {
    fs.rmSync(distDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (err) {
    // Graceful fallback for Windows asynchronous directory unlinking
    console.warn("[Clean Warning] Windows file lock encountered, continuing build:", err.message);
  }
}
