/**
 * Async Resilience & Security Engine (GenoChain Enterprise Standard)
 * Based on Industry-Leading Open-Source Standards:
 * - sindresorhus/p-queue (4.3k stars): Concurrency=1 Nonce Mutex per account
 * - sindresorhus/p-retry (1.0k stars): Exponential backoff for idempotent reads
 * - Fixed-point plaintext-safe XSS & prototype-pollution sanitization for IPFS metadata
 * - eRPC & viem fallback transport: Smart receipt polling & null-receipt trap protection
 */
import PQueue from "p-queue";
import pRetry, { AbortError } from "p-retry";

// In-memory Nonce Queues per wallet address (concurrency: 1)
// Triệt tiêu hoàn toàn Nonce Gap và Mempool Collision khi dispatch nhiều giao dịch liên tiếp
const accountQueues = new Map();

/**
 * Lấy hoặc tạo hàng đợi tuần tự hóa cho một địa chỉ ví cụ thể
 * @param {string} account - Địa chỉ ví EVM
 * @returns {PQueue}
 */
export function getAccountQueue(account) {
  const key = (account || "default").toLowerCase();
  if (!accountQueues.has(key)) {
    const queue = new PQueue({ concurrency: 1 });
    accountQueues.set(key, queue);
  }
  return accountQueues.get(key);
}

/**
 * Thực thi một tác vụ ghi (State Mutator) qua hàng đợi Nonce Mutex
 * @param {string} account - Địa chỉ ví gửi
 * @param {Function} task - Hàm bất đồng bộ thực hiện giao dịch ghi
 * @returns {Promise<any>}
 */
export async function executeSerializedTx(account, task) {
  const queue = getAccountQueue(account);
  return queue.add(async () => {
    const result = await task();
    if (
      result &&
      typeof result === "object" &&
      typeof result.hash === "string" &&
      result.hash.startsWith("0x") &&
      (result.blockNumber === undefined || result.blockNumber === null) &&
      result.provider &&
      typeof result.provider.getTransactionReceipt === "function"
    ) {
      const receipt = await safePollReceipt(result.provider, result.hash);
      if (receipt && receipt.status === 0) {
        throw new Error(`Transaction reverted on-chain (${result.hash})`);
      }
    }
    return result;
  });
}

/**
 * Thực thi truy vấn đọc (Idempotent RPC / IPFS Read) kèm cơ chế tự động thử lại lùi lũy thừa
 * Không bao giờ áp dụng hàm này cho giao dịch ghi (eth_sendRawTransaction) nhằm tránh Double-Submission
 * @param {Function} readFn - Hàm đọc bất đồng bộ
 * @param {Object} options - Tùy chọn p-retry
 * @returns {Promise<any>}
 */
function isNonRetryableReadError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.nonRetryable === true) return true;
  if (err.code === 4001 || err.code === "ACTION_REJECTED") return true;
  if (err.info?.error?.code === 4001) return true;
  if (err.status === 401 || err.status === 403) return true;
  return false;
}

export async function smartReadWithRetry(readFn, options = {}) {
  const config = {
    retries: 3,
    factor: 2,
    minTimeout: 200,
    maxTimeout: 2000,
    onFailedAttempt: (ctx) => {
      const msg = ctx?.error?.message || ctx?.message || "unknown error";
      console.warn(
        `[smartReadWithRetry] Attempt ${ctx.attemptNumber} failed (${ctx.retriesLeft} retries left): ${msg}`
      );
    },
    ...options
  };

  return pRetry(async () => {
    try {
      return await readFn();
    } catch (err) {
      if (isNonRetryableReadError(err)) {
        throw new AbortError(err);
      }
      throw err;
    }
  }, config);
}

/**
 * Cơ chế truy vấn biên nhận an toàn chống cạm bẫy nút RPC bị trễ (Null Receipt Trap)
 * Tham chiếu thiết kế NotLaggingQuorum từ dự án eRPC (850 stars) và viem fallback transport
 * @param {ethers.Provider} provider - Ethers JsonRpcProvider
 * @param {string} txHash - Mã băm giao dịch (đầy đủ 0x tiền tố)
 * @param {number} maxWaitMs - Thời gian chờ tối đa (mặc định 60 giây)
 * @param {number} pollIntervalMs - Chu kỳ thăm dò (mặc định 1000ms)
 * @returns {Promise<ethers.TransactionReceipt>}
 */
