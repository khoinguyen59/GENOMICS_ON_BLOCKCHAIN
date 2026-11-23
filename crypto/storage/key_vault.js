/**
 * @file key_vault.js
 * @description Sovereign Key Vault persistence, IndexedDB/localStorage storage, and wallet backups.
 * @module crypto/storage/key_vault
 */
import {
  generateAsymmetricKeyPair,
  packageKeyCapsule,
  decryptKeyCapsule,
  assertStrongRsaPublicKey,
  assertStrongRsaPrivateKey,
} from "../core/asymmetric.js";

const cryptoObj = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;
if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error("Web Crypto API (crypto.subtle) is required but not available in this environment.");
}

const memKeyStore = new Map();
const memCapsuleStore = new Map();
let activeVaultAccount = "";
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
const LEGACY_PBKDF2_ITERATIONS = 100_000;
const WALLET_BACKUP_PBKDF2_ITERATIONS = 100_000;
const BUYER_SCOPE_PREFIX = "buyer:";

function resolveBackupDomain() {
  if (
    typeof window !== "undefined" &&
    window.location &&
    typeof window.location.origin === "string" &&
    window.location.origin.trim().length > 0 &&
    window.location.origin !== "null"
  ) {
    return window.location.origin.trim();
  }
  return "genochain-local";
}
const toHex = (arr) => Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => {
  if (!hex || typeof hex !== "string") return new Uint8Array(0);
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0) return new Uint8Array(0);
  const pairs = clean.match(/.{1,2}/g);
  return pairs ? new Uint8Array(pairs.map((b) => parseInt(b, 16))) : new Uint8Array(0);
};

export function clearVaultMemoryCache() {
  memKeyStore.clear();
  memCapsuleStore.clear();
  activeVaultAccount = "";
}

function resolveScopeAccount(account) {
  if (account && typeof account === "string" && account.trim().length > 0) {
    activeVaultAccount = account.trim().toLowerCase();
    return activeVaultAccount;
  }
  return activeVaultAccount || "global";
}

function makeScopedCidKey(rawCid, account) {
  const scope = resolveScopeAccount(account);
  return `${scope}:${rawCid}`;
}

function makeScopedBuyerKey(rawCid, account) {
  const scope = resolveScopeAccount(account);
  return `${BUYER_SCOPE_PREFIX}${scope}:${rawCid}`;
}

function openKeyDatabase() {
  const idbApi =
    typeof window !== "undefined"
      ? window.indexedDB
      : (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!idbApi) {
    if (typeof window !== "undefined") {
      return Promise.reject(
        new Error(
          "IndexedDB is unavailable in this browser environment; persistent non-extractable key storage is required (INVARIANT-09)."
        )
      );
    }
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const req = idbApi.open("GenomicsKeyStoreDB", 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("keypairs")) db.createObjectStore("keypairs");
      if (!db.objectStoreNames.contains("vault_capsules")) db.createObjectStore("vault_capsules");
    };
    req.onsuccess = () => {
      const db = req.result;
      if (db && typeof db.close === "function") {
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
        };
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openKeyDatabase();
  if (!db) return null;
  const closeDb = () => {
    try {
      if (typeof db.close === "function") db.close();
    } catch { /* ignore */ }
  };
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(name, mode);
    } catch (txErr) {
      closeDb();
      reject(txErr);
      return;
    }
    let settled = false;
    let reqResult;
    const finishResolve = (val) => {
      if (!settled) {
        settled = true;
        closeDb();
        resolve(val);
      }
    };
    const fail = (err) => {
      if (!settled) {
        settled = true;
        closeDb();
        reject(err || new Error("IndexedDB transaction failed."));
      }
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error("IndexedDB transaction aborted."));
    let req;
    try {
      req = fn(tx.objectStore(name));
    } catch (syncErr) {
      fail(syncErr);
      return;
    }
    if (!req) {
      fail(new Error("IndexedDB operation returned no request."));
      return;
    }
    req.onerror = () => fail(req.error);
    if (mode === "readwrite") {
      req.onsuccess = () => {
        reqResult = req.result;
        if (typeof IDBTransaction === "undefined" || !(tx instanceof IDBTransaction)) {
          finishResolve(reqResult !== undefined ? reqResult : true);
        }
      };
      tx.oncomplete = () => {
        finishResolve(reqResult !== undefined ? reqResult : true);
      };
    } else {
      req.onsuccess = () => {
        reqResult = req.result;
        if (typeof IDBTransaction === "undefined" || !(tx instanceof IDBTransaction)) {
          finishResolve(reqResult !== undefined ? reqResult : null);
        }
      };
      tx.oncomplete = () => {
        finishResolve(reqResult !== undefined ? reqResult : null);
      };
    }
  });
}

