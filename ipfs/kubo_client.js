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
    if (window.localStorage) {
      const saved = window.localStorage.getItem("GENO_KUBO_RPC");
      if (saved && saved.trim().length > 0) return saved.trim();
    }
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_KUBO_RPC) {
      return import.meta.env.VITE_KUBO_RPC.trim();
    }
  } catch (e) {}
  return "http://127.0.0.1:5001";
}

/**
 * Persist Kubo RPC endpoint in storage
 * @param {string} endpoint 
 */
export function setKuboRpcEndpoint(endpoint) {
  if (typeof window !== "undefined") {
    if (window.localStorage) {
      window.localStorage.setItem("GENO_KUBO_RPC", endpoint || "");
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
  const kuboRpc = customRpc || getKuboRpcEndpoint();
  try {
    const formData = new FormData();
    const blob = new Blob([fileBytes], { type: mimeType });
    formData.append("file", blob, fileName);

    const isBrowser = typeof window !== "undefined";
    const kuboUrl = (isBrowser && (kuboRpc === "http://127.0.0.1:5001" || kuboRpc === "/ipfs-rpc"))
      ? "/ipfs-rpc/add"
      : `${kuboRpc}/api/v0/add`;

    let res = null;
    try {
      res = await fetch(kuboUrl, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(3000),
      });
    } catch (_) {
      if (kuboUrl !== `${kuboRpc}/api/v0/add`) {
        res = await fetch(`${kuboRpc}/api/v0/add`, {
          method: "POST",
          body: formData,
          signal: AbortSignal.timeout(3000),
        });
      }
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
  const kuboRpc = customRpc || getKuboRpcEndpoint();
  try {
    const jsonString = typeof jsonData === "string" ? jsonData : JSON.stringify(jsonData, null, 2);
    const jsonBytes = new TextEncoder().encode(jsonString);
    const formData = new FormData();
    const blob = new Blob([jsonBytes], { type: "application/json" });
    formData.append("file", blob, fileName);

    const res = await fetch(`${kuboRpc}/api/v0/add`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(3000),
    });

    if (res && res.ok) {
      const json = await res.json();
      return { cid: json.Hash, pinnedOn: "local-kubo" };
    }
  } catch (err) {}
  return null;
}

/**
 * Fetch raw bytes from local Kubo IPFS gateway
 * @param {string} cid 
 * @param {string} [customGateway] 
 * @returns {Promise<Uint8Array|null>}
 */
export async function fetchFromKuboGateway(cid, customGateway = "http://127.0.0.1:8080") {
  if (typeof fetch === "undefined") return null;
  try {
    const res = await fetch(`${customGateway}/ipfs/${cid}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch (e) {}
  return null;
}
