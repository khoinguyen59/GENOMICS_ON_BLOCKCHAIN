/**
 * Sovereign Key & Capsule IndexedDB Database (GenoChain Enterprise Standard)
 * Based on dexie/Dexie.js (14.6k stars)
 * Provides reliable, ACID-compliant client storage for non-extractable keys,
 * buyer capsules, and offline dataset sync.
 */
import Dexie from "dexie";

export class GenoSovereignDatabase extends Dexie {
  constructor() {
    super("GenoChainSovereignDB");
    this.version(1).stores({
      keypairs: "account, createdAt, algorithm",
      capsules: "cid, dataId, recipient, owner, updatedAt",
      cachedDatasets: "dataId, rawCid, owner, price, status"
    });
  }
}

export const sovereignDb = new GenoSovereignDatabase();

/**
 * Lưu trữ hoặc cập nhật capsule vào IndexedDB
 * @param {string} cid - IPFS CID của dataset
 * @param {string} capsuleJson - Chuỗi JSON mã hóa RSA-OAEP
 * @param {number} dataId - ID dataset on-chain
 * @param {string} recipient - Địa chỉ người nhận
 * @param {string} owner - Địa chỉ chủ sở hữu
 */
export async function saveCapsuleToDb(cid, capsuleJson, dataId = 0, recipient = "", owner = "") {
  try {
    await sovereignDb.capsules.put({
      cid,
      capsuleJson,
      dataId,
      recipient: recipient.toLowerCase(),
      owner: owner.toLowerCase(),
      updatedAt: Date.now()
    });
  } catch (err) {
    console.warn("[sovereignDb] Error saving capsule:", err);
  }
}

/**
 * Đọc capsule từ IndexedDB theo CID
 * @param {string} cid - IPFS CID
 * @returns {Promise<string|null>}
 */
export async function loadCapsuleFromDb(cid) {
  try {
    const record = await sovereignDb.capsules.get(cid);
    return record?.capsuleJson || null;
  } catch (err) {
    console.warn("[sovereignDb] Error reading capsule:", err);
    return null;
  }
}