export async function saveOwnerCapsulePersistent(rawCid, capsule, account = null) {
  if (!rawCid || !capsule) return false;
  let ownerAccount = account;
  if (!ownerAccount && typeof capsule === "string" && capsule.startsWith("{")) {
    try {
      const parsed = JSON.parse(capsule);
      if (parsed && typeof parsed.owner === "string") ownerAccount = parsed.owner;
    } catch { /* ignore */ }
  }
  const scopedKey = makeScopedCidKey(rawCid, ownerAccount);
  const res = await withStore("vault_capsules", "readwrite", (s) => s.put(capsule, scopedKey));
  memCapsuleStore.set(scopedKey, capsule);
  return res !== null ? res : true;
}

export async function loadOwnerCapsulePersistent(rawCid, account = null) {
  if (!rawCid) return null;
  const scopedKey = makeScopedCidKey(rawCid, account);
  try {
    const idb = await withStore("vault_capsules", "readonly", (s) => s.get(scopedKey));
    if (typeof idb === "string" && idb.length > 0) return idb;
  } catch (e) { console.warn("IndexedDB capsule read error:", e); }
  if (memCapsuleStore.has(scopedKey)) return memCapsuleStore.get(scopedKey);
  if (!account) {
    for (const [k, v] of memCapsuleStore.entries()) {
      if (k.startsWith(BUYER_SCOPE_PREFIX)) continue;
      if (k === rawCid || k.endsWith(`:${rawCid}`)) return v;
    }
  }
  return null;
}

export async function saveBuyerCapsulePersistent(rawCid, capsule, account = null) {
  if (!rawCid || !capsule) return false;
  let buyerAccount = account;
  if (!buyerAccount && typeof capsule === "string" && capsule.startsWith("{")) {
    try {
      const parsed = JSON.parse(capsule);
      if (parsed && typeof parsed.recipient === "string") buyerAccount = parsed.recipient;
    } catch { /* ignore */ }
  }
  const scopedKey = makeScopedBuyerKey(rawCid, buyerAccount);
  const res = await withStore("vault_capsules", "readwrite", (s) => s.put(capsule, scopedKey));
  memCapsuleStore.set(scopedKey, capsule);
  return res !== null ? res : true;
}

export async function loadBuyerCapsulePersistent(rawCid, account = null) {
  if (!rawCid) return null;
  const scopedKey = makeScopedBuyerKey(rawCid, account);
  try {
    const idb = await withStore("vault_capsules", "readonly", (s) => s.get(scopedKey));
    if (typeof idb === "string" && idb.length > 0) return idb;
  } catch (e) { console.warn("IndexedDB buyer capsule read error:", e); }
  if (memCapsuleStore.has(scopedKey)) return memCapsuleStore.get(scopedKey);
  if (!account) {
    for (const [k, v] of memCapsuleStore.entries()) {
      if (k.startsWith(BUYER_SCOPE_PREFIX) && k.endsWith(`:${rawCid}`)) return v;
    }
  }
  return null;
}

export async function getAllBuyerCapsulesPersistent(account = null) {
  const scopePrefix = account
    ? `${BUYER_SCOPE_PREFIX}${account.trim().toLowerCase()}:`
    : (activeVaultAccount ? `${BUYER_SCOPE_PREFIX}${activeVaultAccount}:` : BUYER_SCOPE_PREFIX);
  const matchesBuyer = (key, capStr) => {
    if (typeof key !== "string" || !key.startsWith(BUYER_SCOPE_PREFIX)) return false;
    if (scopePrefix === BUYER_SCOPE_PREFIX) return true;
    if (key.startsWith(scopePrefix)) return true;
    if (typeof capStr === "string" && capStr.startsWith("{")) {
      try {
        const parsed = JSON.parse(capStr);
        if (parsed?.recipient && `${BUYER_SCOPE_PREFIX}${parsed.recipient.toLowerCase()}:` === scopePrefix) return true;
      } catch { /* ignore */ }
    }
    return false;
  };
  const stripBuyerScope = (key) => {
    const withoutPrefix = key.slice(BUYER_SCOPE_PREFIX.length);
    return withoutPrefix.includes(":") ? withoutPrefix.slice(withoutPrefix.indexOf(":") + 1) : withoutPrefix;
  };

  const capsuleMap = new Map();
  const db = await openKeyDatabase();
  if (db) {
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("vault_capsules", "readonly");
        tx.onerror = () => reject(tx.error || new Error("IndexedDB buyer scan transaction failed."));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB buyer scan transaction aborted."));
        const req = tx.objectStore("vault_capsules").openCursor();
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) {
            if (matchesBuyer(c.key, c.value)) capsuleMap.set(stripBuyerScope(c.key), c.value);
            c.continue();
          } else resolve();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) { console.warn("IndexedDB buyer scan warning:", e); }
    finally {
      try { if (typeof db.close === "function") db.close(); } catch { /* ignore */ }
    }
  }
  for (const [k, v] of memCapsuleStore.entries()) {
    if (matchesBuyer(k, v)) {
      const bareCid = stripBuyerScope(k);
      if (!capsuleMap.has(bareCid)) capsuleMap.set(bareCid, v);
    }
  }
  return Array.from(capsuleMap.entries()).map(([rawCid, capsule]) => ({ rawCid, capsule }));
}

