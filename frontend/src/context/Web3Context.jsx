import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import contractAddresses from "../contracts/contractAddresses.json";
import GenomicTokenABI from "../contracts/GenomicTokenABI.json";
import GenomicNFTABI from "../contracts/GenomicNFTABI.json";
import GenomicsRegistryABI from "../contracts/GenomicsRegistryABI.json";
import {
  generateAsymmetricKeyPair,
  savePersistentKeyPair,
  loadPersistentKeyPair,
  createWalletKeyBackup,
  restoreWalletKeyBackup,
  exportPublicKey,
} from "../../../crypto/client_crypto.js";
import {
  getPinataJwt,
  getKuboRpcEndpoint,
  setPinataJwt as setPinataJwtStorage,
  setKuboRpcEndpoint as setKuboRpcStorage
} from "../../../ipfs/pinata_uploader.js";

const Web3Context = createContext(null);

// Singleton static-network JsonRpcProvider for instant (<15ms) local Hardhat reads without eth_chainId round-trips
const LOCAL_STATIC_NETWORK = ethers.Network.from(31337);
const LOCAL_RPC_PROVIDER = new ethers.JsonRpcProvider("http://127.0.0.1:8545", LOCAL_STATIC_NETWORK, {
  staticNetwork: LOCAL_STATIC_NETWORK
});

