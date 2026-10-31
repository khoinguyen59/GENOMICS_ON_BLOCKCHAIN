/**
 * @file pinata_client.js
 * @description Pinata Cloud REST API client for decentralized pinning.
 */

/**
 * Retrieve configured Pinata JWT from environment or localStorage
 * @returns {string|null}
 */
export function getPinataJwt() {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      const sessionSaved = window.sessionStorage.getItem("GENO_PINATA_JWT");
      if (sessionSaved && sessionSaved.trim().length > 0) return sessionSaved.trim();
    }
    if (window.localStorage) {
      const saved = window.localStorage.getItem("GENO_PINATA_JWT");
      if (saved && saved.trim().length > 0) return saved.trim();
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
    if (window.localStorage) {
      window.localStorage.setItem("GENO_PINATA_JWT", token || "");
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
  const jwt = customJwt || getPinataJwt();
  if (!jwt || typeof fetch === "undefined") {
    return null;
  }
  try {
    const formData = new FormData();
    const blob = new Blob([fileBytes], { type: mimeType });
    formData.append("file", blob, fileName);

    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      body: formData,
    });

    if (res.ok) {
      const json = await res.json();
      return { cid: json.IpfsHash, pinnedOn: "pinata-cloud" };
    }
  } catch (err) {
    console.warn("Pinata API file upload warning:", err.message);
  }
  return null;
}

/**
 * Upload JSON document to Pinata Cloud
 * @param {Object} jsonData 
 * @param {string} [name] 
 * @param {string|null} [customJwt] 
 * @returns {Promise<{ cid: string, pinnedOn: string }|null>}
 */
export async function pinJsonToPinata(jsonData, name = "metadata.json", customJwt = null) {
  const jwt = customJwt || getPinataJwt();
  if (!jwt || typeof fetch === "undefined") {
    return null;
  }
  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        pinataContent: jsonData,
        pinataMetadata: { name },
      }),
    });

    if (res.ok) {
      const json = await res.json();
      return { cid: json.IpfsHash, pinnedOn: "pinata-cloud" };
    }
  } catch (err) {
    console.warn("Pinata JSON upload warning:", err.message);
  }
  return null;
}