export async function getAllOwnerCapsulesPersistent(account = null) {
  const scopePrefix = account ? `${account.trim().toLowerCase()}:` : (activeVaultAccount ? `${activeVaultAccount}:` : null);
  const matchesAccount = (key, capStr) => {
    if (typeof key === "string" && key.startsWith(BUYER_SCOPE_PREFIX)) return false;
    if (!scopePrefix) return true;
    if (typeof key === "string" && key.startsWith(scopePrefix)) return true;
    if (typeof capStr === "string" && capStr.startsWith("{")) {
      try {
        const parsed = JSON.parse(capStr);
        if (parsed?.owner && `${parsed.owner.toLowerCase()}:` === scopePrefix) return true;
      } catch { /* ignore */ }
    }
    return false;
  };
  const stripScope = (key) => (typeof key === "string" && key.includes(":") ? key.slice(key.indexOf(":") + 1) : key);

  const capsuleMap = new Map();
  const db = await openKeyDatabase();
  if (db) {
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("vault_capsules", "readonly");
        tx.onerror = () => reject(tx.error || new Error("IndexedDB scan transaction failed."));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB scan transaction aborted."));
        const req = tx.objectStore("vault_capsules").openCursor();
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) {
            if (matchesAccount(c.key, c.value)) capsuleMap.set(stripScope(c.key), c.value);
            c.continue();
          } else resolve();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) { console.warn("IndexedDB scan warning:", e); }
    finally {
      try { if (typeof db.close === "function") db.close(); } catch { /* ignore */ }
    }
  }
  for (const [k, v] of memCapsuleStore.entries()) {
    if (matchesAccount(k, v)) {
      const bareCid = stripScope(k);
      if (!capsuleMap.has(bareCid)) capsuleMap.set(bareCid, v);
    }
  }
  return Array.from(capsuleMap.entries()).map(([rawCid, capsule]) => ({ rawCid, capsule }));
}

async function deriveVaultKey(usage, { signer, account, password, salt, iterations = DEFAULT_PBKDF2_ITERATIONS, domain = null }) {
  if (signer) {
    if (!salt || salt.length !== 16 || typeof domain !== "string" || domain.trim().length === 0) {
      throw new Error("Corrupted backup: Wallet-signature v2 vault requires a 16-byte salt and domain binding.");
    }
    const saltHex = toHex(salt);
    const safeIters =
      Number.isInteger(iterations) && iterations >= LEGACY_PBKDF2_ITERATIONS && iterations <= MAX_PBKDF2_ITERATIONS
        ? iterations
        : WALLET_BACKUP_PBKDF2_ITERATIONS;
    const sig = await signer.signMessage(
      `GENOCHAIN_SOVEREIGN_KEY_VAULT_BACKUP:${account.toLowerCase()}:domain=${domain}:salt=${saltHex}:v2`
    );
    const baseKey = await cryptoObj.subtle.importKey("raw", new TextEncoder().encode(sig), "PBKDF2", false, ["deriveKey"]);
    return await cryptoObj.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: safeIters, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      [usage]
    );
  }
  if (password) {
    const normalizedPassword = String(password).normalize("NFC");
    const safeIters =
      Number.isInteger(iterations) && iterations >= LEGACY_PBKDF2_ITERATIONS && iterations <= MAX_PBKDF2_ITERATIONS
        ? iterations
        : DEFAULT_PBKDF2_ITERATIONS;
    const passKey = await cryptoObj.subtle.importKey("raw", new TextEncoder().encode(normalizedPassword), "PBKDF2", false, ["deriveKey"]);
    return await cryptoObj.subtle.deriveKey({ name: "PBKDF2", salt, iterations: safeIters, hash: "SHA-256" }, passKey, { name: "AES-GCM", length: 256 }, false, [usage]);
  }
  throw new Error("Signer or password required for secure vault operation.");
}

