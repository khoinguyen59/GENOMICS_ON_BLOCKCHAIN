import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ipfsProxyConfig = {
  "/ipfs-rpc": {
    target: "http://127.0.0.1:5001",
    rewrite: (path) => path.replace(/^\/ipfs-rpc/, "/api/v0"),
    changeOrigin: true,
  },
  "/ipfs-gw": {
    target: "http://127.0.0.1:8080",
    rewrite: (path) => path.replace(/^\/ipfs-gw/, ""),
    changeOrigin: true,
  },
};

function stripLoopbackCspForNonLocalChains(chainIdRaw) {
  const trimmed = String(chainIdRaw || "").trim();
  const isNonLocal = trimmed !== "" && trimmed !== "31337";
  return {
    name: "genochain-prod-csp-hardening",
    transformIndexHtml(html) {
      if (!isNonLocal) return html;
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)(")/i,
        (_m, prefix, policy, suffix) => {
          const cleaned = policy
            .replace(/\s+(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost):(?:\*|\d+)/gi, "")
            .replace(/\s{2,}/g, " ")
            .replace(/;\s+/g, "; ")
            .trim();
          return `${prefix}${cleaned}${suffix}`;
        }
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const effectiveChainId = process.env.VITE_CHAIN_ID ?? env.VITE_CHAIN_ID ?? "";
  const trimmedChainId = String(effectiveChainId || "").trim();
  const isNonLocal = trimmedChainId !== "" && trimmedChainId !== "31337";
  return {
    define: {
      __GENOCHAIN_NON_LOCAL_CHAIN__: JSON.stringify(isNonLocal),
    },
    plugins: [react(), stripLoopbackCspForNonLocalChains(effectiveChainId)],
    resolve: {
      alias: {
        ethers: path.resolve(__dirname, "node_modules/ethers"),
      },
    },
    server: {
      port: 3000,
      open: false,
      proxy: ipfsProxyConfig,
    },
    preview: {
      proxy: ipfsProxyConfig,
    },
    build: {
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normId = id.replace(/\\/g, "/");
            if (normId.includes("/node_modules/snarkjs/") || normId.includes("/node_modules/ffjavascript/")) {
              return "vendor-snarkjs";
            }
            if (normId.includes("/node_modules/ethers/")) {
              return "vendor-ethers";
            }
            if (normId.includes("/node_modules/react/") || normId.includes("/node_modules/react-dom/")) {
              return "vendor-react";
            }
            if (normId.includes("/node_modules/")) {
              return "vendor-utils";
            }
            if (normId.includes("/frontend/src/contracts/")) {
              return "contracts-meta";
            }
            if (normId.includes("/crypto/") || normId.includes("/ipfs/")) {
              return "genomics-core";
            }
          },
        },
      },
    },
  };
});