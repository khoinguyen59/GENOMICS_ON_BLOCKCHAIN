/**
 * @file pinata_client.js
 * @description Pinata Cloud REST API client for decentralized pinning.
 */

/**
 * Retrieve configured Pinata JWT from sessionStorage or environment variables
 * @returns {string|null}
 */
export function getPinataJwt() {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      const sessionSaved = window.sessionStorage.getItem("GENO_PINATA_JWT");
      if (sessionSaved && sessionSaved.trim().length > 0) return sessionSaved.trim();
    }
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_PINATA_JWT) {
      return import.meta.env.VITE_PINATA_JWT.trim();
    }
  } catch (e) {}
  if (typeof process !== "undefined" && process.env?.PINATA_JWT) {
    return process.env.PINATA_JWT.trim();
  }
  return null;
}

/**
 * Persist Pinata JWT in storage
 * @param {string} token 
 */
export function setPinataJwt(token) {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      if (token) window.sessionStorage.setItem("GENO_PINATA_JWT", token);
      else window.sessionStorage.removeItem("GENO_PINATA_JWT");
    }
    if (window.localStorage) {
      window.localStorage.removeItem("GENO_PINATA_JWT");
    }
  }
}

/**
 * Upload binary file bytes to Pinata Cloud
 * @param {Uint8Array} fileBytes 
 * @param {string} fileName 
 * @param {string} mimeType 
 * @param {string|null} [customJwt] 
 * @returns {Promise<{ cid: string, pinnedOn: string }|null>}
 */
export async function pinFileToPinata(fileBytes, fileName, mimeType, customJwt = null) {
  const rawJwt = customJwt || getPinataJwt();
  const jwt = typeof rawJwt === "string" ? rawJwt.trim().replace(/^Bearer\s+/i, "").trim() : "";
  if (!jwt || typeof fetch === "undefined") {
    return null;
  }
  try {
    const formData = new FormData();
    const blob = new Blob([fileBytes], { type: mimeType });
    formData.append("file", blob, fileName);

    const payloadSize = fileBytes?.byteLength ?? fileBytes?.length ?? 0;
    const isJsonPayload = mimeType === "application/json";
    const uploadTimeoutMs = isJsonPayload
      ? 15_000
      : Math.max(30_000, Math.min(300_000, 15_000 + Math.ceil((payloadSize || 0) / 65536) * 500));

    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      body: formData,
      signal: AbortSignal.timeout(uploadTimeoutMs),
    });

    if (res.ok) {
      const json = await res.json();
      if (json && typeof json.IpfsHash === "string" && json.IpfsHash.length > 0) {
        return { cid: json.IpfsHash, pinnedOn: "pinata-cloud" };
      }
    }
    console.warn(`Pinata API file upload failed (HTTP ${res.status}): falling back to local Kubo.`);
  } catch (err) {
    console.warn("Pinata API file upload warning:", err.message);
  }
  return null;
}

/**
 * Upload JSON document to Pinata Cloud using deterministic UTF-8 serialization
 * so the pinned IPFS bytes and CIDv0 match client-side SHA-256 metadataHash 100%.
 * @param {Object|string} jsonData 
 * @param {string} [name] 
 * @param {string|null} [customJwt] 
 * @returns {Promise<{ cid: string, pinnedOn: string }|null>}
 */
export async function pinJsonToPinata(jsonData, name = "metadata.json", customJwt = null) {
  const jwt = customJwt || getPinataJwt();
  if (!jwt || typeof fetch === "undefined") {
    return null;
  }
  const canonicalJson = typeof jsonData === "string" ? jsonData : JSON.stringify(jsonData, null, 2);
  const jsonBytes = new TextEncoder().encode(canonicalJson);
  return await pinFileToPinata(jsonBytes, name, "application/json", jwt);
}