async function buildPortableRecords(normAccount, capsules, explicitKeyPair = null) {
  const kp = explicitKeyPair || (await loadPersistentKeyPair(normAccount));
  if (!kp || !kp.privateKey || !Array.isArray(capsules)) return [];
  const portable = [];
  for (const item of capsules) {
    if (!item || !item.rawCid || !item.capsule) continue;
    try {
      const { keyHex, summaryKeyHex } = await decryptKeyCapsule(item.capsule, kp.privateKey);
      if (keyHex && keyHex.length === 64) {
        let owner = normAccount;
        try {
          const parsed = typeof item.capsule === "string" ? JSON.parse(item.capsule) : item.capsule;
          if (parsed?.owner && typeof parsed.owner === "string") owner = parsed.owner;
        } catch { /* ignore */ }
        portable.push({
          rawCid: item.rawCid,
          keyHex,
          ...(summaryKeyHex && summaryKeyHex.length === 64 ? { summaryKeyHex } : {}),
          owner
        });
      }
    } catch {
      // Non-standard or pre-wrapped foreign capsule; keep raw capsule record
    }
  }
  return portable;
}

async function restoreCapsuleCollection(
  normAccount,
  capsules,
  portableRecords,
  activePair,
  saveFn
) {
  let keyRotated = false;
  const portableMap = new Map();
  if (Array.isArray(portableRecords)) {
    for (const rec of portableRecords) {
      if (rec && rec.rawCid && typeof rec.keyHex === "string" && /^[0-9a-fA-F]{64}$/.test(rec.keyHex)) {
        portableMap.set(rec.rawCid, {
          keyHex: rec.keyHex,
          summaryKeyHex: typeof rec.summaryKeyHex === "string" && /^[0-9a-fA-F]{64}$/.test(rec.summaryKeyHex) ? rec.summaryKeyHex : null,
          owner: typeof rec.owner === "string" && rec.owner ? rec.owner : normAccount
        });
      }
    }
  }

  const restoredCids = [];
  const seen = new Set();
  if (Array.isArray(capsules)) {
    for (const item of capsules) {
      if (!item || !item.rawCid || !item.capsule) continue;
      let capsuleToStore = item.capsule;
      const portableRec = portableMap.get(item.rawCid);
      if (activePair && activePair.privateKey && activePair.publicKey && portableRec) {
        let localValid = false;
        try {
          await decryptKeyCapsule(item.capsule, activePair.privateKey);
          localValid = true;
        } catch {
          localValid = false;
        }
        if (!localValid) {
          capsuleToStore = await packageKeyCapsule(
            portableRec.keyHex,
            activePair.publicKey,
            normAccount,
            portableRec.owner || normAccount,
            portableRec.summaryKeyHex ? { summaryKeyHex: portableRec.summaryKeyHex } : null
          );
          keyRotated = true;
        }
      }
      await saveFn(item.rawCid, capsuleToStore, normAccount);
      restoredCids.push(item.rawCid);
      seen.add(item.rawCid);
    }
  }
  if (activePair && activePair.publicKey) {
    for (const [rawCid, rec] of portableMap.entries()) {
      if (!seen.has(rawCid)) {
        const rewrapped = await packageKeyCapsule(
          rec.keyHex,
          activePair.publicKey,
          normAccount,
          rec.owner || normAccount,
          rec.summaryKeyHex ? { summaryKeyHex: rec.summaryKeyHex } : null
        );
        await saveFn(rawCid, rewrapped, normAccount);
        restoredCids.push(rawCid);
        keyRotated = true;
      }
    }
  }
  portableMap.clear();
  return { restoredCids, keyRotated };
}

async function restoreCapsulesAcrossDevices(
  normAccount,
  capsules,
  portableRecords,
  targetKeyPair,
  buyerCapsules = [],
  portableBuyerRecords = []
) {
  let activePair = targetKeyPair || (await loadPersistentKeyPair(normAccount));
  let keyRotated = false;
  const hasPortable =
    (Array.isArray(portableRecords) && portableRecords.length > 0) ||
    (Array.isArray(portableBuyerRecords) && portableBuyerRecords.length > 0);
  if (!activePair && hasPortable) {
    activePair = await generateAsymmetricKeyPair(false);
    await savePersistentKeyPair(normAccount, activePair);
    keyRotated = true;
  }

  const ownerRes = await restoreCapsuleCollection(
    normAccount,
    capsules,
    portableRecords,
    activePair,
    saveOwnerCapsulePersistent
  );
  const buyerRes = await restoreCapsuleCollection(
    normAccount,
    buyerCapsules,
    portableBuyerRecords,
    activePair,
    saveBuyerCapsulePersistent
  );

  return {
    restoredCids: ownerRes.restoredCids,
    restoredBuyerCids: buyerRes.restoredCids,
    keyRotated: keyRotated || ownerRes.keyRotated || buyerRes.keyRotated
  };
}