export async function safePollReceipt(provider, txHash, maxWaitMs = 60000, pollIntervalMs = 1000) {
  if (!txHash || !txHash.startsWith("0x")) {
    throw new Error(`[safePollReceipt] Invalid transaction hash: ${txHash}`);
  }

  const startTime = Date.now();
  let consecutiveNulls = 0;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt && receipt.blockNumber) {
        return receipt;
      }
      consecutiveNulls++;
    } catch (err) {
      console.warn(`[safePollReceipt] RPC error polling receipt for ${txHash}:`, err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`[safePollReceipt] Timeout waiting for receipt of tx ${txHash} after ${maxWaitMs}ms (${consecutiveNulls} null responses)`);
}

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VCF_SYMBOLIC_ALLELE_RE = /<(?:DEL|INS|DUP|INV|CNV|BND|NON_REF|STR)(?::[A-Za-z0-9_.:-]+)?>/g;
const SAFE_INLINE_FORMAT_TAG_RE = /^<\/?(?:b|i|em|strong|code|sub|sup)>$/i;
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const TAB_LF_CR = "[\\t\\r\\n]*";
const DANGEROUS_SCHEME_RE = new RegExp(
  `\\b(?:j${TAB_LF_CR}a${TAB_LF_CR}v${TAB_LF_CR}a${TAB_LF_CR}s${TAB_LF_CR}c${TAB_LF_CR}r${TAB_LF_CR}i${TAB_LF_CR}p${TAB_LF_CR}t|v${TAB_LF_CR}b${TAB_LF_CR}s${TAB_LF_CR}c${TAB_LF_CR}r${TAB_LF_CR}i${TAB_LF_CR}p${TAB_LF_CR}t)\\s*:[^\\s"'<>]*`,
  "gi"
);
const DANGEROUS_DATA_URI_RE = new RegExp(
  `\\bd${TAB_LF_CR}a${TAB_LF_CR}t${TAB_LF_CR}a\\s*:\\s*(?:text\\/html|image\\/svg\\+xml|application\\/xhtml\\+xml)[^\\s"'<>]*`,
  "gi"
);
const DOM_EVENT_HANDLER_ATTR_RE =
  /\bon(?:abort|activate|afterprint|animation(?:cancel|end|iteration|start)|auxclick|before(?:input|match|print|toggle|unload|xrselect)|begin|blur|cancel|canplay(?:through)?|change|click|close|command|composition(?:end|start|update)|contentvisibilityautostatechange|context(?:lost|menu|restored)|copy|cuechange|cut|dblclick|drag(?:end|enter|exit|leave|over|start)?|drop|durationchange|emptied|end|ended|error|focus(?:in|out)?|formdata|fullscreenchange|fullscreenerror|gotpointercapture|hashchange|input|invalid|key(?:down|press|up)|languagechange|load(?:eddata|edmetadata|end|start)?|lostpointercapture|message(?:error)?|mouse(?:down|enter|leave|move|out|over|up|wheel)|offline|online|page(?:hide|reveal|show|swap)|paste|pause|play(?:ing)?|pointer(?:cancel|down|enter|leave|move|out|over|rawupdate|up)|popstate|progress|ratechange|readystatechange|repeat|reset|resize|scroll(?:end|snapchange|snapchanging)?|search|securitypolicyviolation|seek(?:ed|ing)|select(?:ionchange|start)?|show|slotchange|sort|stalled|storage|submit|suspend|timeupdate|toggle|touch(?:cancel|end|move|start)|transition(?:cancel|end|run|start)|unhandledrejection|unload|volumechange|waiting|webkitanimation(?:end|iteration|start)|webkittransitionend|wheel|zoom)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;

/**
 * Plaintext-safe XSS & control-character sanitizer for IPFS / GA4GH genomic metadata (L-04).
 * Strips dangerous HTML/SVG/script tags, HTML comments, any tag carrying attributes, inline event handlers,
 * dangerous URI schemes (including WHATWG tab/CR/LF obfuscated `java\tscript:`, `vbscript:`, `data:text/html`),
 * and ASCII control characters WITHOUT HTML-entity mangling scientific comparisons (`MAF < 5%`, `A & B`) or
 * stripping standard VCF 4.2 symbolic structural alleles (`<DEL>`, `<INS>`, `<DUP>`, `<INV>`,
 * `<CNV>`, `<BND>`) or zero-attribute benign inline formatting tags (`<b>`, `<i>`, `<em>`, `<code>`).
 * @param {string} untrustedString - Raw metadata string from IPFS or user input
 * @returns {string} - Sanitized metadata string
 */
