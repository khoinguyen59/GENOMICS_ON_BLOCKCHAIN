import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ethers } from "ethers";
import contractAddresses from "../contracts/contractAddresses.json";
import { useLanguage } from "./LanguageContext";
import GenomicTokenABI from "../contracts/GenomicTokenABI.json";
import GenomicNFTABI from "../contracts/GenomicNFTABI.json";
import GenomicsRegistryABI from "../contracts/GenomicsRegistryABI.json";
import {
  generateAsymmetricKeyPair,
  savePersistentKeyPair,
  loadPersistentKeyPair,
  exportPublicKey,
  clearVaultMemoryCache,
} from "../../../crypto/client_crypto.js";
import {
  getPinataJwt,
  getKuboRpcEndpoint,
  getKuboGatewayEndpoint,
  normalizeKuboEndpoint,
  setPinataJwt as setPinataJwtStorage,
  setKuboRpcEndpoint as setKuboRpcStorage,
  setKuboGatewayEndpoint as setKuboGatewayStorage,
  clearLocalIpfsCache
} from "../../../ipfs/pinata_uploader.js";
import { executeSerializedTx, formatConfiguredChainText } from "../utils/asyncResilience";

const Web3Context = createContext(null);

// Configurable EVM RPC & Chain ID (L-10 network portability; defaults to Local Hardhat 31337 / 1337)
export const CONFIGURED_CHAIN_ID = (() => {
  const raw = typeof import.meta !== "undefined" ? import.meta.env?.VITE_CHAIN_ID : undefined;
  const parsed = raw !== undefined && String(raw).trim() !== "" ? Number(raw) : Number(contractAddresses.chainId || 31337);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 31337;
})();
export const CONFIGURED_RPC_URL = (() => {
  const raw = typeof import.meta !== "undefined" ? String(import.meta.env?.VITE_RPC_URL || "").trim() : "";
  if (raw) return raw;
  // Never dial 127.0.0.1:8545 on non-31337 networks when VITE_RPC_URL is unset
  return CONFIGURED_CHAIN_ID === 31337 ? "http://127.0.0.1:8545" : "";
})();
export const CONFIGURED_CHAIN_HEX = `0x${CONFIGURED_CHAIN_ID.toString(16)}`;
export const CONFIGURED_CHAIN_NAME =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_CHAIN_NAME) ||
  (CONFIGURED_CHAIN_ID === 31337 ? "Hardhat Localhost (31337)" : `EVM Network (${CONFIGURED_CHAIN_ID})`);

function isSupportedTargetChain(chainIdHex) {
  const num = Number(chainIdHex);
  if (num === CONFIGURED_CHAIN_ID) return true;
  // On default local dev (31337), also accept Ganache/Hardhat alias 1337 (0x539)
  if (CONFIGURED_CHAIN_ID === 31337 && (chainIdHex === "0x7a69" || chainIdHex === "0x539" || num === 1337)) {
    return true;
  }
  return false;
}

// Singleton static-network JsonRpcProvider (null when non-31337 chain has no VITE_RPC_URL configured)
const LOCAL_STATIC_NETWORK = ethers.Network.from(CONFIGURED_CHAIN_ID);
const LOCAL_RPC_PROVIDER = CONFIGURED_RPC_URL
  ? new ethers.JsonRpcProvider(CONFIGURED_RPC_URL, LOCAL_STATIC_NETWORK, {
      staticNetwork: LOCAL_STATIC_NETWORK
    })
  : null;