export async function exportSovereignKeyVault({ signer, account, password = null, extraBuyerCapsules = [] }) {
  if (!account) throw new Error("Account is required to export key vault.");
  const normAccount = account.toLowerCase();
  activeVaultAccount = normAccount;
  const hasPassword = typeof password === "string" && password.length > 0;
  const kdfType = hasPassword ? "pbkdf2" : (signer ? "wallet-signature" : null);
  if (!kdfType) throw new Error("Signer or password required for secure vault export.");
  const capsules = await getAllOwnerCapsulesPersistent(normAccount);
  const storedBuyers = await getAllBuyerCapsulesPersistent(normAccount);
  const buyerMap = new Map(storedBuyers.map((item) => [item.rawCid, item.capsule]));
  if (Array.isArray(extraBuyerCapsules)) {
    for (const item of extraBuyerCapsules) {
      if (item && item.rawCid && item.capsule && !buyerMap.has(item.rawCid)) {
        buyerMap.set(item.rawCid, item.capsule);
      }
    }
  }
  const buyerCapsules = Array.from(buyerMap.entries()).map(([rawCid, capsule]) => ({ rawCid, capsule }));
  const portableRecords = await buildPortableRecords(normAccount, capsules);
  const portableBuyerRecords = await buildPortableRecords(normAccount, buyerCapsules);
  const backupDomain = kdfType === "wallet-signature" ? resolveBackupDomain() : undefined;
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    version: "GENOCHAIN-SOVEREIGN-VAULT-v2",
    account: normAccount,
    ...(backupDomain ? { domain: backupDomain } : {}),
    capsuleCount: capsules.length + buyerCapsules.length,
    ownerCapsuleCount: capsules.length,
    buyerCapsuleCount: buyerCapsules.length,
    capsules,
    portableRecords,
    buyerCapsules,
    portableBuyerRecords,
    exportedAt: Date.now()
  }));
  const salt = cryptoObj.getRandomValues(new Uint8Array(16));
  const iterations = kdfType === "pbkdf2" ? DEFAULT_PBKDF2_ITERATIONS : WALLET_BACKUP_PBKDF2_ITERATIONS;
  const encKey = await deriveVaultKey("encrypt", {
    signer: kdfType === "wallet-signature" ? signer : null,
    account: normAccount,
    password: kdfType === "pbkdf2" ? password : null,
    salt,
    iterations,
    domain: backupDomain || null
  });
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const encBuffer = await cryptoObj.subtle.encrypt({ name: "AES-GCM", iv }, encKey, payloadBytes);
  return JSON.stringify({
    format: "GENOCHAIN-ENCRYPTED-KEY-VAULT-v2",
    account: normAccount,
    kdf: kdfType,
    ...(backupDomain ? { domain: backupDomain } : {}),
    ...(iterations ? { iterations } : {}),
    saltHex: toHex(salt),
    ivHex: toHex(iv),
    ciphertextHex: toHex(new Uint8Array(encBuffer)),
    capsuleCount: capsules.length + buyerCapsules.length,
    ownerCapsuleCount: capsules.length,
    buyerCapsuleCount: buyerCapsules.length,
    createdAt: Date.now(),
  }, null, 2);
}