export function Web3Provider({ children }) {
  // Top-Level Role Switcher: 'donor' (User Portal) | 'researcher' (Marketplace)
  const [userRole, setUserRole] = useState("researcher");

  // Sub-Navigation Tabs
  const [donorTab, setDonorTab] = useState("upload");
  const [researcherTab, setResearcherTab] = useState("catalog");
  const [viewMode, setViewMode] = useState("grid"); // 'grid' | 'table' (OpenSea/DeSci default)

  // Blockchain & Wallet State
  const [account, setAccount] = useState("");
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
  const [kuboRpc, setKuboRpcState] = useState(getKuboRpcEndpoint() || "http://127.0.0.1:5001");
  const [pinataJwtInput, setPinataJwtInput] = useState(getPinataJwt() || "");
  const [kuboRpcInput, setKuboRpcInput] = useState(getKuboRpcEndpoint() || "http://127.0.0.1:5001");

  const updateIpfsSettings = useCallback((jwt, rpc) => {
    setPinataJwtStorage(jwt);
    setKuboRpcStorage(rpc);
    setPinataJwtState(jwt);
    setKuboRpcState(rpc);
  }, []);

  // Toast Notification
  const [toast, setToast] = useState(null);
  const toastTimeoutRef = useRef(null);

  const showToast = useCallback((message, type = "success") => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setToast({ message, type });
    toastTimeoutRef.current = setTimeout(() => {
      setToast(null);
      toastTimeoutRef.current = null;
    }, 4000);
  }, []);

  // Provider & Signer Resolver (Instant 0ms Local Hardhat RPC read when wallet not connected)
  const getProviderAndSigner = useCallback(async () => {
    if (account && typeof window !== "undefined" && window.ethereum) {
      try {
        const [chainIdHex, accounts] = await Promise.all([
          window.ethereum.request({ method: "eth_chainId" }),
          window.ethereum.request({ method: "eth_accounts" })
        ]);
        const isLocalChain =
          chainIdHex === "0x7a69" ||
          chainIdHex === "0x539" ||
          Number(chainIdHex) === 31337;
        if (isLocalChain && accounts && accounts.length > 0) {
          const p = new ethers.BrowserProvider(window.ethereum);
          const s = await p.getSigner();
          return { provider: p, signer: s };
        }
      } catch {
        // Fallback directly to Local Hardhat RPC Node
      }
    }
    return { provider: LOCAL_RPC_PROVIDER, signer: null };
  }, [account]);

  // Contract Instances Resolver
  const getContracts = useCallback(async () => {
    const { provider: p, signer: s } = await getProviderAndSigner();
    const runner = s || p;
    if (!runner) return null;

    const token = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, runner);
    const nft = new ethers.Contract(contractAddresses.GenomicNFT, GenomicNFTABI, runner);
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, runner);

    const c = { token, nft, registry, signer: s, provider: p };
    setContracts(c);
    setSigner(s);
    setProvider(p);
    return c;
  }, [getProviderAndSigner]);

  // Keypair Initializer
  const initPersistentKey = useCallback(async (acc, contractsInstance) => {
    if (!acc) return;
    try {
      let kp = await loadPersistentKeyPair(acc);
      if (!kp) {
        kp = await generateAsymmetricKeyPair(false);
        await savePersistentKeyPair(acc, kp);
      }
      setResearcherKeyPair(kp);

      const activeContracts = contractsInstance || (await getContracts());
      if (activeContracts) {
        const onChainKey = await activeContracts.registry.researcherPublicKeys(acc);
        setIsPubKeyRegisteredOnChain(Boolean(onChainKey && onChainKey.length > 0));
      }
    } catch (err) {
      console.error("Key init error:", err);
    }
  }, [getContracts]);

  // Connect Wallet Action (MetaMask with automatic fallback to Local Hardhat RPC)
  const connectWallet = useCallback(async () => {
    const connectLocalHardhat = async () => {
      const jsonRpc = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
      const s = await jsonRpc.getSigner(1);
      const addr = await s.getAddress();
      setAccount(addr);
      const c = await getContracts();
      if (c) {
        const balWei = await c.token.balanceOf(addr);
        setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
      }
      await initPersistentKey(addr, c);
      showToast(`Wallet Connected (Hardhat Node): ${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`);
      return addr;
    };

    if (typeof window !== "undefined" && window.ethereum) {
      try {
        const chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
        const isLocalChain =
          chainIdHex === "0x7a69" ||
          chainIdHex === "0x539" ||
          Number(chainIdHex) === 31337;
        if (!isLocalChain) {
          return await connectLocalHardhat();
        }
        const p = new ethers.BrowserProvider(window.ethereum);
        const accounts = await p.send("eth_requestAccounts", []);
        if (accounts.length > 0) {
          const userAddr = accounts[0];
          setAccount(userAddr);
          const c = await getContracts();
          if (c) {
            const balWei = await c.token.balanceOf(userAddr);
            setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
          }
          await initPersistentKey(userAddr, c);
          showToast(`Wallet Connected: ${userAddr.substring(0, 6)}...${userAddr.substring(userAddr.length - 4)}`);
          return userAddr;
        }
      } catch {
        try {
          return await connectLocalHardhat();
        } catch (err2) {
          showToast("Connection failed: " + err2.message, "error");
        }
      }
    } else {
      try {
        return await connectLocalHardhat();
      } catch {
        showToast("Please install MetaMask or start local RPC node.", "error");
      }
    }
    return null;
  }, [getContracts, initPersistentKey, showToast]);

  // Disconnect Wallet Action
  const disconnectWallet = useCallback(() => {
    setAccount("");
    setGenoBalance(0);
    setResearcherKeyPair(null);
    setIsPubKeyRegisteredOnChain(false);
    showToast("Wallet disconnected.", "info");
  }, [showToast]);

  // Faucet Claim Action
  const claimFaucet = useCallback(async () => {
    let targetAccount = account;
    if (!targetAccount) {
      targetAccount = await connectWallet();
      if (!targetAccount) return;
    }
    try {
      const { signer: s } = await getProviderAndSigner();
      let activeSigner = s;
      if (!activeSigner) {
        const jsonRpc = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
        activeSigner = await jsonRpc.getSigner(targetAccount);
      }
      const tokenWithSigner = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, activeSigner);
      showToast("Requesting test tokens...", "info");
      const tx = await tokenWithSigner.faucet(targetAccount);
      await tx.wait();
      const balWei = await tokenWithSigner.balanceOf(targetAccount);
      setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
      showToast("Received 1,000 $GENO successfully!");
    } catch (err) {
      if (err.message && err.message.includes("FaucetCooldownActive")) {
        showToast("Faucet cooldown active. Please wait.", "error");
      } else {
        showToast("Faucet error: " + (err.shortMessage || err.message), "error");
      }
    }
  }, [account, connectWallet, getProviderAndSigner, showToast]);

  // Deflationary Token Burn Action
  const burnTokens = useCallback(async (amountGeno) => {
    if (!account) {
      showToast("Connect your wallet first.", "error");
      return;
    }
    try {
      const { signer: s } = await getProviderAndSigner();
      if (!s) throw new Error("Active signer required to burn tokens.");
      const tokenWithSigner = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, s);
      const burnWei = ethers.parseUnits(amountGeno.toString(), 18);
      showToast(`Burning ${amountGeno} $GENO...`, "info");
      const tx = await tokenWithSigner.burn(burnWei);
      await tx.wait();
      const balWei = await tokenWithSigner.balanceOf(account);
      setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
      showToast(`Successfully burned ${amountGeno} $GENO!`);
    } catch (err) {
      showToast("Burn error: " + (err.shortMessage || err.message), "error");
    }
  }, [account, getProviderAndSigner, showToast]);

  // Wallet Signature-Based Key Backup Action
  const backupKeypairToWallet = useCallback(async () => {
    if (!account || !researcherKeyPair) {
      showToast("Wallet not connected or keypair not ready.", "error");
      return null;
    }
    try {
      const { signer: s } = await getProviderAndSigner();
      if (!s) throw new Error("Wallet signer required for cryptographic identity backup.");
      showToast("Sign challenge in wallet to secure key backup...", "info");
      const backupJson = await createWalletKeyBackup(s, account, researcherKeyPair);
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(`GENO_WALLET_BACKUP_${account.toLowerCase()}`, backupJson);
      }
      showToast("Identity Key successfully backed up with Wallet Signature!");
      return backupJson;
    } catch (err) {
      showToast("Backup error: " + err.message, "error");
      return null;
    }
  }, [account, researcherKeyPair, getProviderAndSigner, showToast]);

  // Wallet Signature-Based Key Restore Action
  const restoreKeypairFromWallet = useCallback(async (backupJsonInput = null) => {
    if (!account) {
      showToast("Connect your wallet first.", "error");
      return null;
    }
    try {
      let backupData = backupJsonInput;
      if (!backupData && typeof window !== "undefined" && window.localStorage) {
        backupData = window.localStorage.getItem(`GENO_WALLET_BACKUP_${account.toLowerCase()}`);
      }
      if (!backupData) {
        throw new Error("No existing key backup found for this wallet address.");
      }
      const { signer: s } = await getProviderAndSigner();
      if (!s) throw new Error("Wallet signer required to restore cryptographic key.");
      showToast("Sign challenge in wallet to decrypt and restore key...", "info");
      const restoredKp = await restoreWalletKeyBackup(s, account, backupData);
      setResearcherKeyPair(restoredKp);
      showToast("Identity Key successfully restored from Wallet Signature!");
      return restoredKp;
    } catch (err) {
      showToast("Restore error: " + err.message, "error");
      return null;
    }
  }, [account, getProviderAndSigner, showToast]);

  // Refresh GENO Token Balance
  const refreshBalance = useCallback(async (targetAccount) => {
    const activeAccount = targetAccount || account;
    if (!activeAccount) return 0;
    try {
      const c = contracts || (await getContracts());
      if (c && c.token) {
        const balWei = await c.token.balanceOf(activeAccount);
        const balFmt = Number(ethers.formatUnits(balWei, 18));
        setGenoBalance(balFmt);
        return balFmt;
      }
    } catch (e) {
      console.warn("Refresh balance warning:", e);
    }
    return 0;
  }, [account, contracts, getContracts]);

  // Register Researcher Public Key on EVM (GenomicsRegistry)
  const registerPublicKeyOnChain = useCallback(async () => {
    if (!account || !researcherKeyPair) {
      showToast("Wallet or encryption keypair not initialized.", "error");
      return false;
    }
    try {
      const c = contracts || (await getContracts());
      if (!c || !c.registry) throw new Error("Registry contract unavailable");
      showToast("Registering encryption public key on EVM...", "info");
      const pubJwk = await exportPublicKey(researcherKeyPair.publicKey);
      const regTx = await c.registry.registerResearcherPublicKey(pubJwk);
      await regTx.wait();
      setIsPubKeyRegisteredOnChain(true);
      showToast("Public key registered on EVM successfully!");
      return true;
    } catch (err) {
      showToast("Public key registration failed: " + (err.reason || err.message), "error");
      return false;
    }
  }, [account, researcherKeyPair, contracts, getContracts, showToast]);

  // Initial load and MetaMask event listeners (accountsChanged, chainChanged)
  useEffect(() => {
    getContracts();

    if (typeof window === "undefined" || !window.ethereum) return;

    const handleAccountsChanged = async (accounts) => {
      if (!accounts || accounts.length === 0) {
        setAccount("");
        setGenoBalance(0);
        setResearcherKeyPair(null);
        setIsPubKeyRegisteredOnChain(false);
        showToast("Wallet disconnected.", "info");
      } else {
        const newAddr = accounts[0];
        setAccount(newAddr);
        const c = await getContracts();
        if (c && c.token) {
          try {
            const balWei = await c.token.balanceOf(newAddr);
            setGenoBalance(Number(ethers.formatUnits(balWei, 18)));
          } catch {}
        }
        await initPersistentKey(newAddr, c);
        showToast(`Account switched: ${newAddr.substring(0, 6)}...${newAddr.substring(newAddr.length - 4)}`);
      }
    };

    const handleChainChanged = () => {
      window.location.reload();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    // Auto-detect existing connected accounts only if already on Local Hardhat Chain 31337
    Promise.all([
      window.ethereum.request({ method: "eth_chainId" }),
      window.ethereum.request({ method: "eth_accounts" })
    ])
      .then(([chainIdHex, accs]) => {
        const isLocalChain =
          chainIdHex === "0x7a69" ||
          chainIdHex === "0x539" ||
          Number(chainIdHex) === 31337;
        if (isLocalChain && accs && accs.length > 0 && !account) {
          handleAccountsChanged(accs);
        }
      })
      .catch(() => {});

    return () => {
      if (window.ethereum?.removeListener) {
        window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
        window.ethereum.removeListener("chainChanged", handleChainChanged);
      }
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, [getContracts, initPersistentKey, showToast, account]);

  const value = {
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
    showIpfsSettings,
    setShowIpfsSettings,
    pinataJwt,
    kuboRpc,
    updateIpfsSettings,
    pinataJwtInput,
    setPinataJwtInput,
    kuboRpcInput,
    setKuboRpcInput,
    toast,
    showToast,
    connectWallet,
    disconnectWallet,
    claimFaucet,
    burnTokens,
    backupKeypairToWallet,
    restoreKeypairFromWallet
  };

  return <Web3Context.Provider value={value}>{children}</Web3Context.Provider>;
}

export function useWeb3() {
  const context = useContext(Web3Context);
  if (!context) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
}
