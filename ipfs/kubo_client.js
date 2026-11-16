/**
 * @file kubo_client.js
 * @description Local IPFS Kubo Daemon RPC Client (http://127.0.0.1:5001).
 */

/**
 * Retrieve configured IPFS Kubo RPC Endpoint
 * @returns {string}
 */
export function getKuboRpcEndpoint() {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      const sessionSaved = window.sessionStorage.getItem("GENO_KUBO_RPC");
      if (sessionSaved && sessionSaved.trim().length > 0) return sessionSaved.trim();
    }
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_KUBO_RPC) {
      return import.meta.env.VITE_KUBO_RPC.trim();
    }
  } catch (e) {}
  if (typeof process !== "undefined" && process.env) {
    if (process.env.IPFS_RPC) return process.env.IPFS_RPC.trim();
    if (process.env.KUBO_RPC) return process.env.KUBO_RPC.trim();
  }
  return "http://127.0.0.1:5001";
}

/**
 * Retrieve configured IPFS Kubo Gateway Endpoint
 * Reads from sessionStorage, import.meta.env, process.env with fallback to default port 8080
 * @returns {string}
 */
export function getKuboGatewayEndpoint() {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      const sessionSaved = window.sessionStorage.getItem("GENO_KUBO_GATEWAY");
      if (sessionSaved && sessionSaved.trim().length > 0) return sessionSaved.trim();
    }
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_KUBO_GATEWAY) {
      return import.meta.env.VITE_KUBO_GATEWAY.trim();
    }
  } catch (e) {}
  if (typeof process !== "undefined" && process.env) {
    if (process.env.IPFS_GATEWAY) return process.env.IPFS_GATEWAY.trim();
    if (process.env.KUBO_GATEWAY) return process.env.KUBO_GATEWAY.trim();
  }
  return "http://127.0.0.1:8080";
}

/**
 * Persist Kubo Gateway endpoint in storage
 * @param {string} endpoint 
 */
export function setKuboGatewayEndpoint(endpoint) {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      window.sessionStorage.setItem("GENO_KUBO_GATEWAY", endpoint || "");
    }
    if (window.localStorage) {
      window.localStorage.removeItem("GENO_KUBO_GATEWAY");
    }
  }
}

/**
 * Persist Kubo RPC endpoint in storage
 * @param {string} endpoint 
 */
export function setKuboRpcEndpoint(endpoint) {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      window.sessionStorage.setItem("GENO_KUBO_RPC", endpoint || "");
    }
    if (window.localStorage) {
      window.localStorage.removeItem("GENO_KUBO_RPC");
    }
  }
}

/**
 * Upload binary file bytes to Local IPFS Kubo Daemon (/api/v0/add)
 * @param {Uint8Array} fileBytes 
 * @param {string} fileName 
 * @param {string} mimeType 
 * @param {string|null} [customRpc] 
 * @returns {Promise<{ cid: string, pinnedOn: string }|null>}
 */
export async function pinFileToKubo(fileBytes, fileName, mimeType, customRpc = null) {
  if (typeof fetch === "undefined") return null;
  const rawRpc = customRpc || getKuboRpcEndpoint();
  const kuboRpc = String(rawRpc || "http://127.0.0.1:5001").replace(/\/+$/, "");
  try {
    const formData = new FormData();
    const blob = new Blob([fileBytes], { type: mimeType });
    formData.append("file", blob, fileName);

    const isBrowser = typeof window !== "undefined";
    const isLocalDefault = kuboRpc === "http://127.0.0.1:5001" || kuboRpc === "http://localhost:5001" || kuboRpc === "/ipfs-rpc";
    const kuboUrl = (isBrowser && isLocalDefault)
      ? "/ipfs-rpc/add"
      : `${kuboRpc}/api/v0/add`;

    const directUrl = kuboRpc === "/ipfs-rpc"
      ? "http://127.0.0.1:5001/api/v0/add"
      : `${kuboRpc}/api/v0/add`;
    let res = null;
    try {
      res = await fetch(kuboUrl, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(3000),
      });
    } catch (_) {
      res = null;
    }
    if ((!res || res.status === 404 || res.status === 405) && kuboUrl !== directUrl) {
      res = await fetch(directUrl, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(3000),
      });
    }

    if (res && res.ok) {
      const json = await res.json();
      return { cid: json.Hash, pinnedOn: "local-kubo" };
    }
  } catch (err) {}
  return null;
}

/**
 * Upload JSON to Local IPFS Kubo Daemon
 * @param {Object|string} jsonData 
 * @param {string} [fileName] 
 * @param {string|null} [customRpc] 
 * @returns {Promise<{ cid: string, pinnedOn: string }|null>}
 */
export async function pinJsonToKubo(jsonData, fileName = "metadata.json", customRpc = null) {
  if (typeof fetch === "undefined") return null;
  const rawRpc = customRpc || getKuboRpcEndpoint();
  const kuboRpc = String(rawRpc || "http://127.0.0.1:5001").replace(/\/+$/, "");
  try {
    const jsonString = typeof jsonData === "string" ? jsonData : JSON.stringify(jsonData, null, 2);
    const jsonBytes = new TextEncoder().encode(jsonString);
    const formData = new FormData();
    const blob = new Blob([jsonBytes], { type: "application/json" });
    formData.append("file", blob, fileName);

    const isBrowser = typeof window !== "undefined";
    const isLocalDefault = kuboRpc === "http://127.0.0.1:5001" || kuboRpc === "http://localhost:5001" || kuboRpc === "/ipfs-rpc";
    const kuboUrl = (isBrowser && isLocalDefault)
      ? "/ipfs-rpc/add"
      : `${kuboRpc}/api/v0/add`;

    const directUrl = kuboRpc === "/ipfs-rpc"
      ? "http://127.0.0.1:5001/api/v0/add"
      : `${kuboRpc}/api/v0/add`;
    let res = null;
    try {
      res = await fetch(kuboUrl, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(3000),
      });
    } catch (_) {
      res = null;
    }
    if ((!res || res.status === 404 || res.status === 405) && kuboUrl !== directUrl) {
      res = await fetch(directUrl, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(3000),
      });
    }

    if (res && res.ok) {
      const json = await res.json();
      return { cid: json.Hash, pinnedOn: "local-kubo" };
    }
  } catch (err) {}
  return null;
}

/**
 * Fetch raw bytes from local Kubo IPFS gateway
 * Dynamically resolves gateway URL from environment/session configuration
 * @param {string} cid 
 * @param {string|null} [customGateway] 
 * @returns {Promise<Uint8Array|null>}
 */
export async function fetchFromKuboGateway(cid, customGateway = null) {
  if (typeof fetch === "undefined") return null;
  const gateway = (customGateway && customGateway.trim().length > 0)
    ? customGateway.trim()
    : getKuboGatewayEndpoint();
  try {
    const res = await fetch(`${gateway}/ipfs/${cid}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch (e) {}
  return null;
}