export async function importSovereignKeyVault({ signer, account, backupData, password = null }) {
  if (!account) throw new Error("Account is required to import key vault.");
  const norm = account.toLowerCase();
  activeVaultAccount = norm;
  let b;
  try { b = typeof backupData === "string" ? JSON.parse(backupData) : backupData; } catch { throw new Error("Malformed backup file: Invalid JSON syntax."); }
  if (!b || b.format !== "GENOCHAIN-ENCRYPTED-KEY-VAULT-v2") throw new Error("Invalid backup format: Not a Genochain Sovereign Key Vault backup.");
  if (!b.account || typeof b.account !== "string") throw new Error("Corrupted backup: Missing account identifier.");
  if (b.account.toLowerCase() !== norm) throw new Error(`Account mismatch: This backup belongs to ${b.account}, but active wallet is ${account}.`);
  if (!b.ivHex || typeof b.ivHex !== "string" || b.ivHex.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(b.ivHex)) throw new Error("Corrupted backup: Invalid IV parameter.");
  if (!b.ciphertextHex || typeof b.ciphertextHex !== "string" || b.ciphertextHex.length < 32 || b.ciphertextHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(b.ciphertextHex)) throw new Error("Corrupted backup: Invalid ciphertext payload.");
  let decKey;
  let expectedWalletDomain = null;
  if (b.kdf === "wallet-signature") {
    if (!signer) throw new Error("Wallet signer required to restore signature-encrypted vault.");
    if (typeof b.saltHex !== "string" || !/^[0-9a-fA-F]{32}$/.test(b.saltHex)) {
      throw new Error("Corrupted backup: Missing or invalid wallet-signature v2 KDF salt parameter.");
    }
    if (typeof b.domain !== "string" || b.domain.trim().length === 0) {
      throw new Error("Corrupted backup: Missing or invalid wallet-signature v2 domain binding.");
    }
    const currentDomain = resolveBackupDomain();
    if (b.domain !== currentDomain) {
      throw new Error(`Backup domain mismatch: expected ${currentDomain}, got ${b.domain}.`);
    }
    let walletIters = WALLET_BACKUP_PBKDF2_ITERATIONS;
    if (b.iterations !== undefined) {
      if (
        !Number.isInteger(b.iterations) ||
        b.iterations < LEGACY_PBKDF2_ITERATIONS ||
        b.iterations > MAX_PBKDF2_ITERATIONS
      ) {
        throw new Error(
          `Invalid PBKDF2 iterations parameter: expected an integer between ${LEGACY_PBKDF2_ITERATIONS} and ${MAX_PBKDF2_ITERATIONS}.`
        );
      }
      walletIters = b.iterations;
    }
    expectedWalletDomain = currentDomain;
    decKey = await deriveVaultKey("decrypt", {
      signer,
      account: b.account,
      salt: fromHex(b.saltHex),
      iterations: walletIters,
      domain: currentDomain
    });
  } else if (b.kdf === "pbkdf2") {
    if (!password) throw new Error("Password required to restore PBKDF2-encrypted vault.");
    if (!b.saltHex || typeof b.saltHex !== "string" || b.saltHex.length < 16 || b.saltHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(b.saltHex)) throw new Error("Corrupted backup: Invalid PBKDF2 salt parameter.");
    let pbkdf2Iterations = LEGACY_PBKDF2_ITERATIONS;
    if (b.iterations !== undefined) {
      if (
        !Number.isInteger(b.iterations) ||
        b.iterations < LEGACY_PBKDF2_ITERATIONS ||
        b.iterations > MAX_PBKDF2_ITERATIONS
      ) {
        throw new Error(
          `Invalid PBKDF2 iterations parameter: expected an integer between ${LEGACY_PBKDF2_ITERATIONS} and ${MAX_PBKDF2_ITERATIONS}.`
        );
      }
      pbkdf2Iterations = b.iterations;
    }
    decKey = await deriveVaultKey("decrypt", { password, salt: fromHex(b.saltHex), iterations: pbkdf2Iterations });
  } else throw new Error(`Unsupported KDF algorithm: ${b.kdf}`);

  let decBuffer;
  try {
    decBuffer = await cryptoObj.subtle.decrypt({ name: "AES-GCM", iv: fromHex(b.ivHex) }, decKey, fromHex(b.ciphertextHex));
  } catch {
    throw new Error("Decryption failed: Incorrect password or signature challenge rejected (MAC check failed).");
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(decBuffer)); } catch { throw new Error("Corrupted vault payload: Invalid decrypted structure."); }
  if (!payload || typeof payload !== "object") {
    throw new Error("Corrupted vault payload: Invalid decrypted structure.");
  }
  if (!payload.account || typeof payload.account !== "string" || payload.account.toLowerCase() !== norm) {
    throw new Error(`Account mismatch in decrypted vault payload: expected ${account}, got ${payload.account || "none"}.`);
  }
  if (expectedWalletDomain && (typeof payload.domain !== "string" || payload.domain !== expectedWalletDomain)) {
    throw new Error(`Backup domain mismatch in decrypted vault payload: expected ${expectedWalletDomain}, got ${payload.domain || "none"}.`);
  }
  const { restoredCids, restoredBuyerCids, keyRotated } = await restoreCapsulesAcrossDevices(
    norm,
    payload.capsules,
    payload.portableRecords,
    null,
    payload.buyerCapsules || [],
    payload.portableBuyerRecords || []
  );
  return {
    restoredCount: restoredCids.length + restoredBuyerCids.length,
    ownerRestoredCount: restoredCids.length,
    buyerRestoredCount: restoredBuyerCids.length,
    rawCids: restoredCids,
    buyerCids: restoredBuyerCids,
    keyRotated,
    requiresPublicKeyReRegistration: keyRotated,
  };
}
export async function savePersistentKeyPair(account, keyPair) {
  const norm = account.toLowerCase();
  activeVaultAccount = norm;
  await withStore("keypairs", "readwrite", (s) => s.put(keyPair, norm));
  memKeyStore.set(norm, keyPair);
  return true;
}
export async function loadPersistentKeyPair(account) {
  const norm = account.toLowerCase();
  activeVaultAccount = norm;
  const res = await withStore("keypairs", "readonly", (s) => s.get(norm));
  if (res && typeof res === "object" && res.publicKey && res.privateKey) return res;
  return memKeyStore.get(norm) || null;
}
async function deriveSigAesKeyLegacyV1(signer, account) {
  const sig = await signer.signMessage(`GENOMICS_IDENTITY_KEY_BACKUP:${account.toLowerCase()}:v1`);
  const hKey = await cryptoObj.subtle.digest("SHA-256", new TextEncoder().encode(sig));
  return await cryptoObj.subtle.importKey("raw", hKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function deriveSigAesKeyV2(signer, account, domain, kdfSaltHex) {
  const norm = account.toLowerCase();
  const sig = await signer.signMessage(`GENOMICS_IDENTITY_KEY_BACKUP:${norm}:domain=${domain}:salt=${kdfSaltHex}:v2`);
  const baseKey = await cryptoObj.subtle.importKey("raw", new TextEncoder().encode(sig), "PBKDF2", false, ["deriveKey"]);
  return await cryptoObj.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromHex(kdfSaltHex),
      iterations: WALLET_BACKUP_PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
export async function createWalletKeyBackup(signer, account, keyPair, extraBuyerCapsules = []) {
  if (!account) throw new Error("Account is required for wallet key backup.");
  if (!keyPair || !keyPair.publicKey || !keyPair.privateKey) throw new Error("Valid asymmetric keyPair is required.");
  assertStrongRsaPublicKey(keyPair.publicKey);
  assertStrongRsaPrivateKey(keyPair.privateKey);
  const norm = account.toLowerCase();
  const pubJwk = await cryptoObj.subtle.exportKey("jwk", keyPair.publicKey);
  let privJwk = null;
  let nonExtractableAnchored = false;
  if (keyPair.privateKey.extractable) {
    privJwk = await cryptoObj.subtle.exportKey("jwk", keyPair.privateKey);
    if (!pubJwk?.n || !privJwk?.n || pubJwk.n !== privJwk.n) {
      throw new Error("RSA keypair mismatch: public and private key moduli do not match.");
    }
  } else {
    if (!signer || typeof signer.getAddress !== "function") {
      throw new Error("INVARIANT-09 Enforcement: Private key is not extractable");
    }
    nonExtractableAnchored = true;
    await savePersistentKeyPair(norm, keyPair);
  }
  const domain = resolveBackupDomain();
  const kdfSaltHex = toHex(cryptoObj.getRandomValues(new Uint8Array(16)));
  const aesKey = await deriveSigAesKeyV2(signer, norm, domain, kdfSaltHex);
  const capsules = await getAllOwnerCapsulesPersistent(norm);
  const storedBuyers = await getAllBuyerCapsulesPersistent(norm);
  const buyerMap = new Map(storedBuyers.map((item) => [item.rawCid, item.capsule]));
  if (Array.isArray(extraBuyerCapsules)) {
    for (const item of extraBuyerCapsules) {
      if (item && item.rawCid && item.capsule && !buyerMap.has(item.rawCid)) {
        buyerMap.set(item.rawCid, item.capsule);
      }
    }
  }
  const buyerCapsules = Array.from(buyerMap.entries()).map(([rawCid, capsule]) => ({ rawCid, capsule }));
  const portableRecords = await buildPortableRecords(norm, capsules, keyPair);
  const portableBuyerRecords = await buildPortableRecords(norm, buyerCapsules, keyPair);
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const enc = await cryptoObj.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(
      JSON.stringify({
        pubJwk,
        privJwk,
        nonExtractableAnchored,
        capsules,
        portableRecords,
        buyerCapsules,
        portableBuyerRecords,
        account: norm,
        domain
      })
    )
  );
  return JSON.stringify({
    version: "GENO-WALLET-BACKUP-v2",
    account: norm,
    domain,
    kdfSaltHex,
    nonExtractableAnchored,
    ivHex: toHex(iv),
    ciphertextHex: toHex(new Uint8Array(enc)),
    createdAt: Date.now()
  }, null, 2);
}
export async function restoreWalletKeyBackup(signer, account, backupData) {
  if (typeof account !== "string" || !account.trim()) {
    throw new Error("Corrupted wallet backup envelope.");
  }
  let backup;
  try {
    backup = typeof backupData === "string" ? JSON.parse(backupData) : backupData;
  } catch {
    throw new Error("Corrupted wallet backup envelope.");
  }
  const norm = account.toLowerCase();
  if (!backup || typeof backup !== "object" || typeof backup.account !== "string") {
    throw new Error("Corrupted wallet backup envelope.");
  }
  if (backup.account.toLowerCase() !== norm) throw new Error("Backup does not match current wallet address.");
  if (
    typeof backup.ivHex !== "string" ||
    !/^[0-9a-fA-F]{24}$/.test(backup.ivHex) ||
    typeof backup.ciphertextHex !== "string" ||
    backup.ciphertextHex.length < 32 ||
    backup.ciphertextHex.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(backup.ciphertextHex)
  ) {
    throw new Error("Corrupted wallet backup envelope.");
  }
  if (backup.version !== "GENO-WALLET-BACKUP-v1" && backup.version !== "GENO-WALLET-BACKUP-v2") {
    throw new Error("Corrupted wallet backup envelope.");
  }
  const isV2 = backup.version === "GENO-WALLET-BACKUP-v2";
  if (!isV2 && (backup.kdfSaltHex !== undefined || backup.domain !== undefined)) {
    throw new Error("Corrupted wallet backup envelope.");
  }
  let aesKey;
  let expectedDomain = null;
  if (isV2) {
    if (typeof backup.kdfSaltHex !== "string" || !/^[0-9a-fA-F]{32}$/.test(backup.kdfSaltHex)) {
      throw new Error("Corrupted wallet backup envelope.");
    }
    if (typeof backup.domain !== "string" || backup.domain.trim().length === 0) {
      throw new Error("Corrupted wallet backup envelope.");
    }
    const currentDomain = resolveBackupDomain();
    if (backup.domain !== currentDomain) {
      throw new Error(`Backup domain mismatch: backup is bound to ${backup.domain}, current origin is ${currentDomain}.`);
    }
    expectedDomain = currentDomain;
    aesKey = await deriveSigAesKeyV2(signer, norm, currentDomain, backup.kdfSaltHex);
  } else {
    aesKey = await deriveSigAesKeyLegacyV1(signer, norm);
  }
  const dec = await cryptoObj.subtle.decrypt({ name: "AES-GCM", iv: fromHex(backup.ivHex) }, aesKey, fromHex(backup.ciphertextHex));
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(dec));
  } catch {
    throw new Error("Corrupted wallet backup payload: Invalid decrypted JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Corrupted wallet backup payload: Expected decrypted JSON object.");
  }
  if (parsed.account && String(parsed.account).toLowerCase() !== norm) {
    throw new Error("Account mismatch in decrypted wallet backup payload.");
  }
  if (expectedDomain && (typeof parsed.domain !== "string" || parsed.domain !== expectedDomain)) {
    throw new Error(`Backup domain mismatch in decrypted payload: expected ${expectedDomain}, got ${parsed.domain || "none"}.`);
  }
  const { pubJwk, privJwk, capsules, portableRecords, buyerCapsules, portableBuyerRecords } = parsed;
  if (!pubJwk || typeof pubJwk !== "object" || Array.isArray(pubJwk) || typeof pubJwk.n !== "string" || !pubJwk.n) {
    throw new Error("Corrupted wallet backup payload: Missing or invalid RSA public JWK.");
  }
  let publicKey = await cryptoObj.subtle.importKey("jwk", pubJwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
  assertStrongRsaPublicKey(publicKey);
  let privateKey = null;
  let keyRotated = false;
  if (privJwk !== undefined && privJwk !== null) {
    if (typeof privJwk !== "object" || Array.isArray(privJwk) || typeof privJwk.n !== "string" || !privJwk.n) {
      throw new Error("Corrupted wallet backup payload: Invalid RSA private JWK.");
    }
    if (privJwk.n !== pubJwk.n) {
      throw new Error("RSA keypair mismatch in wallet backup: public and private key moduli do not match.");
    }
    privateKey = await cryptoObj.subtle.importKey("jwk", privJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    assertStrongRsaPrivateKey(privateKey);
  } else {
    const existing = await loadPersistentKeyPair(norm);
    if (existing && existing.privateKey) {
      privateKey = existing.privateKey;
      if (existing.publicKey) {
        publicKey = existing.publicKey;
      }
    } else {
      const freshPair = await generateAsymmetricKeyPair(false);
      publicKey = freshPair.publicKey;
      privateKey = freshPair.privateKey;
      keyRotated = true;
    }
  }
  if (privateKey) await savePersistentKeyPair(norm, { publicKey, privateKey });
  const { restoredCids, restoredBuyerCids, keyRotated: capsulesKeyRotated } = await restoreCapsulesAcrossDevices(
    norm,
    capsules,
    portableRecords,
    privateKey ? { publicKey, privateKey } : null,
    buyerCapsules || [],
    portableBuyerRecords || []
  );
  const effectiveKeyRotated = keyRotated || Boolean(capsulesKeyRotated);
  return {
    publicKey,
    privateKey,
    keyRotated: effectiveKeyRotated,
    requiresPublicKeyReRegistration: effectiveKeyRotated,
    restoredCount: restoredCids.length + restoredBuyerCids.length,
    ownerRestoredCount: restoredCids.length,
    buyerRestoredCount: restoredBuyerCids.length,
    rawCids: restoredCids,
    buyerCids: restoredBuyerCids
  };
}