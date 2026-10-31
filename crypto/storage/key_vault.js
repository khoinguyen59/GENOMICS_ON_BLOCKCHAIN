/**
 * @file key_vault.js
 * @description Sovereign Key Vault persistence, IndexedDB/localStorage storage, and wallet backups.
 * @module crypto/storage/key_vault
 */
const cryptoObj = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;
if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error("Web Crypto API (crypto.subtle) is required but not available in this environment.");
}

const memKeyStore = new Map();
const memCapsuleStore = new Map();
const toHex = (arr) => Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

function openKeyDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("GenomicsKeyStoreDB", 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("keypairs")) db.createObjectStore("keypairs");
      if (!db.objectStoreNames.contains("vault_capsules")) db.createObjectStore("vault_capsules");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openKeyDatabase();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    req.onsuccess = () => resolve(req.result !== undefined ? req.result : true);
    req.onerror = () => reject(req.error);
  });
}

export async function saveOwnerCapsulePersistent(rawCid, capsule) {
  if (!rawCid || !capsule) return false;
  memCapsuleStore.set(rawCid, capsule);
  if (typeof window !== "undefined" && window.localStorage) {
    try { window.localStorage.setItem(`GENO_OWNER_CAPSULE_${rawCid}`, capsule); } catch (e) { console.warn("localStorage capsule write warning:", e); }
  }
  const res = await withStore("vault_capsules", "readwrite", (s) => s.put(capsule, rawCid));
  return res !== null ? res : true;
}

export async function loadOwnerCapsulePersistent(rawCid) {
  if (!rawCid) return null;
  try {
    const idb = await withStore("vault_capsules", "readonly", (s) => s.get(rawCid));
    if (idb) return idb;
  } catch (e) { console.warn("IndexedDB capsule read error:", e); }
  if (typeof window !== "undefined" && window.localStorage) {
    const ls = window.localStorage.getItem(`GENO_OWNER_CAPSULE_${rawCid}`);
    if (ls) return ls;
  }
  return memCapsuleStore.get(rawCid) || null;
}

export async function getAllOwnerCapsulesPersistent() {
  const capsuleMap = new Map();
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith("GENO_OWNER_CAPSULE_")) {
          const cap = window.localStorage.getItem(k);
          if (cap) capsuleMap.set(k.replace("GENO_OWNER_CAPSULE_", ""), cap);
        }
      }
    } catch (e) { console.warn("localStorage scan warning:", e); }
  }
  const db = await openKeyDatabase();
  if (db) {
    try {
      await new Promise((resolve, reject) => {
        const req = db.transaction("vault_capsules", "readonly").objectStore("vault_capsules").openCursor();
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) { capsuleMap.set(c.key, c.value); c.continue(); } else resolve();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) { console.warn("IndexedDB scan warning:", e); }
  }
  for (const [k, v] of memCapsuleStore.entries()) {
    if (!capsuleMap.has(k)) capsuleMap.set(k, v);
  }
  return Array.from(capsuleMap.entries()).map(([rawCid, capsule]) => ({ rawCid, capsule }));
}

async function deriveVaultKey(usage, { signer, account, password, salt }) {
  if (signer) {
    const sig = await signer.signMessage(`GENOCHAIN_SOVEREIGN_KEY_VAULT_BACKUP:${account.toLowerCase()}:v2`);
    const hBuf = await cryptoObj.subtle.digest("SHA-256", new TextEncoder().encode(sig));
    return await cryptoObj.subtle.importKey("raw", hBuf, { name: "AES-GCM", length: 256 }, false, [usage]);
  }
  if (password) {
    const passKey = await cryptoObj.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return await cryptoObj.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, passKey, { name: "AES-GCM", length: 256 }, false, [usage]);
  }
  throw new Error("Signer or password required for secure vault operation.");
}

export async function exportSovereignKeyVault({ signer, account, password = null }) {
  if (!account) throw new Error("Account is required to export key vault.");
  const normAccount = account.toLowerCase();
  const capsules = await getAllOwnerCapsulesPersistent();
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    version: "GENOCHAIN-SOVEREIGN-VAULT-v2", account: normAccount, capsuleCount: capsules.length, capsules, exportedAt: Date.now()
  }));
  const kdfType = signer ? "wallet-signature" : (password ? "pbkdf2" : null);
  if (!kdfType) throw new Error("Signer or password required for secure vault export.");
  const salt = password ? cryptoObj.getRandomValues(new Uint8Array(16)) : null;
  const encKey = await deriveVaultKey("encrypt", { signer, account: normAccount, password, salt });
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const encBuffer = await cryptoObj.subtle.encrypt({ name: "AES-GCM", iv }, encKey, payloadBytes);
  return JSON.stringify({
    format: "GENOCHAIN-ENCRYPTED-KEY-VAULT-v2", account: normAccount, kdf: kdfType, saltHex: salt ? toHex(salt) : "",
    ivHex: toHex(iv), ciphertextHex: toHex(new Uint8Array(encBuffer)), capsuleCount: capsules.length, createdAt: Date.now(),
  }, null, 2);
}