export function Web3Provider({ children }) {
  const { t, lang } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const langRef = useRef(lang);
  langRef.current = lang;

  // Top-Level Role Switcher: 'researcher' (Marketplace) | 'donor' (Data Provider) | 'admin' (Governance)
  const [userRole, setUserRole] = useState("researcher");

  // Sub-Navigation Tabs
  const [donorTab, setDonorTab] = useState("upload");
  const [researcherTab, setResearcherTab] = useState("catalog");
  const [viewMode, setViewMode] = useState("grid"); // 'grid' | 'table' (OpenSea/DeSci default)

  // Blockchain & Wallet State
  const [account, setAccount] = useState("");
  const [localAccountIndex, setLocalAccountIndex] = useState(null);
  const localAccountIndexRef = useRef(null);
  const connectionEpochRef = useRef(0);
  const accountRef = useRef("");
  const signerRef = useRef(null);
  const providerRef = useRef(null);
  const contractsRef = useRef(null);
  const [rpcOnline, setRpcOnline] = useState(true);
  const [wrongChain, setWrongChain] = useState(false);
  const [genoBalance, setGenoBalance] = useState(0);
  const [contracts, setContracts] = useState(null);
  const [signer, setSigner] = useState(null);
  const [provider, setProvider] = useState(null);

  // ECIES Non-extractable Keypair
  const [researcherKeyPair, setResearcherKeyPair] = useState(null);
  const [isPubKeyRegisteredOnChain, setIsPubKeyRegisteredOnChain] = useState(false);

  // IPFS Settings State
  const [showIpfsSettings, setShowIpfsSettings] = useState(false);
  const [pinataJwt, setPinataJwtState] = useState(getPinataJwt() || "");
  const [kuboRpc, setKuboRpcState] = useState(getKuboRpcEndpoint() || "");
  const [kuboGateway, setKuboGatewayState] = useState(getKuboGatewayEndpoint() || "");
  const [pinataJwtInput, setPinataJwtInput] = useState(getPinataJwt() || "");
  const [kuboRpcInput, setKuboRpcInput] = useState(getKuboRpcEndpoint() || "");
  const [kuboGatewayInput, setKuboGatewayInput] = useState(getKuboGatewayEndpoint() || "");

  // Faucet Policy & Voucher Modal State
  const [faucetEnabled, setFaucetEnabled] = useState(true);
  const [faucetVoucherRequired, setFaucetVoucherRequired] = useState(false);
  const [showFaucetVoucherModal, setShowFaucetVoucherModal] = useState(false);

  const updateIpfsSettings = useCallback((jwt, rpc, gateway) => {
    // Validate BOTH endpoints BEFORE mutating sessionStorage so an invalid gateway URL never
    // leaves GENO_KUBO_RPC partially updated.
    const rawRpc = typeof rpc === "string" ? rpc.trim() : "";
    if (rawRpc && !normalizeKuboEndpoint(rawRpc, null)) {
      throw new Error("Invalid Kubo RPC URL: expected an http:// or https:// endpoint.");
    }
    if (gateway !== undefined) {
      const rawGw = typeof gateway === "string" ? gateway.trim() : "";
      if (rawGw && !normalizeKuboEndpoint(rawGw, null)) {
        throw new Error("Invalid Kubo Gateway URL: expected an http:// or https:// endpoint.");
      }
    }
    const normalizedRpc = setKuboRpcStorage(rpc);
    const normalizedGw = gateway !== undefined ? setKuboGatewayStorage(gateway) : undefined;
    setPinataJwtStorage(jwt);
    const resolvedRpc = normalizedRpc || getKuboRpcEndpoint();
    const resolvedGw = normalizedGw !== undefined ? (normalizedGw || getKuboGatewayEndpoint()) : getKuboGatewayEndpoint();
    setPinataJwtState(jwt);
    setKuboRpcState(resolvedRpc);
    setKuboRpcInput(resolvedRpc);
    setKuboGatewayState(resolvedGw);
    setKuboGatewayInput(resolvedGw);
    return resolvedRpc;
  }, []);

  // Toast Notification
  const [toast, setToast] = useState(null);
  const toastTimeoutRef = useRef(null);
  const manualDisconnectRef = useRef(false);

  const showToast = useCallback((message, type = "success") => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setToast({ message, type });
    toastTimeoutRef.current = setTimeout(() => {
      setToast(null);
      toastTimeoutRef.current = null;
    }, 3500);
  }, []);

  const clearToast = useCallback(() => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToast(null);
  }, []);

  const buildContractBundle = useCallback((s, p) => {
    const resolvedProvider = p || LOCAL_RPC_PROVIDER;
    const runner = s || resolvedProvider;
    if (!runner) return null;
    const token = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, runner);
    const nft = new ethers.Contract(contractAddresses.GenomicNFT, GenomicNFTABI, runner);
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, runner);
    return { token, nft, registry, signer: s || null, provider: resolvedProvider };
  }, []);

  // Provider & Signer Resolver (Stable ref-backed callback — zero EIP-1193 render loops)
  const getProviderAndSigner = useCallback(async () => {
    const startEpoch = connectionEpochRef.current;
    if (localAccountIndexRef.current !== null && signerRef.current) {
      return {
        provider: providerRef.current || LOCAL_RPC_PROVIDER,
        signer: signerRef.current,
        epoch: startEpoch
      };
    }
    if (accountRef.current && signerRef.current) {
      return {
        provider: providerRef.current || LOCAL_RPC_PROVIDER,
        signer: signerRef.current,
        epoch: startEpoch
      };
    }
    if (accountRef.current && !signerRef.current && typeof window !== "undefined" && window.ethereum) {
      try {
        const [chainIdHex, accounts] = await Promise.all([
          window.ethereum.request({ method: "eth_chainId" }),
          window.ethereum.request({ method: "eth_accounts" })
        ]);
        if (connectionEpochRef.current !== startEpoch || localAccountIndexRef.current !== null) {
          return {
            provider: providerRef.current || LOCAL_RPC_PROVIDER,
            signer: signerRef.current,
            epoch: connectionEpochRef.current
          };
        }
        const isLocalChain = isSupportedTargetChain(chainIdHex);
        if (isLocalChain && accounts && accounts.length > 0) {
          const p = new ethers.BrowserProvider(window.ethereum);
          const s = await p.getSigner();
          if (connectionEpochRef.current !== startEpoch || localAccountIndexRef.current !== null) {
            return {
              provider: providerRef.current || LOCAL_RPC_PROVIDER,
              signer: signerRef.current,
              epoch: connectionEpochRef.current
            };
          }
          return { provider: p, signer: s, epoch: startEpoch };
        }
      } catch (rpcErr) {
        console.warn(
          formatConfiguredChainText(
            "[Web3Context] Browser wallet provider failed; falling back to read-only Local Hardhat RPC:",
            CONFIGURED_CHAIN_ID,
            CONFIGURED_CHAIN_NAME
          ),
          rpcErr?.message || rpcErr
        );
      }
    }
    if (signerRef.current) {
      return {
        provider: providerRef.current || LOCAL_RPC_PROVIDER,
        signer: signerRef.current,
        epoch: connectionEpochRef.current
      };
    }
    return { provider: LOCAL_RPC_PROVIDER, signer: null, epoch: connectionEpochRef.current };
  }, []);

  // Contract Instances Resolver with monotonic connection-epoch guard (never overwrites newer signer)
  const getContracts = useCallback(async (explicitSigner = null, explicitProvider = null, expectedEpoch = null) => {
    const targetEpoch = expectedEpoch ?? connectionEpochRef.current;

    if (explicitSigner) {
      const p = explicitProvider || LOCAL_RPC_PROVIDER;
      const c = buildContractBundle(explicitSigner, p);
      if (connectionEpochRef.current !== targetEpoch) {
        return contractsRef.current || buildContractBundle(signerRef.current, providerRef.current || LOCAL_RPC_PROVIDER);
      }
      contractsRef.current = c;
      signerRef.current = explicitSigner;
      providerRef.current = p;
      setContracts(c);
      setSigner(explicitSigner);
      setProvider(p);
      return c;
    }

    const activeProvider = providerRef.current || LOCAL_RPC_PROVIDER;
    if (
      contractsRef.current &&
      contractsRef.current.signer === signerRef.current &&
      contractsRef.current.provider === activeProvider
    ) {
      return contractsRef.current;
    }

    const resolved = await getProviderAndSigner();
    if (connectionEpochRef.current !== targetEpoch) {
      return contractsRef.current || buildContractBundle(signerRef.current, providerRef.current || LOCAL_RPC_PROVIDER);
    }

    const c = buildContractBundle(resolved.signer, resolved.provider);
    if (!c) return null;

    contractsRef.current = c;
    setContracts(c);
    if (resolved.signer && resolved.signer !== signerRef.current) {
      signerRef.current = resolved.signer;
      setSigner(resolved.signer);
    }
    if (resolved.provider && resolved.provider !== providerRef.current) {
      providerRef.current = resolved.provider;
      setProvider(resolved.provider);
    }
    return c;
  }, [buildContractBundle, getProviderAndSigner]);

  // Keypair Initializer (epoch-guarded to prevent stale account key overwrite)
  const initPersistentKey = useCallback(async (acc, contractsInstance = null, expectedEpoch = null) => {
    if (!acc) return null;
    const myEpoch = expectedEpoch ?? connectionEpochRef.current;
    try {
      let kp = await loadPersistentKeyPair(acc);
      if (connectionEpochRef.current !== myEpoch || accountRef.current.toLowerCase() !== acc.toLowerCase()) {
        return null;
      }
      if (!kp) {
        kp = await generateAsymmetricKeyPair(false);
        await savePersistentKeyPair(acc, kp);
      }
      if (connectionEpochRef.current !== myEpoch || accountRef.current.toLowerCase() !== acc.toLowerCase()) {
        return null;
      }
      setResearcherKeyPair(kp);

      const activeContracts = contractsInstance || (await getContracts(null, null, myEpoch));
      if (activeContracts) {
        const onChainKey = await activeContracts.registry.researcherPublicKeys(acc);
        const localPubJwk = kp?.publicKey ? await exportPublicKey(kp.publicKey) : "";
        if (connectionEpochRef.current !== myEpoch || accountRef.current.toLowerCase() !== acc.toLowerCase()) {
          return null;
        }
        let matchesDeviceKey = false;
        if (onChainKey && onChainKey.trim().length > 0 && localPubJwk) {
          try {
            const onChainParsed = JSON.parse(onChainKey);
            const localParsed = JSON.parse(localPubJwk);
            matchesDeviceKey = Boolean(
              onChainParsed?.n && localParsed?.n && onChainParsed.n === localParsed.n
            );
          } catch {
            matchesDeviceKey = onChainKey.trim() === localPubJwk.trim();
          }
        }
        setIsPubKeyRegisteredOnChain(matchesDeviceKey);
      }
      return kp;
    } catch (err) {
      console.error("Key init error:", err);
      return null;
    }
  }, [getContracts]);

  const refreshKeyVaultState = useCallback(async () => {
    const activeAcc = accountRef.current;
    if (!activeAcc) return null;
    return await initPersistentKey(activeAcc, contractsRef.current, connectionEpochRef.current);
  }, [initPersistentKey]);

  // Connect Local Hardhat Signer Directly by Account Index (#0 Admin, #1 Provider, #2 Researcher)
  const connectLocalAccount = useCallback(async (idx = 0) => {
    const myEpoch = ++connectionEpochRef.current;
    manualDisconnectRef.current = false;
    const targetIdx = typeof idx === "number" ? idx : 0;
    // Update ref synchronously BEFORE any await so in-flight EIP-1193 handlers abort immediately
    localAccountIndexRef.current = targetIdx;
    setLocalAccountIndex(targetIdx);
    try {
      const jsonRpc = LOCAL_RPC_PROVIDER;
      if (!jsonRpc) {
        showToast(
          langRef.current === "vi"
            ? "Chưa cấu hình VITE_RPC_URL cho mạng EVM hiện tại."
            : "No VITE_RPC_URL configured for the current EVM network.",
          "error"
        );
        return null;
      }
      const s = await jsonRpc.getSigner(targetIdx);
      if (connectionEpochRef.current !== myEpoch) return null;
      const addr = await s.getAddress();
      if (connectionEpochRef.current !== myEpoch) return null;

      if (accountRef.current && accountRef.current.toLowerCase() !== addr.toLowerCase()) {
        clearVaultMemoryCache();
        setResearcherKeyPair(null);
        setIsPubKeyRegisteredOnChain(false);
      }
      accountRef.current = addr;
      signerRef.current = s;
      providerRef.current = jsonRpc;

      setWrongChain(false);
      setRpcOnline(true);
      setAccount(addr);
      setSigner(s);
      setProvider(jsonRpc);

      const c = await getContracts(s, jsonRpc, myEpoch);
      if (connectionEpochRef.current !== myEpoch) return null;

      if (c) {
        const balWei = await c.token.balanceOf(addr);
        if (connectionEpochRef.current !== myEpoch) return null;
        setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
      }
      await initPersistentKey(addr, c, myEpoch);
      if (connectionEpochRef.current !== myEpoch) return null;
      const acctTag = formatConfiguredChainText(`Hardhat #${targetIdx}`, CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME);
      showToast(`${tRef.current("walletConnectedMsg")} (${acctTag}): ${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`);
      return addr;
    } catch (err) {
      if (connectionEpochRef.current === myEpoch) {
        showToast("Local RPC connection failed: " + (err.shortMessage || err.message), "error");
      }
      return null;
    }
  }, [getContracts, initPersistentKey, showToast]);

  // Connect Wallet Action (MetaMask with automatic fallback to Local Hardhat RPC)
  const connectWallet = useCallback(async (customIdx) => {
    if (typeof customIdx === "number") {
      return await connectLocalAccount(customIdx);
    }
    const myEpoch = ++connectionEpochRef.current;
    manualDisconnectRef.current = false;
    const connectLocalHardhat = async () => {
      return await connectLocalAccount(1);
    };

    if (typeof window !== "undefined" && window.ethereum) {
      try {
        let chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
        if (connectionEpochRef.current !== myEpoch) return null;
        let isLocalChain = isSupportedTargetChain(chainIdHex);
        if (!isLocalChain) {
          try {
            await window.ethereum.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: CONFIGURED_CHAIN_HEX }]
            });
            if (connectionEpochRef.current !== myEpoch) return null;
            chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
            if (connectionEpochRef.current !== myEpoch) return null;
            isLocalChain = isSupportedTargetChain(chainIdHex);
          } catch (switchErr) {
            if (switchErr?.code === 4902 && CONFIGURED_RPC_URL) {
              try {
                await window.ethereum.request({
                  method: "wallet_addEthereumChain",
                  params: [
                    {
                      chainId: CONFIGURED_CHAIN_HEX,
                      chainName: CONFIGURED_CHAIN_NAME,
                      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                      rpcUrls: [CONFIGURED_RPC_URL]
                    }
                  ]
                });
                if (connectionEpochRef.current !== myEpoch) return null;
                isLocalChain = true;
              } catch {
                showToast(`Please add and switch to ${CONFIGURED_CHAIN_NAME} in MetaMask.`, "error");
                throw new Error(`Unsupported network. Please switch to ${CONFIGURED_CHAIN_NAME}.`);
              }
            } else {
              showToast(`Please switch MetaMask network to ${CONFIGURED_CHAIN_NAME}.`, "error");
              throw new Error(`Unsupported network. Please switch to ${CONFIGURED_CHAIN_NAME}.`);
            }
          }
        }
        if (!isLocalChain) {
          showToast(`MetaMask is on an unsupported chain. Please switch to ${CONFIGURED_CHAIN_NAME}.`, "error");
          return null;
        }
        const p = new ethers.BrowserProvider(window.ethereum);
        const accounts = await p.send("eth_requestAccounts", []);
        if (connectionEpochRef.current !== myEpoch) return null;
        if (accounts.length > 0) {
          const userAddr = accounts[0];
          const s = await p.getSigner();
          if (connectionEpochRef.current !== myEpoch) return null;
          if (accountRef.current && accountRef.current.toLowerCase() !== userAddr.toLowerCase()) {
            clearVaultMemoryCache();
          }
          localAccountIndexRef.current = null;
          accountRef.current = userAddr;
          signerRef.current = s;
          providerRef.current = p;
          setLocalAccountIndex(null);
          setWrongChain(false);
          setAccount(userAddr);
          setSigner(s);
          setProvider(p);
          const c = await getContracts(s, p, myEpoch);
          if (connectionEpochRef.current !== myEpoch) return null;
          if (c) {
            const balWei = await c.token.balanceOf(userAddr);
            if (connectionEpochRef.current !== myEpoch) return null;
            setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
          }
          await initPersistentKey(userAddr, c, myEpoch);
          if (connectionEpochRef.current !== myEpoch) return null;
          showToast(`${tRef.current("walletConnectedMsg")}: ${userAddr.substring(0, 6)}...${userAddr.substring(userAddr.length - 4)}`);
          return userAddr;
        }
      } catch (err) {
        if (connectionEpochRef.current === myEpoch) {
          showToast("MetaMask connection notice: " + (err.shortMessage || err.message), "error");
        }
        return null;
      }
    } else if (CONFIGURED_CHAIN_ID === 31337) {
      try {
        return await connectLocalHardhat();
      } catch {
        showToast("Please install MetaMask or start local RPC node.", "error");
      }
    } else {
      showToast(`Please install and unlock MetaMask to connect on ${CONFIGURED_CHAIN_NAME}.`, "error");
    }
    return null;
  }, [connectLocalAccount, getContracts, initPersistentKey, showToast]);

  // Disconnect Wallet Action
  const disconnectWallet = useCallback(() => {
    ++connectionEpochRef.current;
    manualDisconnectRef.current = true;
    clearVaultMemoryCache();
    clearLocalIpfsCache();
    localAccountIndexRef.current = null;
    accountRef.current = "";
    signerRef.current = null;
    providerRef.current = null;
    contractsRef.current = null;
    setLocalAccountIndex(null);
    setWrongChain(false);
    setAccount("");
    setGenoBalance(0);
    setSigner(null);
    setProvider(null);
    setContracts(null);
    setResearcherKeyPair(null);
    setIsPubKeyRegisteredOnChain(false);
    setShowFaucetVoucherModal(false);
    showToast(tRef.current("walletDisconnectedMsg"), "info");
  }, [showToast]);

  // Refresh On-Chain Faucet Policy (open vs voucher-gated mode)
  const refreshFaucetPolicy = useCallback(async (explicitToken = null) => {
    try {
      const readProv = providerRef.current || LOCAL_RPC_PROVIDER;
      const tok =
        explicitToken ||
        contractsRef.current?.token ||
        (readProv ? new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, readProv) : null);
      if (!tok) {
        return { enabled: true, voucherRequired: false };
      }
      const [enabled, voucherReq] = await Promise.all([
        tok.faucetEnabled?.().catch(() => true),
        tok.faucetVoucherRequired?.().catch(() => false)
      ]);
      const isEnabled = Boolean(enabled);
      const isVoucherReq = Boolean(voucherReq);
      setFaucetEnabled(isEnabled);
      setFaucetVoucherRequired(isVoucherReq);
      if (!isEnabled || !isVoucherReq) {
        setShowFaucetVoucherModal(false);
      }
      return { enabled: isEnabled, voucherRequired: isVoucherReq };
    } catch {
      return { enabled: true, voucherRequired: false };
    }
  }, []);

  // Faucet Claim Action (supports both open 1-click faucet & Admin voucher-gated claimFaucetWithVoucher)
  const claimFaucet = useCallback(async (voucherParams = null) => {
    const rawVoucher =
      voucherParams && typeof voucherParams === "object" && "voucher" in voucherParams
        ? voucherParams.voucher
        : voucherParams &&
            typeof voucherParams === "object" &&
            !("nativeEvent" in voucherParams) &&
            "nonce" in voucherParams &&
            "deadline" in voucherParams &&
            "signature" in voucherParams
          ? voucherParams
          : null;

    let targetAccount = account;
    if (!targetAccount) {
      targetAccount = await connectWallet();
      if (!targetAccount) return { ok: false };
    }
    try {
      const { signer: s } = await getProviderAndSigner();
      let activeSigner = s;
      if (!activeSigner) {
        if (localAccountIndexRef.current !== null && targetAccount && LOCAL_RPC_PROVIDER) {
          activeSigner = await LOCAL_RPC_PROVIDER.getSigner(targetAccount);
        } else {
          showToast(
            langRef.current === "vi"
              ? "Vui lòng kết nối ví EVM có chữ ký trước khi nhận Faucet."
              : "Please connect a wallet with an active signer before claiming Faucet.",
            "error"
          );
          return { ok: false };
        }
      }
      const tokenWithSigner = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, activeSigner);
      const [isFaucetEnabled, isVoucherRequired] = await Promise.all([
        tokenWithSigner.faucetEnabled?.().catch(() => true),
        tokenWithSigner.faucetVoucherRequired?.().catch(() => false)
      ]);
      setFaucetEnabled(Boolean(isFaucetEnabled));
      setFaucetVoucherRequired(Boolean(isVoucherRequired));

      if (!isFaucetEnabled) {
        setShowFaucetVoucherModal(false);
        showToast(tRef.current("faucetDisabledMsg"), "error");
        return { ok: false, disabled: true };
      }

      if (isVoucherRequired) {
        if (!rawVoucher) {
          showToast(tRef.current("faucetVoucherRequiredToast"), "info");
          setShowFaucetVoucherModal(true);
          return { ok: false, voucherRequired: true };
        }
        const MAX_UINT256 = (1n << 256n) - 1n;
        const nonceStr = String(rawVoucher.nonce ?? "").trim();
        const deadlineStr = String(rawVoucher.deadline ?? "").trim();
        const sigStr = String(rawVoucher.signature ?? "").trim();
        const isValidNonce = /^\d+$/.test(nonceStr) && BigInt(nonceStr) <= MAX_UINT256;
        const isValidDeadline =
          /^\d+$/.test(deadlineStr) && BigInt(deadlineStr) > 0n && BigInt(deadlineStr) <= MAX_UINT256;
        if (!isValidNonce || !isValidDeadline || !/^0x[0-9a-fA-F]{130}$/.test(sigStr)) {
          showToast(tRef.current("faucetVoucherInvalidInput"), "error");
          return { ok: false, invalidVoucherInput: true };
        }
        showToast(tRef.current("faucetVoucherClaimingMsg"), "info");
        await executeSerializedTx(targetAccount, async () => {
          const tx = await tokenWithSigner.claimFaucetWithVoucher(
            targetAccount,
            BigInt(nonceStr),
            BigInt(deadlineStr),
            sigStr
          );
          await tx.wait();
        });
      } else {
        setShowFaucetVoucherModal(false);
        showToast(tRef.current("faucetRequestingMsg"), "info");
        await executeSerializedTx(targetAccount, async () => {
          const tx = await tokenWithSigner.faucet(targetAccount);
          await tx.wait();
        });
      }
      const balWei = await tokenWithSigner.balanceOf(targetAccount);
      if (accountRef.current && accountRef.current.toLowerCase() === targetAccount.toLowerCase()) {
        setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
      }
      setShowFaucetVoucherModal(false);
      showToast(tRef.current("faucetSuccessMsg"));
      return { ok: true };
    } catch (err) {
      let parsedErrorName = null;
      try {
        const tokenIface = new ethers.Interface(GenomicTokenABI);
        const rawErrData =
          err?.data ||
          err?.info?.error?.data ||
          err?.error?.data ||
          (typeof err?.message === "string" ? err.message.match(/data="(0x[0-9a-fA-F]+)"/)?.[1] : null);
        if (typeof rawErrData === "string" && rawErrData.startsWith("0x")) {
          if (rawErrData.toLowerCase().startsWith("0x9ad22e0f")) {
            parsedErrorName = "FaucetCooldownActive";
          } else {
            const parsed = tokenIface.parseError(rawErrData);
            if (parsed?.name) {
              parsedErrorName = parsed.name;
            }
          }
        }
      } catch {}
      if (
        parsedErrorName === "FaucetCooldownActive" ||
        (err?.message && (err.message.includes("FaucetCooldownActive") || err.message.includes("0x9ad22e0f")))
      ) {
        showToast(tRef.current("faucetCooldownMsg"), "error");
      } else if (parsedErrorName === "FaucetVoucherRequired") {
        setFaucetVoucherRequired(true);
        setShowFaucetVoucherModal(true);
        showToast(tRef.current("faucetVoucherRequiredToast"), "info");
      } else if (parsedErrorName === "InvalidFaucetVoucher") {
        showToast(tRef.current("faucetVoucherInvalidErr"), "error");
      } else if (parsedErrorName === "FaucetVoucherExpired") {
        showToast(tRef.current("faucetVoucherExpiredErr"), "error");
      } else if (parsedErrorName === "FaucetVoucherUsed") {
        showToast(tRef.current("faucetVoucherUsedErr"), "error");
      } else if (parsedErrorName === "FaucetDisabled") {
        setFaucetEnabled(false);
        setShowFaucetVoucherModal(false);
        showToast(tRef.current("faucetDisabledMsg"), "error");
      } else {
        showToast((langRef.current === "vi" ? "Lỗi Faucet: " : "Faucet error: ") + (err.shortMessage || err.message), "error");
      }
      return { ok: false, error: err };
    }
  }, [account, connectWallet, getProviderAndSigner, showToast]);

  // Deflationary Token Burn Action
  const burnTokens = useCallback(async (amountGeno) => {
    if (!account) {
      showToast(langRef.current === "vi" ? "Vui lòng kết nối ví trước." : "Connect your wallet first.", "error");
      return;
    }
    try {
      const { signer: s } = await getProviderAndSigner();
      if (!s) throw new Error("Active signer required to burn tokens.");
      const tokenWithSigner = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, s);
      const burnWei = ethers.parseUnits(amountGeno.toString(), 18);
      showToast(langRef.current === "vi" ? `Đang đốt ${amountGeno} $GENO...` : `Burning ${amountGeno} $GENO...`, "info");
      const burnAccount = account;
      await executeSerializedTx(burnAccount, async () => {
        const tx = await tokenWithSigner.burn(burnWei);
        await tx.wait();
      });
      const balWei = await tokenWithSigner.balanceOf(burnAccount);
      if (accountRef.current && accountRef.current.toLowerCase() === burnAccount.toLowerCase()) {
        setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
      }
      showToast(langRef.current === "vi" ? `Đã đốt thành công ${amountGeno} $GENO!` : `Successfully burned ${amountGeno} $GENO!`);
    } catch (err) {
      showToast((langRef.current === "vi" ? "Lỗi đốt token: " : "Burn error: ") + (err.shortMessage || err.message), "error");
    }
  }, [account, getProviderAndSigner, showToast]);

  // Refresh GENO Token Balance (epoch & active-account guarded)
  const refreshBalance = useCallback(async (targetAccount) => {
    const myEpoch = connectionEpochRef.current;
    const activeAccount = targetAccount || accountRef.current;
    if (!activeAccount) return 0;
    if (accountRef.current && activeAccount.toLowerCase() !== accountRef.current.toLowerCase()) {
      return 0;
    }
    try {
      const c = contractsRef.current || (await getContracts(null, null, myEpoch));
      if (c && c.token) {
        const balWei = await c.token.balanceOf(activeAccount);
        if (
          connectionEpochRef.current !== myEpoch ||
          !accountRef.current ||
          activeAccount.toLowerCase() !== accountRef.current.toLowerCase()
        ) {
          return 0;
        }
        const balFmt = Number(ethers.formatUnits(balWei, 18));
        setGenoBalance(balFmt);
        return balFmt;
      }
    } catch (e) {
      console.warn("Refresh balance warning:", e);
    }
    return 0;
  }, [getContracts]);

  // Register Researcher Public Key on EVM (GenomicsRegistry)
  const registerPublicKeyOnChain = useCallback(async () => {
    if (!account || !researcherKeyPair) {
      showToast(
        langRef.current === "vi"
          ? "Ví hoặc cặp khóa mã hóa chưa được khởi tạo."
          : "Wallet or encryption keypair not initialized.",
        "error"
      );
      return false;
    }
    try {
      const c = contracts || (await getContracts());
      if (!c || !c.registry) throw new Error("Registry contract unavailable");
      showToast(
        langRef.current === "vi"
          ? "Đang đăng ký khóa công khai giải mã lên EVM..."
          : "Registering encryption public key on EVM...",
        "info"
      );
      const pubKeyAccount = account;
      const pubJwk = await exportPublicKey(researcherKeyPair.publicKey);
      await executeSerializedTx(pubKeyAccount, async () => {
        const regTx = await c.registry.registerResearcherPublicKey(pubJwk);
        await regTx.wait();
      });
      if (accountRef.current && accountRef.current.toLowerCase() === pubKeyAccount.toLowerCase()) {
        setIsPubKeyRegisteredOnChain(true);
      }
      showToast(
        langRef.current === "vi"
          ? "Đã đăng ký khóa công khai lên EVM thành công!"
          : "Public key registered on EVM successfully!"
      );
      return true;
    } catch (err) {
      showToast(
        (langRef.current === "vi" ? "Đăng ký khóa công khai thất bại: " : "Public key registration failed: ") +
          (err.reason || err.message),
        "error"
      );
      return false;
    }
  }, [account, researcherKeyPair, contracts, getContracts, showToast]);

  // Initial load and MetaMask event listeners (accountsChanged, chainChanged) — mount-once effect
  useEffect(() => {
    getContracts();
    refreshFaucetPolicy();

    let alive = true;
    const checkRpcHealth = async () => {
      const activeProv = providerRef.current || LOCAL_RPC_PROVIDER;
      if (!activeProv) {
        if (alive) setRpcOnline(true);
        return;
      }
      try {
        await activeProv.getBlockNumber();
        if (alive) setRpcOnline(true);
      } catch {
        if (alive) setRpcOnline(false);
      }
    };
    checkRpcHealth();
    const healthTimer = setInterval(checkRpcHealth, 10000);

    if (typeof window === "undefined" || !window.ethereum) {
      return () => {
        alive = false;
        clearInterval(healthTimer);
      };
    }

    const handleAccountsChanged = async (accounts) => {
      if (!alive || localAccountIndexRef.current !== null) {
        return;
      }
      const myEpoch = ++connectionEpochRef.current;
      const isStale = () =>
        !alive || localAccountIndexRef.current !== null || connectionEpochRef.current !== myEpoch;

      if (!accounts || accounts.length === 0) {
        manualDisconnectRef.current = true;
        clearVaultMemoryCache();
        clearLocalIpfsCache();
        accountRef.current = "";
        signerRef.current = null;
        providerRef.current = null;
        contractsRef.current = null;
        setWrongChain(false);
        setAccount("");
        setGenoBalance(0);
        setSigner(null);
        setProvider(null);
        setContracts(null);
        setResearcherKeyPair(null);
        setIsPubKeyRegisteredOnChain(false);
        setShowFaucetVoucherModal(false);
        showToast(tRef.current("walletDisconnectedMsg"), "info");
      } else {
        const newAddr = accounts[0];
        manualDisconnectRef.current = false;
        clearVaultMemoryCache();
        clearLocalIpfsCache();
        // Immediately clear prior account signer/contracts/keypair BEFORE any await so Account A can never bleed into Account B
        signerRef.current = null;
        contractsRef.current = null;
        setSigner(null);
        setContracts(null);
        setResearcherKeyPair(null);
        setIsPubKeyRegisteredOnChain(false);

        let onLocal = false;
        try {
          const cidHex = await window.ethereum.request({ method: "eth_chainId" });
          if (isStale()) return;
          onLocal = isSupportedTargetChain(cidHex);
          setWrongChain(!onLocal);
        } catch {
          if (isStale()) return;
          setWrongChain(true);
        }
        // Stop immediately on unsupported chains — clear stale signer/balance to prevent split-brain
        if (!onLocal || isStale()) {
          if (!isStale()) {
            signerRef.current = null;
            providerRef.current = null;
            contractsRef.current = null;
            setSigner(null);
            setProvider(null);
            setContracts(null);
            setGenoBalance(0);
          }
          return;
        }

        let p = null;
        let s = null;
        let c = null;
        try {
          p = new ethers.BrowserProvider(window.ethereum);
          s = await p.getSigner(newAddr);
          const resolvedAddr = await s.getAddress();
          if (isStale()) return;
          if (!resolvedAddr || resolvedAddr.toLowerCase() !== newAddr.toLowerCase()) {
            throw new Error("Signer address mismatch during account transition");
          }
          accountRef.current = newAddr;
          providerRef.current = p;
          signerRef.current = s;
          setAccount(newAddr);
          setProvider(p);
          setSigner(s);
          c = await getContracts(s, p, myEpoch);
        } catch {
          if (isStale()) return;
          signerRef.current = null;
          providerRef.current = LOCAL_RPC_PROVIDER;
          accountRef.current = newAddr;
          c = buildContractBundle(null, LOCAL_RPC_PROVIDER);
          contractsRef.current = c;
          setSigner(null);
          setProvider(LOCAL_RPC_PROVIDER);
          setContracts(c);
          setAccount(newAddr);
        }
        if (isStale()) return;

        if (c && c.token) {
          try {
            const balWei = await c.token.balanceOf(newAddr);
            if (isStale()) return;
            setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
          } catch {}
        }
        if (isStale()) return;

        await initPersistentKey(newAddr, c, myEpoch);
        if (isStale()) return;
        showToast(`${tRef.current("walletConnectedMsg")}: ${newAddr.substring(0, 6)}...${newAddr.substring(newAddr.length - 4)}`);
      }
    };

    const handleChainChanged = () => {
      ++connectionEpochRef.current;
      window.location.reload();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    // Auto-detect existing connected accounts once on mount (only if already on Local Hardhat Chain 31337)
    const mountEpoch = connectionEpochRef.current;
    Promise.all([
      window.ethereum.request({ method: "eth_chainId" }),
      window.ethereum.request({ method: "eth_accounts" })
    ])
      .then(([chainIdHex, accs]) => {
        if (!alive || localAccountIndexRef.current !== null || connectionEpochRef.current !== mountEpoch) {
          return;
        }
        const isLocalChain = isSupportedTargetChain(chainIdHex);
        setWrongChain(!isLocalChain && Boolean(accs && accs.length > 0 && localAccountIndexRef.current === null));
        if (isLocalChain && accs && accs.length > 0 && !manualDisconnectRef.current && localAccountIndexRef.current === null) {
          handleAccountsChanged(accs);
        }
      })
      .catch(() => {});

    return () => {
      alive = false;
      clearInterval(healthTimer);
      if (window.ethereum?.removeListener) {
        window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
        window.ethereum.removeListener("chainChanged", handleChainChanged);
      }
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, [buildContractBundle, getContracts, initPersistentKey, showToast]);

  const value = useMemo(
    () => ({
      userRole,
      setUserRole,
      donorTab,
      setDonorTab,
      researcherTab,
      setResearcherTab,
      viewMode,
      setViewMode,
      account,
      genoBalance,
      setGenoBalance,
      refreshBalance,
      contracts,
      signer,
      provider,
      getContracts,
      getProviderAndSigner,
      researcherKeyPair,
      isPubKeyRegisteredOnChain,
      registerPublicKeyOnChain,
      refreshKeyVaultState,
      ensureKeyPair: refreshKeyVaultState,
      showIpfsSettings,
      setShowIpfsSettings,
      pinataJwt,
      kuboRpc,
      kuboGateway,
      updateIpfsSettings,
      pinataJwtInput,
      setPinataJwtInput,
      kuboRpcInput,
      setKuboRpcInput,
      kuboGatewayInput,
      setKuboGatewayInput,
      toast,
      showToast,
      clearToast,
      rpcOnline,
      wrongChain,
      configuredChainId: CONFIGURED_CHAIN_ID,
      configuredChainName: CONFIGURED_CHAIN_NAME,
      localAccountIndex,
      connectLocalAccount,
      connectWallet,
      disconnectWallet,
      claimFaucet,
      faucetEnabled,
      faucetVoucherRequired,
      showFaucetVoucherModal,
      setShowFaucetVoucherModal,
      refreshFaucetPolicy,
      burnTokens
    }),
    [
      userRole,
      donorTab,
      researcherTab,
      viewMode,
      account,
      genoBalance,
      refreshBalance,
      contracts,
      signer,
      provider,
      getContracts,
      getProviderAndSigner,
      researcherKeyPair,
      isPubKeyRegisteredOnChain,
      registerPublicKeyOnChain,
      refreshKeyVaultState,
      showIpfsSettings,
      pinataJwt,
      kuboRpc,
      kuboGateway,
      updateIpfsSettings,
      pinataJwtInput,
      kuboRpcInput,
      kuboGatewayInput,
      toast,
      showToast,
      clearToast,
      rpcOnline,
      wrongChain,
      localAccountIndex,
      connectLocalAccount,
      connectWallet,
      disconnectWallet,
      claimFaucet,
      faucetEnabled,
      faucetVoucherRequired,
      showFaucetVoucherModal,
      refreshFaucetPolicy,
      burnTokens
    ]
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (import.meta.env?.DEV) {
        window.__genoWeb3 = value;
      } else {
        delete window.__genoWeb3;
      }
    }
  }, [value]);

  return <Web3Context.Provider value={value}>{children}</Web3Context.Provider>;
}

export function useWeb3() {
  const context = useContext(Web3Context);
  if (!context) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
}