export function sanitizeGenomicMetadata(untrustedString) {
  if (!untrustedString || typeof untrustedString !== "string") {
    return "";
  }
  let s = untrustedString.replace(CONTROL_CHARS_RE, "");

  // Preserve exact standard uppercase VCF 4.2 symbolic alleles before HTML tag stripping
  const preservedAlleles = [];
  s = s.replace(VCF_SYMBOLIC_ALLELE_RE, (match) => {
    const idx = preservedAlleles.length;
    preservedAlleles.push(match);
    return `\uE000VCF_ALLELE_${idx}\uE001`;
  });

  // Fixed-point sanitization neutralizes arbitrarily nested obfuscations (e.g. <scr<script>ipt>, java\tscript:)
  for (let pass = 0; pass < 64; pass++) {
    const prev = s;
    s = s
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/][^<>]*)?>/g, (tag) =>
        SAFE_INLINE_FORMAT_TAG_RE.test(tag) ? tag : ""
      )
      .replace(DANGEROUS_SCHEME_RE, "")
      .replace(DANGEROUS_DATA_URI_RE, "")
      .replace(DOM_EVENT_HANDLER_ATTR_RE, "");
    if (s === prev) break;
  }

  // Restore protected VCF 4.2 symbolic alleles
  if (preservedAlleles.length > 0) {
    s = s.replace(/\uE000VCF_ALLELE_(\d+)\uE001/g, (_, idxStr) => preservedAlleles[Number(idxStr)] || "");
  }
  return s;
}

/**
 * Recursively sanitize an untrusted JSON metadata tree while blocking prototype-pollution keys
 * (`__proto__`, `constructor`, `prototype`) and limiting recursion depth.
 * @param {any} val
 * @param {number} [depth=0]
 * @returns {any}
 */
export function sanitizeMetadataTree(val, depth = 0) {
  if (depth > 32) return null;
  if (typeof val === "string") return sanitizeGenomicMetadata(val);
  if (Array.isArray(val)) return val.map((item) => sanitizeMetadataTree(item, depth + 1));
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const cleanKey = sanitizeGenomicMetadata(String(k));
      if (!cleanKey || FORBIDDEN_OBJECT_KEYS.has(cleanKey)) continue;
      out[cleanKey] = sanitizeMetadataTree(v, depth + 1);
    }
    return out;
  }
  return val;
}

const NON_RANGE_RPC_PATTERNS = [
  /\b429\b/,
  /rate\s*limit/i,
  /too many requests/i,
  /requests?\s+per\s+second/i,
  /compute\s+units/i,
  /quota\s+exceeded/i,
  /max(?:imum)?\s+connections?/i,
  /\bconnections?\b/i,
  /\btimeout\b/i,
  /\beconnrefused\b/i,
  /\bblock\s+not\s+found\b/i,
  /\bheader\s+not\s+found\b/i,
  /\bmissing\s+trie\s+node\b/i,
  /\bpruned\b/i
];

const BLOCK_RANGE_ERROR_PATTERNS = [
  /query returned more than/i,
  /log response size exceeded/i,
  /more than \d+ results/i,
  /exceed(?:s|ed)?\s+(?:max(?:imum)?\s+)?(?:block|log|query|result|response)\s+(?:range|size|limit|span)/i,
  /(?:block|eth_getlogs)\s+range\s+(?:is\s+too\s+large|too\s+wide|limit|exceed)/i,
  /max(?:imum)?\s+block\s+range/i,
  /\bmax range\b/i,
  /limited\s+to\s+a\s+\d+\s+(?:block|range)/i,
  /up\s+to\s+a\s+\d+\s+block\s+range/i,
  /too many (?:logs|results|events)/i,
  /eth_getlogs.*(?:range|limit|exceed)/i,
  /response\s+size.*exceed/i,
  /suggested\s+block\s+range/i
];

export function isBlockRangeLimitError(err) {
  const msg = String(err?.shortMessage || err?.reason || err?.message || err || "");
  if (!msg) return false;
  for (const pat of NON_RANGE_RPC_PATTERNS) {
    if (pat.test(msg)) return false;
  }
  for (const pat of BLOCK_RANGE_ERROR_PATTERNS) {
    if (pat.test(msg)) return true;
  }
  return false;
}

async function queryWindowWithBisection(contract, filter, fromBlk, toBlk) {
  try {
    const logs = await contract.queryFilter(filter, fromBlk, toBlk);
    return Array.isArray(logs) ? logs : [];
  } catch (err) {
    if (toBlk > fromBlk && isBlockRangeLimitError(err)) {
      const mid = fromBlk + Math.floor((toBlk - fromBlk) / 2);
      const left = await queryWindowWithBisection(contract, filter, fromBlk, mid);
      const right = await queryWindowWithBisection(contract, filter, mid + 1, toBlk);
      return left.concat(right);
    }
    throw err;
  }
}