export async function importSovereignKeyVault({ signer, account, backupData, password = null }) {
  if (!account) throw new Error("Account is required to import key vault.");
  const norm = account.toLowerCase();
  let b;
  try { b = typeof backupData === "string" ? JSON.parse(backupData) : backupData; } catch { throw new Error("Malformed backup file: Invalid JSON syntax."); }
  if (!b || b.format !== "GENOCHAIN-ENCRYPTED-KEY-VAULT-v2") throw new Error("Invalid backup format: Not a Genochain Sovereign Key Vault backup.");
  if (!b.account || typeof b.account !== "string") throw new Error("Corrupted backup: Missing account identifier.");
  if (b.account.toLowerCase() !== norm) throw new Error(`Account mismatch: This backup belongs to ${b.account}, but active wallet is ${account}.`);
  if (!b.ivHex || typeof b.ivHex !== "string" || b.ivHex.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(b.ivHex)) throw new Error("Corrupted backup: Invalid IV parameter.");
  if (!b.ciphertextHex || typeof b.ciphertextHex !== "string" || !/^[0-9a-fA-F]+$/.test(b.ciphertextHex)) throw new Error("Corrupted backup: Invalid ciphertext payload.");
  let decKey;
  if (b.kdf === "wallet-signature") {
    if (!signer) throw new Error("Wallet signer required to restore signature-encrypted vault.");
    decKey = await deriveVaultKey("decrypt", { signer, account: b.account });
  } else if (b.kdf === "pbkdf2") {
    if (!password) throw new Error("Password required to restore PBKDF2-encrypted vault.");
    if (!b.saltHex || typeof b.saltHex !== "string" || !/^[0-9a-fA-F]+$/.test(b.saltHex)) throw new Error("Corrupted backup: Invalid PBKDF2 salt parameter.");
    decKey = await deriveVaultKey("decrypt", { password, salt: fromHex(b.saltHex) });
  } else throw new Error(`Unsupported KDF algorithm: ${b.kdf}`);

  let decBuffer;
  try {
    decBuffer = await cryptoObj.subtle.decrypt({ name: "AES-GCM", iv: fromHex(b.ivHex) }, decKey, fromHex(b.ciphertextHex));
  } catch {
    throw new Error("Decryption failed: Incorrect password or signature challenge rejected (MAC check failed).");
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(decBuffer)); } catch { throw new Error("Corrupted vault payload: Invalid decrypted structure."); }
  const restoredCids = [];
  if (Array.isArray(payload.capsules)) {
    for (const item of payload.capsules) {
      if (item.rawCid && item.capsule) {
        await saveOwnerCapsulePersistent(item.rawCid, item.capsule);
        restoredCids.push(item.rawCid);
      }
    }
  }
  return { restoredCount: restoredCids.length, rawCids: restoredCids };
}
export async function savePersistentKeyPair(account, keyPair) {
  const norm = account.toLowerCase();
  const res = await withStore("keypairs", "readwrite", (s) => s.put(keyPair, norm));
  if (res === null) memKeyStore.set(norm, keyPair);
  return true;
}
export async function loadPersistentKeyPair(account) {
  const norm = account.toLowerCase();
  const res = await withStore("keypairs", "readonly", (s) => s.get(norm));
  return res !== null ? (res || null) : (memKeyStore.get(norm) || null);
}
async function deriveSigAesKey(signer, account) {
  const sig = await signer.signMessage(`GENOMICS_IDENTITY_KEY_BACKUP:${account.toLowerCase()}:v1`);
  const hKey = await cryptoObj.subtle.digest("SHA-256", new TextEncoder().encode(sig));
  return await cryptoObj.subtle.importKey("raw", hKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function createWalletKeyBackup(signer, account, keyPair) {
  const norm = account.toLowerCase();
  const aesKey = await deriveSigAesKey(signer, norm);
  if (!keyPair.privateKey || !keyPair.privateKey.extractable) {
    throw new Error("Security Policy Enforcement: Private key is not extractable. WebCrypto API blocks raw private key material extraction; the key is securely anchored in browser IndexedDB.");
  }
  const pubJwk = await cryptoObj.subtle.exportKey("jwk", keyPair.publicKey);
  const privJwk = await cryptoObj.subtle.exportKey("jwk", keyPair.privateKey);
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const enc = await cryptoObj.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(JSON.stringify({ pubJwk, privJwk, account: norm })));
  return JSON.stringify({ version: "GENO-WALLET-BACKUP-v1", account: norm, ivHex: toHex(iv), ciphertextHex: toHex(new Uint8Array(enc)), createdAt: Date.now() }, null, 2);
}
export async function restoreWalletKeyBackup(signer, account, backupData) {
  const backup = typeof backupData === "string" ? JSON.parse(backupData) : backupData;
  const norm = account.toLowerCase();
  if (backup.account.toLowerCase() !== norm) throw new Error("Backup does not match current wallet address.");
  const aesKey = await deriveSigAesKey(signer, norm);
  const dec = await cryptoObj.subtle.decrypt({ name: "AES-GCM", iv: fromHex(backup.ivHex) }, aesKey, fromHex(backup.ciphertextHex));
  const { pubJwk, privJwk } = JSON.parse(new TextDecoder().decode(dec));
  const publicKey = await cryptoObj.subtle.importKey("jwk", pubJwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
  let privateKey = null;
  if (privJwk) {
    privateKey = await cryptoObj.subtle.importKey("jwk", privJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  } else {
    const existing = await loadPersistentKeyPair(norm);
    if (existing && existing.privateKey) privateKey = existing.privateKey;
  }
  const restoredKeyPair = { publicKey, privateKey };
  if (privateKey) await savePersistentKeyPair(norm, restoredKeyPair);
  return restoredKeyPair;
}