/**
 * Bounded-range eth_getLogs helper preventing public RPC block-range rejections.
 * Counts endpoints inclusively (endBlock - startBlock + 1 <= chunkSize -> single call,
 * zero overhead on local Hardhat) and adaptively bisects windows if a provider enforces
 * a stricter range cap while rethrowing all non-range RPC errors verbatim (INVARIANT-07).
 * @param {object} contract - Ethers v6 Contract instance
 * @param {object|string} filter - Event filter or name
 * @param {number} [fromBlock=0]
 * @param {number|string} [toBlock="latest"]
 * @param {number} [chunkSize=5000]
 * @returns {Promise<Array>}
 */
export async function queryFilterChunked(
  contract,
  filter,
  fromBlock = 0,
  toBlock = "latest",
  chunkSize = 5000
) {
  if (!contract || typeof contract.queryFilter !== "function") return [];
  const safeChunk = Math.max(1, Math.floor(Number(chunkSize) || 5000));
  const startBlock = Math.max(0, Math.floor(Number(fromBlock) || 0));
  let endBlock;
  if (typeof toBlock === "number" && Number.isFinite(toBlock)) {
    endBlock = Math.floor(toBlock);
  } else if (typeof toBlock === "string" && toBlock.trim().toLowerCase() === "earliest") {
    endBlock = 0;
  } else if (typeof toBlock === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(toBlock.trim())) {
    endBlock = Math.floor(Number(toBlock.trim()));
  } else {
    const provider = contract.runner?.provider || contract.provider || contract.runner;
    const tag = typeof toBlock === "string" ? toBlock.trim().toLowerCase() : "latest";
    if ((tag === "safe" || tag === "finalized") && provider && typeof provider.getBlock === "function") {
      const blk = await provider.getBlock(tag);
      if (blk && typeof blk.number === "number") {
        endBlock = blk.number;
      } else {
        return await contract.queryFilter(filter, startBlock, toBlock);
      }
    } else if (provider && typeof provider.getBlockNumber === "function") {
      endBlock = Number(await provider.getBlockNumber());
    } else {
      return await contract.queryFilter(filter, startBlock, toBlock);
    }
  }
  if (endBlock < startBlock) return [];
  if (endBlock - startBlock < safeChunk) {
    return await queryWindowWithBisection(contract, filter, startBlock, endBlock);
  }
  const collected = [];
  for (let cursor = startBlock; cursor <= endBlock; cursor += safeChunk) {
    const windowEnd = Math.min(endBlock, cursor + safeChunk - 1);
    const logs = await queryWindowWithBisection(contract, filter, cursor, windowEnd);
    if (logs.length > 0) {
      collected.push(...logs);
    }
  }
  return collected;
}

/**
 * Execute an async worker across an array with bounded concurrency (default 6)
 * while preserving input order and avoiding RPC connection storms.
 * @param {Array} items
 * @param {Function} worker - async (item, index) => result
 * @param {number} [concurrency=6]
 * @returns {Promise<Array>}
 */
export async function runWithConcurrency(items, worker, concurrency = 6) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const limit = Math.max(1, Math.min(items.length, Math.floor(Number(concurrency) || 6)));
  const results = new Array(items.length);
  let nextIndex = 0;
  let aborted = false;
  const runners = Array.from({ length: limit }, async () => {
    while (!aborted) {
      const current = nextIndex++;
      if (current >= items.length) break;
      try {
        results[current] = await worker(items[current], current);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Dynamically localize/adapt chain-specific UI copy so non-31337 deployments
 * (e.g. Sepolia 11155111, Base 8453) never display hardcoded "31337" or "Hardhat" strings.
 * @param {string} text
 * @param {number|string} [chainId=31337]
 * @param {string} [chainName=""]
 * @returns {string}
 */
export function formatConfiguredChainText(text, chainId = 31337, chainName = "") {
  if (!text || typeof text !== "string") return "";
  const idNum = Number(chainId);
  const idStr = Number.isInteger(idNum) && idNum > 0 ? String(idNum) : "31337";
  if (idStr === "31337") return text;
  const resolvedName = String(chainName || `EVM Network (${idStr})`).trim();
  const displayLabel = resolvedName.includes(idStr) ? resolvedName : `${resolvedName} (Chain ID ${idStr})`;
  return text
    .replace(/Hardhat Localhost \(Chain ID 31337\)/gi, displayLabel)
    .replace(/Local Hardhat EVM \(Chain ID 31337\)/gi, displayLabel)
    .replace(/local Ethereum RPC node \(31337\)\.\s*Please check your Hardhat node\./gi, `Ethereum RPC node (${displayLabel}). Please check your RPC endpoint.`)
    .replace(/cổng RPC Ethereum cục bộ \(31337\)\.\s*Vui lòng kiểm tra node Hardhat\./gi, `cổng RPC Ethereum (${displayLabel}). Vui lòng kiểm tra kết nối RPC.`)
    .replace(/\bHardhat\b/gi, resolvedName)
    .replace(/\b31337\b/g, idStr);
}