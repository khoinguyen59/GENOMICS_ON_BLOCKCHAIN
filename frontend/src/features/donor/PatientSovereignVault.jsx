import React, { useState, useRef, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import contractAddresses from "../../contracts/contractAddresses.json";
import GenomicZkVerifierABI from "../../contracts/GenomicZkVerifierABI.json";
import {
  DataOwnerShieldIcon,
  GenoTokenIcon,
  EditPencilIcon,
  CheckCircleIcon,
  CloseCrossIcon,
  SendPaperIcon,
  UserPlusIcon,
  DatabaseNodesIcon,
  WalletKeyIcon,
  SealedCipherIcon,
  CpuChipIcon,
  RefreshSpinIcon
} from "../../components/icons/GenoIcons";
import {
  exportSovereignVault,
  importSovereignVault,
  computeBlindTagHex,
  computeDonorWitnessCommitment,
  claimZkTraitBounty,
  releaseEscrow as releaseEscrowSvc,
  setDatasetDispatcherOptOut,
  queryFilterChunked,
  getDeploymentStartBlock
} from "../../services/datasetService";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { runWithConcurrency } from "../../utils/asyncResilience";

const getBlindTagsSessionKey = (addr) =>
  addr ? `genochain_blind_tags_session_v1_${String(addr).toLowerCase()}` : "";

function loadBlindTagsFromSession(addr) {
  const storageKey = getBlindTagsSessionKey(addr);
  if (!storageKey || typeof window === "undefined" || !window.sessionStorage) return {};
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sanitized = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && Array.isArray(v.entries)) {
        const cleanEntries = v.entries
          .filter((it) => it && typeof it.key === "string" && typeof it.value === "string")
          .map((it) => ({ key: it.key.trim(), value: it.value.trim() }))
          .filter((it) => it.key && it.value)
          .slice(0, 16);
        sanitized[k] = { entries: cleanEntries };
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function saveBlindTagsToSession(addr, mapObj) {
  const storageKey = getBlindTagsSessionKey(addr);
  if (!storageKey || typeof window === "undefined" || !window.sessionStorage) return;
  try {
    const toPersist = {};
    for (const [k, v] of Object.entries(mapObj || {})) {
      if (v && Array.isArray(v.entries)) {
        // Persist ONLY non-secret tag entries in sessionStorage (never write raw plaintext salt)
        toPersist[k] = {
          entries: v.entries
            .filter((it) => it && it.key && it.value)
            .map((it) => ({ key: String(it.key), value: String(it.value) }))
            .slice(0, 16)
        };
      }
    }
    window.sessionStorage.setItem(storageKey, JSON.stringify(toPersist));
  } catch {}
}

export default function PatientSovereignVault({
  onUpdateStatus,
  onUpdatePrice,
  onGrantDirectAccess,
  onDispatchCapsule,
  onAuthorizeWorker,
  onUpdateBlindTags,
  onReleaseEscrow
}) {
  const { account, signer, contracts, getProviderAndSigner, showToast, refreshBalance, refreshKeyVaultState } = useWeb3();
  const { datasets, getLocalizedTitle, fetchOnChainDatasets } = useDatasets();
  const { t, language } = useLanguage();
  const activeAccountRef = useRef(account);
  activeAccountRef.current = account;

  const [savedTagsByDataId, setSavedTagsByDataId] = useState(() => loadBlindTagsFromSession(account));
  useEffect(() => {
    setSavedTagsByDataId(loadBlindTagsFromSession(account));
    setTagsModalData(null);
    setGrantModalData(null);
    setDispatchModalData(null);
    setWorkerModalData(null);
    setEscrowModalData(null);
    // L-06: Immediately clear sensitive donor secrets/inputs on wallet switch or disconnect
    setZkWitnessSecret("");
    setExternalZkProofJson("");
    setUseExternalZkProof(false);
    setZkLabSignature("");
    setZkAttestationDeadline("");
    setZkDatasetRawHash("");
    setVaultPassphrase("");
    setShowPassphraseInput(false);
    setVaultFeedback(null);
  }, [account]);
  const [dispatcherDisabledMap, setDispatcherDisabledMap] = useState({});
  const [busyDispatcherId, setBusyDispatcherId] = useState(null);
  const dispatcherSeqRef = useRef(0);
  const escrowModalSeqRef = useRef(0);
  const zkBountySeqRef = useRef(0);

  const [editingPriceDataId, setEditingPriceDataId] = useState(null);
  const [newPriceInput, setNewPriceInput] = useState("");
  const [grantModalData, setGrantModalData] = useState(null);
  const [grantRecipient, setGrantRecipient] = useState("");
  const [dispatchModalData, setDispatchModalData] = useState(null);
  const [dispatchRecipient, setDispatchRecipient] = useState("");
  const [workerModalData, setWorkerModalData] = useState(null);
  const [workerAddressInput, setWorkerAddressInput] = useState("");
  const [tagsModalData, setTagsModalData] = useState(null);
  const [tagKeyInput, setTagKeyInput] = useState("gene");
  const [tagValInput, setTagValInput] = useState("ALDH2");
  const [tagSaltInput, setTagSaltInput] = useState("GENOCHAIN_COHORT_SALT_V1");
  const [tagEntries, setTagEntries] = useState([]);
  const [escrowModalData, setEscrowModalData] = useState(null);
  const [escrowModalNowSec, setEscrowModalNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [escrowBuyerInput, setEscrowBuyerInput] = useState("");
  const [detectedEscrows, setDetectedEscrows] = useState([]);
  const [loadingEscrows, setLoadingEscrows] = useState(false);
  const [busyEscrowRelease, setBusyEscrowRelease] = useState(false);

  useEffect(() => {
    if (!escrowModalData) return undefined;
    const timer = setInterval(() => {
      setEscrowModalNowSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [escrowModalData]);

  // ZK Trait Bounty Claim State (Data Provider)
  const [zkBounties, setZkBounties] = useState([]);
  const [zkWitnessSecret, setZkWitnessSecret] = useState("");
  const [useExternalZkProof, setUseExternalZkProof] = useState(false);
  const [externalZkProofJson, setExternalZkProofJson] = useState("");
  const [zkLabSignature, setZkLabSignature] = useState("");
  const [zkAttestationDeadline, setZkAttestationDeadline] = useState("");
  const [zkDatasetRawHash, setZkDatasetRawHash] = useState("");
  const [claimingBountyId, setClaimingBountyId] = useState(null);

  const loadDonorZkBounties = useCallback(async () => {
    const mySeq = ++zkBountySeqRef.current;
    try {
      const { provider: readProv } = await getProviderAndSigner();
      if (!readProv || zkBountySeqRef.current !== mySeq) return;
      const onChainZk = contracts?.registry ? await contracts.registry.zkVerifier().catch(() => ethers.ZeroAddress) : ethers.ZeroAddress;
      const targetZk = onChainZk && onChainZk !== ethers.ZeroAddress ? onChainZk : contractAddresses.GenomicZkVerifier;
      if (!targetZk || targetZk === ethers.ZeroAddress || zkBountySeqRef.current !== mySeq) return;
      const zk = new ethers.Contract(targetZk, GenomicZkVerifierABI, readProv);
      const count = Number(await zk.bountyCount());
      const latestBlock = await readProv.getBlock("latest").catch(() => null);
      const nowSec = latestBlock?.timestamp ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
      const bountyIds = Array.from({ length: count }, (_, idx) => idx + 1);
      const fetchedRows = await runWithConcurrency(
        bountyIds,
        async (i) => {
          try {
            const [b, requiredAttestor, claimed] = await Promise.all([
              zk.bounties(i),
              zk.bountyRequiredAttestor?.(i).catch(() => ethers.ZeroAddress),
              account ? zk.hasClaimedBounty(i, account).catch(() => false) : Promise.resolve(false)
            ]);
            const isAttested = Boolean(requiredAttestor && requiredAttestor !== ethers.ZeroAddress);
            return {
              bountyId: Number(b.bountyId),
              targetTraitId: b.targetTraitId,
              traitDescription: b.traitDescription,
              rewardPerClaim: Number(ethers.formatUnits(b.rewardPerClaim, 18)),
              maxClaims: Number(b.maxClaims),
              currentClaims: Number(b.currentClaims),
              remainingFunding: Number(ethers.formatUnits(b.remainingFunding, 18)),
              isActive: Boolean(b.isActive) && nowSec < Number(b.expiresAt) && Number(b.currentClaims) < Number(b.maxClaims),
              claimed: Boolean(claimed),
              requiredAttestor: isAttested ? requiredAttestor : null,
              isAttested
            };
          } catch {
            return null;
          }
        },
        6
      );
      if (zkBountySeqRef.current !== mySeq) return;
      setZkBounties(fetchedRows.filter(Boolean));
    } catch {}
  }, [account, contracts, getProviderAndSigner]);

  useEffect(() => {
    loadDonorZkBounties();
  }, [loadDonorZkBounties]);

  const handleClaimZkBounty = async (bounty) => {
    if (!account) {
      showToast(t("vaultErrConnectWallet"), "error");
      return;
    }
    const trimmedWitness = zkWitnessSecret.trim();
    const trimmedProofJson = externalZkProofJson.trim();
    if (useExternalZkProof && !trimmedProofJson) {
      showToast(t("zkExternalProofMissing"), "error");
      return;
    }
    if (!useExternalZkProof && !trimmedWitness) {
      showToast(t("zkWitnessRequired"), "error");
      return;
    }
    const trimmedLabSig = zkLabSignature.trim();
    const parsedDeadline = Number(zkAttestationDeadline.trim());
    if (bounty.isAttested) {
      if (!/^0x[0-9a-fA-F]{130}$/.test(trimmedLabSig) || !Number.isFinite(parsedDeadline) || parsedDeadline <= 0) {
        showToast(t("zkLabAttestationRequired"), "error");
        return;
      }
    }
    const claimAccount = account;
    try {
      setClaimingBountyId(bounty.bountyId);
      const provAndSigner = await getProviderAndSigner();
      const readProv = provAndSigner?.provider;
      if (bounty.isAttested && bounty.requiredAttestor && readProv) {
        const onChainZk = contracts?.registry ? await contracts.registry.zkVerifier().catch(() => ethers.ZeroAddress) : ethers.ZeroAddress;
        const targetZk = onChainZk && onChainZk !== ethers.ZeroAddress ? onChainZk : contractAddresses.GenomicZkVerifier;
        if (targetZk && targetZk !== ethers.ZeroAddress) {
          const zkRead = new ethers.Contract(targetZk, GenomicZkVerifierABI, readProv);
          const [strictLab, isApproved] = await Promise.all([
            zkRead.requireLabAttestation?.().catch(() => false),
            zkRead.approvedLabAttestors?.(bounty.requiredAttestor).catch(() => true)
          ]);
          if (strictLab && !isApproved) {
            showToast(t("zkLabAttestorRevokedErr"), "error");
            return;
          }
        }
      }
      const activeSigner = signer || provAndSigner?.signer;
      showToast(`${t("zkGeneratingProofToast")}${bounty.bountyId}...`, "info");
      await claimZkTraitBounty({
        bountyId: bounty.bountyId,
        targetTraitId: bounty.targetTraitId,
        witnessSecret: trimmedWitness,
        explicitProof: useExternalZkProof ? (trimmedProofJson || null) : null,
        rawDataHash: bounty.isAttested && zkDatasetRawHash ? zkDatasetRawHash : null,
        attestationDeadline: bounty.isAttested ? Math.floor(parsedDeadline) : null,
        labSignature: bounty.isAttested ? trimmedLabSig : null,
        account: claimAccount,
        signer: activeSigner
      });
      showToast(`${t("zkClaimSuccessPrefix")} +${bounty.rewardPerClaim} $GENO (#${bounty.bountyId}).`);
      // Only refresh balances/catalog for the claiming account if the user has not switched wallets mid-tx
      if (activeAccountRef.current && activeAccountRef.current.toLowerCase() === claimAccount.toLowerCase()) {
        await refreshBalance?.(claimAccount);
        await fetchOnChainDatasets?.(claimAccount);
      } else if (activeAccountRef.current) {
        await refreshBalance?.(activeAccountRef.current);
      }
      await loadDonorZkBounties();
    } catch (err) {
      const msg = err.shortMessage || err.message || "";
      showToast(`${t("zkClaimFailedPrefix")}${msg}`, "error");
    } finally {
      setClaimingBountyId(null);
    }
  };

  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultFeedback, setVaultFeedback] = useState(null);
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [showPassphraseInput, setShowPassphraseInput] = useState(false);
  const fileInputRef = useRef(null);

  const grantModalRef = useModalFocusTrap(Boolean(grantModalData), () => setGrantModalData(null));
  const dispatchModalRef = useModalFocusTrap(Boolean(dispatchModalData), () => setDispatchModalData(null));
  const workerModalRef = useModalFocusTrap(Boolean(workerModalData), () => setWorkerModalData(null));
  const tagsModalRef = useModalFocusTrap(Boolean(tagsModalData), () => setTagsModalData(null));
  const escrowModalRef = useModalFocusTrap(Boolean(escrowModalData), () => setEscrowModalData(null));

  const myDatasets = datasets.filter(
    (d) => account && d.owner.toLowerCase() === account.toLowerCase()
  );

  const myDatasetIdsKey = myDatasets.map((d) => d.dataId).join(",");

  useEffect(() => {
    const mySeq = ++dispatcherSeqRef.current;
    if (!contracts?.registry || typeof contracts.registry.dispatcherDisabled !== "function" || !myDatasetIdsKey) {
      setDispatcherDisabledMap({});
      return;
    }
    const ids = myDatasetIdsKey.split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
    (async () => {
      const entries = await runWithConcurrency(
        ids,
        async (id) => {
          try {
            const disabled = Boolean(await contracts.registry.dispatcherDisabled(id));
            return [id, disabled];
          } catch {
            return [id, false];
          }
        },
        6
      );
      if (dispatcherSeqRef.current !== mySeq) return;
      const nextMap = {};
      for (const [id, val] of entries) nextMap[id] = val;
      setDispatcherDisabledMap(nextMap);
    })();
  }, [contracts, myDatasetIdsKey]);

  const handleToggleDispatcherOptOut = async (dataId) => {
    try {
      setBusyDispatcherId(dataId);
      const activeSigner = signer || (await getProviderAndSigner?.())?.signer;
      if (!activeSigner) {
        showToast(t("vaultErrConnectWallet"), "error");
        return;
      }
      const nextDisabled = !Boolean(dispatcherDisabledMap[dataId]);
      await setDatasetDispatcherOptOut({
        dataId,
        disabled: nextDisabled,
        account,
        signer: activeSigner
      });
      setDispatcherDisabledMap((prev) => ({ ...prev, [dataId]: nextDisabled }));
      showToast(`${nextDisabled ? t("vaultDispatcherUpdatedOff") : t("vaultDispatcherUpdatedOn")}${dataId}`);
    } catch (err) {
      showToast((err.shortMessage || err.message), "error");
    } finally {
      setBusyDispatcherId(null);
    }
  };

  useEffect(() => {
    if (zkDatasetRawHash && !myDatasets.some((d) => d.rawDataHash === zkDatasetRawHash)) {
      setZkDatasetRawHash("");
    }
  }, [zkDatasetRawHash, myDatasets]);

  const handleStartEditPrice = (d) => {
    setEditingPriceDataId(d.dataId);
    setNewPriceInput(d.priceFormatted || d.price.toString());
  };

  const handleSavePrice = async (dataId) => {
    const trimmed = String(newPriceInput ?? "").trim();
    if (!/^\d+(\.\d{1,18})?$/.test(trimmed) || ethers.parseUnits(trimmed, 18) <= 0n) {
      showToast(t("vaultErrPositivePrice"), "error");
      return;
    }
    const ok = await onUpdatePrice?.(dataId, trimmed);
    if (ok) {
      setEditingPriceDataId(null);
    }
  };

  const handleExecuteGrant = async () => {
    const cleanRecipient = String(grantRecipient || "").trim();
    if (!ethers.isAddress(cleanRecipient)) {
      showToast(t("vaultErrInvalidAddress"), "error");
      return;
    }
    const ok = await onGrantDirectAccess?.(grantModalData.dataId, cleanRecipient);
    if (ok) {
      setGrantModalData(null);
      setGrantRecipient("");
    }
  };

  const handleExecuteDispatch = async () => {
    const cleanRecipient = String(dispatchRecipient || "").trim();
    if (!ethers.isAddress(cleanRecipient)) {
      showToast(t("vaultErrInvalidAddress"), "error");
      return;
    }
    const ok = await onDispatchCapsule?.({
      dataId: dispatchModalData.dataId,
      recipientAddress: cleanRecipient,
      rawCid: dispatchModalData.rawCid
    });
    if (ok) {
      setDispatchModalData(null);
      setDispatchRecipient("");
    }
  };

  const handleExportVault = async () => {
    if (!account) {
      showToast(t("vaultErrConnectWallet"), "error");
      return;
    }
    const cleanPass = vaultPassphrase.trim() || null;
    if (cleanPass && cleanPass.length < 8) {
      const errMsg = t("vaultPassphraseTooShort");
      setVaultFeedback({ type: "error", msg: errMsg });
      showToast(errMsg, "error");
      return;
    }
    setVaultLoading(true);
    setVaultFeedback(null);
    try {
      const activeSigner = cleanPass ? null : (signer || (await getProviderAndSigner?.())?.signer);
      const backupJson = await exportSovereignVault({
        signer: activeSigner,
        account,
        password: cleanPass,
        contracts,
        datasets
      });

      const blob = new Blob([backupJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const shortAddr = account.slice(0, 8);
      link.href = url;
      link.download = `genochain-sovereign-vault-${shortAddr}-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      const parsed = JSON.parse(backupJson);
      const successMsg = `${t("vaultExportSuccessPrefix")} (${parsed.capsuleCount || 0} ${t("vaultExportCapsulesSuffix")}).`;
      setVaultFeedback({ type: "success", msg: successMsg });
      showToast?.(successMsg, "success");
    } catch (err) {
      console.error("Vault export error:", err);
      setVaultFeedback({ type: "error", msg: err.message || t("vaultExportError") });
    } finally {
      setVaultLoading(false);
    }
  };

  const handleImportVaultFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setVaultLoading(true);
    setVaultFeedback(null);
    try {
      const text = await file.text();
      const activeSigner = signer || (await getProviderAndSigner?.())?.signer;
      const res = await importSovereignVault({
        signer: activeSigner,
        account,
        backupData: text,
        password: vaultPassphrase.trim() || null
      });

      await refreshKeyVaultState?.();

      const successMsg = `${t("vaultImportSuccessPrefix")} (${res.restoredCount} ${t("vaultImportRestoredSuffix")})`;
      if (res?.keyRotated) {
        const rotatedWarn = t("vaultImportRotatedWarning");
        setVaultFeedback({ type: "success", msg: `${successMsg} ${rotatedWarn}` });
        showToast?.(rotatedWarn, "warning");
      } else {
        setVaultFeedback({ type: "success", msg: successMsg });
        showToast?.(successMsg, "success");
      }
    } catch (err) {
      console.error("Vault import error:", err);
      setVaultFeedback({ type: "error", msg: err.message || t("vaultImportError") });
    } finally {
      setVaultLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div>
      {/* Sovereign Decryption Key Vault & Cold Backup Bar */}
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          padding: "16px 20px",
          marginBottom: "18px",
          display: "flex",
          flexDirection: "column",
          gap: "12px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <DatabaseNodesIcon size={20} color="#10b981" />
            <div>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>{t("vaultIndexedDbTitle")}</span>
                <span
                  className="status-badge-chip badge-active"
                  style={{
                    fontSize: "10px",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600
                  }}
                >
                  {String(t("vaultActivePersistence")).replace(/^[●•]\s*/, "")}
                </span>
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                {t("vaultIndexedDbSub")}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="file"
              ref={fileInputRef}
              accept=".json"
              aria-label="Import Sovereign Vault JSON"
              id="vault-file-import"
              style={{ display: "none" }}
              onChange={handleImportVaultFile}
            />
            <button
              className="btn-terminal btn-terminal-ghost"
              onClick={() => setShowPassphraseInput((prev) => !prev)}
              style={{ fontSize: "11px", height: "30px", padding: "0 10px" }}
              type="button"
            >
              <WalletKeyIcon size={12} color="#94a3b8" />
              <span>{showPassphraseInput ? t("vaultHidePassphrase") : t("vaultSetPassphrase")}</span>
            </button>
            <button
              className="btn-terminal btn-terminal-primary"
              onClick={handleExportVault}
              disabled={vaultLoading || !account}
              style={{ fontSize: "11px", height: "30px", padding: "0 12px" }}
              type="button"
            >
              <SealedCipherIcon size={12} />
              <span>{vaultLoading ? t("vaultSecuring") : t("vaultExportJson")}</span>
            </button>
            <button
              className="btn-terminal btn-terminal-success"
              onClick={() => fileInputRef.current?.click()}
              disabled={vaultLoading || !account}
              style={{ fontSize: "11px", height: "30px", padding: "0 12px" }}
              type="button"
            >
              <CheckCircleIcon size={12} color="#10b981" />
              <span>{vaultLoading ? t("vaultRestoring") : t("vaultImportJson")}</span>
            </button>
          </div>
        </div>

        {showPassphraseInput && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", background: "var(--bg-input)", padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)" }}>
            <label
              htmlFor="vault-passphrase-input"
              style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}
            >
              {t("vaultPassphrasePrompt")}
            </label>
            <input
              id="vault-passphrase-input"
              type="password"
              placeholder={t("vaultPassphrasePlaceholder")}
              value={vaultPassphrase}
              onChange={(e) => setVaultPassphrase(e.target.value)}
              style={{
                flex: 1,
                padding: "4px 8px",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-strong)",
                color: "var(--text-primary)",
                fontSize: "11px",
                fontFamily: "var(--font-mono)",
                borderRadius: "4px"
              }}
            />
          </div>
        )}

        {vaultFeedback && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              fontSize: "11.5px",
              fontFamily: "var(--font-mono)",
              background: vaultFeedback.type === "success" ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
              color: vaultFeedback.type === "success" ? "var(--accent-emerald-text)" : "var(--accent-rose-text)",
              border: `1px solid ${vaultFeedback.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`
            }}
          >
            {vaultFeedback.msg}
          </div>
        )}
      </div>

      {/* ZK Trait Bounty Claim Panel for Data Providers */}
      <div
        id="donor-zk-bounty-panel"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          padding: "14px 20px",
          marginBottom: "18px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <CpuChipIcon size={18} color="#10b981" />
            <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
              {t("zkPanelTitle")} ({zkBounties.length})
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <input
              id="donor-zk-witness-input"
              type="password"
              autoComplete="off"
              className="field-input"
              style={{ width: "220px", height: "30px", fontSize: "11px", fontFamily: "var(--font-mono)" }}
              placeholder={t("zkWitnessPlaceholder")}
              aria-label={t("zkWitnessPlaceholder")}
              value={zkWitnessSecret}
              onChange={(e) => setZkWitnessSecret(e.target.value)}
            />
            <button
              id="donor-zk-external-toggle"
              type="button"
              className={`btn-terminal ${useExternalZkProof ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
              style={{ height: "30px", fontSize: "11px", padding: "0 10px" }}
              onClick={() => setUseExternalZkProof((prev) => !prev)}
            >
              <span>{t("zkExternalProofToggle")}</span>
            </button>
            <button
              id="donor-refresh-bounties-btn"
              type="button"
              className="btn-terminal btn-terminal-ghost"
              style={{ height: "30px", fontSize: "11px", padding: "0 10px" }}
              title={t("adminRefreshTelemetry")}
              onClick={loadDonorZkBounties}
            >
              <RefreshSpinIcon size={12} />
              <span>{t("adminRefreshTelemetry")}</span>
            </button>
          </div>
        </div>
        <div
          style={{
            marginBottom: "10px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-input)"
          }}
        >
          <label
            htmlFor="donor-zk-dataset-select"
            className="field-label"
            style={{ fontSize: "11px", marginBottom: 0, whiteSpace: "nowrap" }}
          >
            {t("zkDatasetSelectLabel")}
          </label>
          <select
            id="donor-zk-dataset-select"
            className="field-select"
            style={{ flex: "1 1 260px", height: "30px", fontSize: "11px", fontFamily: "var(--font-mono)" }}
            aria-label={t("zkDatasetSelectLabel")}
            value={zkDatasetRawHash}
            onChange={(e) => setZkDatasetRawHash(e.target.value)}
          >
            <option value="">{t("zkDatasetSelectNone")}</option>
            {myDatasets
              .filter((d) => d.rawDataHash && /^0x[0-9a-fA-F]{64}$/.test(d.rawDataHash))
              .map((d) => (
                <option key={d.dataId} value={d.rawDataHash}>
                  #{d.dataId} {d.geneSymbol || d.gene} ({d.rawDataHash.slice(0, 12)}...{d.rawDataHash.slice(-6)})
                </option>
              ))}
          </select>
        </div>
        {useExternalZkProof && (
          <div style={{ marginBottom: "10px", padding: "10px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", background: "var(--bg-input)" }}>
            <label htmlFor="donor-zk-proof-json-input" className="field-label" style={{ fontSize: "11px", marginBottom: "6px", display: "block" }}>
              {t("zkExternalProofToggle")}
            </label>
            <textarea
              id="donor-zk-proof-json-input"
              rows={4}
              className="field-input"
              style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: "11px", padding: "8px", resize: "vertical" }}
              placeholder={t("zkExternalProofPlaceholder")}
              aria-label={t("zkExternalProofToggle")}
              value={externalZkProofJson}
              onChange={(e) => setExternalZkProofJson(e.target.value)}
            />
            <div style={{ fontSize: "10.5px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: "4px" }}>
              {t("zkExternalProofHint")}
            </div>
          </div>
        )}
        {zkBounties.some((b) => b.isAttested) && (
          <div style={{ marginBottom: "10px", padding: "10px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", background: "var(--bg-input)", display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 260px" }}>
              <label htmlFor="donor-zk-lab-sig-input" className="field-label" style={{ fontSize: "11px", marginBottom: "4px", display: "block" }}>
                {t("zkLabSignatureLabel")}
              </label>
              <input
                id="donor-zk-lab-sig-input"
                type="text"
                className="field-input"
                style={{ width: "100%", height: "30px", fontSize: "11px", fontFamily: "var(--font-mono)" }}
                placeholder={t("zkLabSignaturePlaceholder")}
                aria-label={t("zkLabSignatureLabel")}
                value={zkLabSignature}
                onChange={(e) => setZkLabSignature(e.target.value)}
              />
            </div>
            <div style={{ flex: "0 1 190px" }}>
              <label htmlFor="donor-zk-lab-deadline-input" className="field-label" style={{ fontSize: "11px", marginBottom: "4px", display: "block" }}>
                {t("zkLabDeadlineLabel")}
              </label>
              <input
                id="donor-zk-lab-deadline-input"
                type="number"
                className="field-input"
                style={{ width: "100%", height: "30px", fontSize: "11px", fontFamily: "var(--font-mono)" }}
                placeholder="1795000000"
                aria-label={t("zkLabDeadlineLabel")}
                value={zkAttestationDeadline}
                onChange={(e) => setZkAttestationDeadline(e.target.value)}
              />
            </div>
            {account && zkWitnessSecret.trim() && (
              <div
                id="donor-zk-commitment-preview"
                style={{
                  flex: "1 1 100%",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  paddingTop: "6px",
                  borderTop: "1px dashed var(--border-subtle)"
                }}
              >
                <div style={{ fontSize: "10.5px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  {t("zkCommitmentPreviewLabel")}
                </div>
                {zkBounties
                  .filter((b) => b.isAttested)
                  .map((b) => {
                    const commHex = computeDonorWitnessCommitment(account, b.targetTraitId, zkWitnessSecret.trim());
                    return (
                      <div
                        key={`comm-${b.bountyId}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          padding: "4px 8px",
                          borderRadius: "4px",
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border-subtle)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "11px"
                        }}
                      >
                        <span
                          id={`donor-zk-commitment-val-${b.bountyId}`}
                          style={{ color: "var(--accent-cyan-light)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={commHex}
                        >
                          #{b.bountyId}: {commHex}
                        </span>
                        <button
                          id={`btn-copy-zk-commitment-${b.bountyId}`}
                          type="button"
                          className="btn-terminal btn-terminal-ghost"
                          style={{ height: "24px", fontSize: "10.5px", padding: "0 8px", flexShrink: 0 }}
                          onClick={() => {
                            if (navigator.clipboard?.writeText) {
                              Promise.resolve(navigator.clipboard.writeText(commHex))
                                .then(() => showToast(t("copiedToast")))
                                .catch(() => {});
                            }
                          }}
                        >
                          {t("zkCopyCommitmentBtn")}
                        </button>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}
        {zkBounties.length === 0 ? (
          <div style={{ fontSize: "11.5px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
            {t("zkNoBountiesOpen")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {zkBounties.map((b) => (
              <div
                key={b.bountyId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "10px",
                  padding: "8px 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-subtle)",
                  background: "var(--bg-input)"
                }}
              >
                <div style={{ fontSize: "12px" }}>
                  <div style={{ fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    <span>#{b.bountyId} {b.traitDescription}</span>
                    {b.isAttested && (
                      <span
                        className="status-badge-chip badge-active"
                        style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "12px", fontFamily: "var(--font-mono)", fontWeight: 600 }}
                      >
                        {t("zkAttestedBadge")}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
                    +{b.rewardPerClaim} $GENO | {b.currentClaims}/{b.maxClaims} {t("adminClaimsUnit")} | TraitHash: {b.targetTraitId.slice(0, 12)}...
                    {b.isAttested && b.requiredAttestor
                      ? ` | ${t("zkAttestorPrefix")} ${b.requiredAttestor.slice(0, 8)}...${b.requiredAttestor.slice(-4)}`
                      : ""}
                  </div>
                </div>
                <button
                  id={`btn-claim-zk-bounty-${b.bountyId}`}
                  type="button"
                  className={`btn-terminal ${b.claimed ? "btn-terminal-ghost" : "btn-terminal-success"}`}
                  style={{ height: "30px", fontSize: "11.5px", padding: "0 12px" }}
                  disabled={!b.isActive || b.claimed || claimingBountyId === b.bountyId}
                  onClick={() => handleClaimZkBounty(b)}
                >
                  <CheckCircleIcon size={12} color="#10b981" />
                  <span>
                    {b.claimed
                      ? t("zkBountyClaimedBtn")
                      : claimingBountyId === b.bountyId
                      ? "..."
                      : `${t("zkProveAndClaimPrefix")} +${b.rewardPerClaim} $GENO`}
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="vault-section-title">
        <DataOwnerShieldIcon size={18} color="#38bdf8" />
        <span style={{ fontSize: "14px", fontWeight: 700 }}>{t("vaultTitle")}</span>
      </div>

      <div
        className="terminal-table-container"
        tabIndex="0"
        role="region"
        aria-label={t("vaultTitle") || "Patient sovereign vault table"}
      >
        <table className="terminal-table">
          <thead>
            <tr>
              <th className="col-id">{t("vaultColId")}</th>
              <th>{t("vaultColTarget")}</th>
              <th>{t("vaultColAncestryRegion")}</th>
              <th>{t("vaultColPrice")}</th>
              <th>{t("vaultColAccessRoyalty")}</th>
              <th>{t("vaultColStatus")}</th>
              <th style={{ textAlign: "right", paddingRight: "18px" }}>{t("vaultColControls")}</th>
            </tr>
          </thead>
          <tbody>
            {myDatasets.map((d) => (
              <tr key={d.dataId}>
                <td className="col-id">#{d.tokenId}</td>
                <td>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                    {getLocalizedTitle ? getLocalizedTitle(d, language) : d.disease}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--accent-cyan-light)" }}>
                    {d.gene}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "10.5px", color: "var(--text-muted)", marginTop: "2px" }}>
                    {d.artifactHashCount || 1}/3 {t("licensedArtifactHashes")} • {d.blindTagCount || 0} {t("vaultTagsSummary")} • {t("licensedReusesLabel")} {d.reuseCount || 0}
                  </div>
                </td>
                <td>
                  <div>
                    <span className="chrom-chip" style={{ fontSize: "11px", padding: "2px 6px" }}>
                      {d.format || "VCF v4.2"}
                    </span>
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)", marginLeft: "6px" }}>
                      {d.ancestry || d.region || "Global"}
                    </span>
                  </div>
                </td>
                <td>
                  {editingPriceDataId === d.dataId ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={newPriceInput}
                        placeholder="GENO"
                        aria-label={t("tableColPrice")}
                        onChange={(e) => setNewPriceInput(e.target.value)}
                        style={{
                          width: "70px",
                          padding: "2px 6px",
                          background: "var(--bg-input)",
                          border: "1px solid var(--border-strong)",
                          color: "var(--text-primary)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "12px",
                          borderRadius: "4px"
                        }}
                      />
                      <button
                        type="button"
                        className="btn-terminal btn-terminal-success"
                        style={{ padding: "2px 6px", minWidth: "24px", minHeight: "24px", height: "24px" }}
                        onClick={() => handleSavePrice(d.dataId)}
                        title={t("confirm")}
                      >
                        <CheckCircleIcon size={12} color="#10b981" />
                      </button>
                      <button
                        type="button"
                        className="btn-terminal btn-terminal-ghost"
                        style={{ padding: "2px 6px", minWidth: "24px", minHeight: "24px", height: "24px" }}
                        onClick={() => setEditingPriceDataId(null)}
                        title={t("cancel")}
                      >
                        <CloseCrossIcon size={11} color="#94a3b8" />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text-primary)" }}>{d.price} $GENO</span>
                      {d.status === "Active" && (
                        <button
                          type="button"
                          className="btn-terminal btn-terminal-ghost"
                          style={{ padding: "2px 4px", minWidth: "24px", minHeight: "24px", height: "24px" }}
                          onClick={() => handleStartEditPrice(d)}
                          title={t("btnEditPrice")}
                        >
                          <EditPencilIcon size={11} color="var(--accent-cyan)" />
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-primary)" }}>
                    {d.accessCount} {t("purchasesCount")}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--accent-amber-text)" }}>
                    +{d.accumulatedRoyalty.toFixed(1)} {t("earnedRoyalty")} ({Number(((d.royaltyBps ?? 1000) / 100).toFixed(2))}%)
                  </div>
                </td>
                <td>
                  <span
                    className={`status-badge-chip ${
                      d.status === "Active"
                        ? "badge-active"
                        : d.status === "Paused"
                        ? "badge-paused"
                        : "badge-revoked"
                    }`}
                  >
                    {d.status === "Active" ? t("statusActive") : d.status === "Paused" ? t("statusPaused") : t("statusRevoked")}
                  </span>
                </td>
                <td style={{ textAlign: "right", paddingRight: "18px" }}>
                  <div className="action-cell-btns" style={{ justifyContent: "flex-end", gap: "6px", flexWrap: "wrap", maxWidth: "380px", marginLeft: "auto" }}>
                    {d.status === "Active" && (
                      <>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => setGrantModalData(d)}
                          title={t("btnGrantAccess")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnGrantAccess")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => setDispatchModalData(d)}
                          title={t("btnDispatchCapsule")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnDispatchCapsule")}</span>
                        </button>
                        <button
                          id={`btn-vault-tags-${d.dataId}`}
                          type="button"
                          className="btn-terminal btn-terminal-ghost"
                          title={t("modalBlindTagsTitle")}
                          style={{ fontSize: "12px", height: "30px" }}
                          onClick={() => {
                            setTagsModalData(d);
                            const persisted = savedTagsByDataId[d.dataId] || null;
                            if (persisted && Array.isArray(persisted.entries)) {
                              setTagEntries(persisted.entries);
                              setTagSaltInput(persisted.salt || "GENOCHAIN_COHORT_SALT_V1");
                            } else {
                              const baseEntries = [
                                { key: "gene", value: String(d.geneSymbol || d.gene || "ALDH2").split(/[\s(/,:]/)[0] },
                                { key: "disease", value: String(d.disease || "") },
                                { key: "trait", value: String(d.disease || d.traitEn || "") },
                                ...(d.clinicalSignificance ? [{ key: "trait", value: String(d.clinicalSignificance) }] : []),
                                { key: "hpo", value: String(d.hpoTerm || "").split(/\s/)[0] },
                                { key: "ancestry", value: String(d.ancestry || d.region || "") },
                                { key: "rsid", value: String(d.rsId && d.rsId !== "N/A" ? d.rsId : "") }
                              ].filter((it) => it.value && it.value.trim().length > 0);
                              setTagEntries(baseEntries);
                              setTagSaltInput("GENOCHAIN_COHORT_SALT_V1");
                            }
                            setTagKeyInput("gene");
                            setTagValInput("");
                          }}
                        >
                          <span>{t("vaultBtnTags")}</span>
                        </button>
                        <button
                          id={`btn-vault-worker-${d.dataId}`}
                          type="button"
                          className="btn-terminal btn-terminal-ghost"
                          title={t("workerAuthLabel")}
                          style={{ fontSize: "12px", height: "30px" }}
                          onClick={() => setWorkerModalData(d)}
                        >
                          <span>{t("vaultBtnWorker")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => onUpdateStatus?.(d.dataId, 1)}
                          title={t("btnPause")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnPause")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-danger"
                          onClick={() => onUpdateStatus?.(d.dataId, 2)}
                          title={t("btnRevoke")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnRevoke")}</span>
                        </button>
                      </>
                    )}
                    {d.status !== "Revoked" && (
                      <button
                        id={`btn-vault-dispatcher-${d.dataId}`}
                        type="button"
                        className={`btn-terminal ${dispatcherDisabledMap[d.dataId] ? "btn-terminal-danger" : "btn-terminal-ghost"}`}
                        disabled={busyDispatcherId === d.dataId}
                        title={t("vaultDispatcherToggleTitle")}
                        style={{ fontSize: "12px", height: "30px" }}
                        data-dispatcher-disabled={dispatcherDisabledMap[d.dataId] ? "true" : "false"}
                        onClick={() => handleToggleDispatcherOptOut(d.dataId)}
                      >
                        <span>{dispatcherDisabledMap[d.dataId] ? t("vaultDispatcherOff") : t("vaultDispatcherOn")}</span>
                      </button>
                    )}
                    <button
                      id={`btn-vault-escrow-${d.dataId}`}
                      type="button"
                      className="btn-terminal btn-terminal-ghost"
                      title={t("btnReleaseEscrow")}
                      style={{ fontSize: "12px", height: "30px" }}
                      onClick={async () => {
                        const myModalSeq = ++escrowModalSeqRef.current;
                        setEscrowModalData(d);
                        setDetectedEscrows([]);
                        setEscrowBuyerInput("");
                        setLoadingEscrows(true);
                        try {
                          if (contracts?.registry) {
                            const evs = await queryFilterChunked(
                              contracts.registry,
                              contracts.registry.filters.EscrowDeposited(d.dataId),
                              getDeploymentStartBlock(),
                              "latest"
                            );
                            if (escrowModalSeqRef.current !== myModalSeq) return;
                            const rpcProvider =
                              contracts.provider ||
                              contracts.registry.runner?.provider ||
                              contracts.registry.runner;
                            const latestBlock =
                              typeof rpcProvider?.getBlock === "function"
                                ? await rpcProvider.getBlock("latest").catch(() => null)
                                : null;
                            if (escrowModalSeqRef.current !== myModalSeq) return;
                            const modalChainNowSec = latestBlock?.timestamp ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
                            setEscrowModalNowSec(modalChainNowSec);
                            const seen = new Set();
                            const uniqueBuyers = [];
                            for (const ev of evs) {
                              const bAddr = ev.args?.buyer;
                              if (!bAddr || seen.has(bAddr.toLowerCase())) continue;
                              seen.add(bAddr.toLowerCase());
                              uniqueBuyers.push(bAddr);
                            }
                            const checked = await runWithConcurrency(
                              uniqueBuyers,
                              async (bAddr) => {
                                if (escrowModalSeqRef.current !== myModalSeq) return null;
                                const dep = await contracts.registry.escrowDeposits(d.dataId, bAddr);
                                if (escrowModalSeqRef.current !== myModalSeq) return null;
                                if (dep && dep.amount > 0n && !dep.released && !dep.refunded) {
                                  const [disp, isManual, rawLockDeadline] = await Promise.all([
                                    contracts.registry.escrowDisputed(d.dataId, bAddr).catch(() => false),
                                    contracts.registry.manualEscrowRelease?.(d.dataId, bAddr).catch(() => false),
                                    contracts.registry.getEscrowLockDeadline?.(d.dataId, bAddr).catch(() => null)
                                  ]);
                                  if (escrowModalSeqRef.current !== myModalSeq) return null;
                                  const fallbackDeadline = Number(dep.depositTime) + Number(dep.disputeWindow) + (isManual ? 7 * 86400 : 0);
                                  const resolvedDeadline =
                                    rawLockDeadline !== null && rawLockDeadline !== undefined && BigInt(rawLockDeadline) > 0n
                                      ? Number(rawLockDeadline)
                                      : fallbackDeadline;
                                  const delivered = Boolean(dep.capsuleDelivered);
                                  const disputed = Boolean(disp);
                                  return {
                                    buyer: bAddr,
                                    delivered,
                                    disputed,
                                    manualExtension: Boolean(isManual),
                                    deadline: resolvedDeadline
                                  };
                                }
                                return null;
                              },
                              6
                            );
                            const found = checked.filter(Boolean);
                            if (escrowModalSeqRef.current !== myModalSeq) return;
                            setDetectedEscrows(found);
                            if (found.length > 0) setEscrowBuyerInput(found[0].buyer);
                          }
                        } catch {} finally {
                          if (escrowModalSeqRef.current === myModalSeq) {
                            setLoadingEscrows(false);
                          }
                        }
                      }}
                    >
                      <span>{t("vaultBtnEscrow")}</span>
                    </button>
                    {d.status === "Paused" && (
                      <>
                        <button
                          className="btn-terminal btn-terminal-success"
                          onClick={() => onUpdateStatus?.(d.dataId, 0)}
                          title={t("btnResume")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnResume")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-danger"
                          onClick={() => onUpdateStatus?.(d.dataId, 2)}
                          title={t("btnRevoke")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnRevoke")}</span>
                        </button>
                      </>
                    )}
                    {d.status === "Revoked" && (
                      <span style={{ fontSize: "12px", color: "var(--text-disabled)", fontStyle: "italic" }}>
                        {t("statusRevoked")}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {myDatasets.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    textAlign: "center",
                    padding: "48px 20px",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)"
                  }}
                >
                  {t("vaultEmptyMsg")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal: Grant Direct Access */}
      {grantModalData && (
        <div className="terminal-modal-backdrop" onClick={() => setGrantModalData(null)}>
          <div
            ref={grantModalRef}
            tabIndex={-1}
            className="terminal-modal-window"
            role="dialog"
            aria-modal="true"
            aria-label={`${t("modalGrantTitle")}${grantModalData.dataId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <UserPlusIcon size={16} color="var(--accent-emerald)" />
                <span>{t("modalGrantTitle")}{grantModalData.dataId}</span>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setGrantModalData(null)} title={t("close")} aria-label={t("close")}>
                <CloseCrossIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                {t("modalGrantDesc")}
              </p>
              <div className="spec-box">
                <div className="spec-box-label">{t("modalTargetDataset")}</div>
                <div className="spec-box-val" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {grantModalData.disease} ({grantModalData.gene})
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="input-grant-recipient">
                  {t("modalRecipientLabel")}
                </label>
                <input
                  id="input-grant-recipient"
                  type="text"
                  className="field-input"
                  placeholder="0x0000000000000000000000000000000000000000"
                  value={grantRecipient}
                  onChange={(e) => setGrantRecipient(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button type="button" className="btn-terminal btn-terminal-ghost" onClick={() => setGrantModalData(null)}>
                {t("cancel")}
              </button>
              <button type="button" className="btn-terminal btn-terminal-success" onClick={handleExecuteGrant}>
                <CheckCircleIcon size={12} color="var(--accent-emerald)" />
                <span>{t("btnGrantDirectEvm")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Dispatch RSA-OAEP Capsule */}
      {dispatchModalData && (
        <div className="terminal-modal-backdrop" onClick={() => setDispatchModalData(null)}>
          <div
            ref={dispatchModalRef}
            tabIndex={-1}
            className="terminal-modal-window"
            role="dialog"
            aria-modal="true"
            aria-label={`${t("modalDispatchTitle")}${dispatchModalData.dataId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <SendPaperIcon size={16} color="var(--accent-cyan)" />
                <span>{t("modalDispatchTitle")}{dispatchModalData.dataId}</span>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setDispatchModalData(null)} title={t("close")} aria-label={t("close")}>
                <CloseCrossIcon size={16} color="var(--text-muted)" />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                {t("modalDispatchDesc")}
              </p>
              <div className="spec-box">
                <div className="spec-box-label">{t("modalTargetDataset")}</div>
                <div className="spec-box-val" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {dispatchModalData.disease} ({dispatchModalData.gene})
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="input-dispatch-recipient">
                  {t("modalBuyerLabel")}
                </label>
                <input
                  id="input-dispatch-recipient"
                  type="text"
                  className="field-input"
                  placeholder="0x0000000000000000000000000000000000000000"
                  value={dispatchRecipient}
                  onChange={(e) => setDispatchRecipient(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button type="button" className="btn-terminal btn-terminal-ghost" onClick={() => setDispatchModalData(null)}>
                {t("cancel")}
              </button>
              <button type="button" className="btn-terminal btn-terminal-primary" onClick={handleExecuteDispatch}>
                <SendPaperIcon size={12} />
                <span>{t("btnPackageCapsuleEvm")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Authorize / Revoke Delegated Capsule Worker */}
      {workerModalData && (
        <div className="terminal-modal-backdrop" onClick={() => setWorkerModalData(null)}>
          <div
            ref={workerModalRef}
            tabIndex={-1}
            className="terminal-modal-window"
            role="dialog"
            aria-modal="true"
            aria-label={`${t("workerAuthLabel")} #${workerModalData.dataId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <WalletKeyIcon size={16} color="#a855f7" />
                <span>{t("workerAuthLabel")} #{workerModalData.dataId}</span>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                title={t("close")}
                aria-label={t("close")}
                onClick={() => setWorkerModalData(null)}
              >
                <CloseCrossIcon size={16} color="var(--text-muted)" />
              </button>
            </div>
            <div className="modal-body">
              <label htmlFor="input-vault-worker-addr" className="field-label">
                {t("modalWorkerAddrLabel")}
              </label>
              <input
                id="input-vault-worker-addr"
                type="text"
                className="field-input"
                placeholder="0x0000000000000000000000000000000000000000"
                aria-label={t("modalWorkerAddrLabel")}
                value={workerAddressInput}
                onChange={(e) => setWorkerAddressInput(e.target.value)}
              />
            </div>
            <div className="modal-footer-bar">
              <button
                id="btn-confirm-worker-revoke"
                type="button"
                className="btn-terminal btn-terminal-ghost"
                title={t("workerRevokeBtn")}
                onClick={async () => {
                  const cleanWorker = String(workerAddressInput || "").trim();
                  if (!ethers.isAddress(cleanWorker)) {
                    showToast(t("vaultErrInvalidAddress"), "error");
                    return;
                  }
                  const ok = await onAuthorizeWorker?.(workerModalData.dataId, cleanWorker, false);
                  if (ok) setWorkerModalData(null);
                }}
              >
                <span>{t("workerRevokeBtn")}</span>
              </button>
              <button
                id="btn-confirm-worker-auth"
                type="button"
                className="btn-terminal btn-terminal-primary"
                title={t("workerAuthBtn")}
                onClick={async () => {
                  const cleanWorker = String(workerAddressInput || "").trim();
                  if (!ethers.isAddress(cleanWorker)) {
                    showToast(t("vaultErrInvalidAddress"), "error");
                    return;
                  }
                  const ok = await onAuthorizeWorker?.(workerModalData.dataId, cleanWorker, true);
                  if (ok) setWorkerModalData(null);
                }}
              >
                <span>{t("workerAuthBtn")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Update On-Chain Blinded Search Tags */}
      {tagsModalData && (
        <div className="terminal-modal-backdrop" onClick={() => setTagsModalData(null)}>
          <div
            ref={tagsModalRef}
            tabIndex={-1}
            className="terminal-modal-window"
            role="dialog"
            aria-modal="true"
            aria-label={`${t("modalBlindTagsTitle")} #${tagsModalData.dataId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <SealedCipherIcon size={16} color="#818cf8" />
                <span>{t("modalBlindTagsTitle")} #{tagsModalData.dataId}</span>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                title={t("close")}
                aria-label={t("close")}
                onClick={() => setTagsModalData(null)}
              >
                <CloseCrossIcon size={16} color="var(--text-muted)" />
              </button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <div className="field-label" style={{ marginBottom: "6px" }}>
                  {`${t("vaultBlindTagsQueued")} (${tagEntries.length}/16)`}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", padding: "8px", borderRadius: "6px", border: "1px solid var(--border-subtle)", background: "var(--bg-input)", minHeight: "38px" }}>
                  {tagEntries.map((entry, idx) => (
                    <span
                      key={`${entry.key}-${entry.value}-${idx}`}
                      style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 8px", borderRadius: "4px", background: "var(--bg-surface)", border: "1px solid var(--border-strong)", fontSize: "11px", fontFamily: "var(--font-mono)" }}
                    >
                      <span>{entry.key}:{entry.value.length > 22 ? `${entry.value.slice(0, 22)}...` : entry.value}</span>
                      <button
                        type="button"
                        className="icon-copy-btn"
                        title={t("vaultRemoveTagTitle")}
                        aria-label={t("vaultRemoveTagTitle")}
                        onClick={() => setTagEntries((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <CloseCrossIcon size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: "0 0 135px" }}>
                  <label htmlFor="input-vault-tag-key" className="field-label">
                    {t("blindSearchKey")}
                  </label>
                  <select
                    id="input-vault-tag-key"
                    className="field-select"
                    aria-label={t("blindSearchKey")}
                    value={tagKeyInput}
                    onChange={(e) => setTagKeyInput(e.target.value)}
                  >
                    <option value="gene">gene</option>
                    <option value="disease">disease</option>
                    <option value="trait">trait</option>
                    <option value="hpo">hpo</option>
                    <option value="ancestry">ancestry</option>
                    <option value="rsid">rsid</option>
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: "160px" }}>
                  <label htmlFor="input-vault-tag-val" className="field-label">
                    {t("blindSearchVal")}
                  </label>
                  <input
                    id="input-vault-tag-val"
                    type="text"
                    className="field-input"
                    placeholder={t("blindSearchVal")}
                    aria-label={t("blindSearchVal")}
                    value={tagValInput}
                    onChange={(e) => setTagValInput(e.target.value)}
                  />
                </div>
                <button
                  id="btn-add-blind-tag-item"
                  type="button"
                  className="btn-terminal btn-terminal-ghost"
                  style={{ height: "36px", padding: "0 12px", fontSize: "12px" }}
                  title={t("vaultAddTagTitle")}
                  onClick={() => {
                    const v = tagValInput.trim();
                    if (!v || tagEntries.length >= 16) return;
                    setTagEntries((prev) => [...prev, { key: tagKeyInput.trim() || "gene", value: v }]);
                    setTagValInput("");
                  }}
                >
                  <span>{t("vaultAddTagBtn")}</span>
                </button>
              </div>
              <div>
                <label htmlFor="input-vault-tag-salt" className="field-label">
                  {t("blindSaltLabel")}
                </label>
                <input
                  id="input-vault-tag-salt"
                  type="text"
                  className="field-input"
                  placeholder="GENOCHAIN_COHORT_SALT_V1"
                  aria-label={t("blindSaltLabel")}
                  value={tagSaltInput}
                  onChange={(e) => setTagSaltInput(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button
                type="button"
                className="btn-terminal btn-terminal-ghost"
                title={t("cancel")}
                onClick={() => setTagsModalData(null)}
              >
                {t("cancel")}
              </button>
              <button
                id="btn-confirm-blind-tags"
                type="button"
                className="btn-terminal btn-terminal-primary"
                title={t("confirm")}
                onClick={async () => {
                  const finalEntries = [...tagEntries];
                  if (tagValInput.trim() && finalEntries.length < 16) {
                    finalEntries.push({ key: tagKeyInput.trim() || "gene", value: tagValInput.trim() });
                  }
                  const seenPair = new Set();
                  const dedupedEntries = [];
                  for (const it of finalEntries) {
                    const k = String(it.key || "").trim();
                    const v = String(it.value || "").trim();
                    if (!k || !v) continue;
                    const pairKey = `${k}\u0000${v}`;
                    if (seenPair.has(pairKey)) continue;
                    seenPair.add(pairKey);
                    dedupedEntries.push({ key: k, value: v });
                    if (dedupedEntries.length >= 16) break;
                  }
                  const submitAccount = account;
                  const targetDataId = tagsModalData.dataId;
                  const submitSalt = tagSaltInput;
                  const uniqueHex = Array.from(
                    new Set(dedupedEntries.map((it) => computeBlindTagHex(it.key, it.value, submitSalt)))
                  );
                  const ok = await onUpdateBlindTags?.(targetDataId, uniqueHex);
                  if (ok) {
                    const sessionSnapshot = loadBlindTagsFromSession(submitAccount);
                    const nextSessionMap = {
                      ...sessionSnapshot,
                      [targetDataId]: { entries: dedupedEntries }
                    };
                    saveBlindTagsToSession(submitAccount, nextSessionMap);
                    if (
                      activeAccountRef.current &&
                      submitAccount &&
                      activeAccountRef.current.toLowerCase() === submitAccount.toLowerCase()
                    ) {
                      const savedRecord = { entries: dedupedEntries, salt: submitSalt };
                      setSavedTagsByDataId((prev) => ({ ...prev, [targetDataId]: savedRecord }));
                      setTagsModalData(null);
                    }
                  }
                }}
              >
                <span>{t("confirm")} ({tagEntries.length + (tagValInput.trim() ? 1 : 0)})</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Seller Post-Window Release Escrow */}
      {escrowModalData && (
        <div className="terminal-modal-backdrop" onClick={() => setEscrowModalData(null)}>
          <div
            ref={escrowModalRef}
            tabIndex={-1}
            className="terminal-modal-window"
            role="dialog"
            aria-modal="true"
            aria-label={`${t("modalReleaseEscrowTitle")}${escrowModalData.dataId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <GenoTokenIcon size={16} color="var(--accent-emerald-text)" />
                <span>{t("modalReleaseEscrowTitle")}{escrowModalData.dataId}</span>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                title={t("close")}
                aria-label={t("close")}
                onClick={() => setEscrowModalData(null)}
              >
                <CloseCrossIcon size={16} color="var(--text-secondary)" />
              </button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                {t("modalReleaseEscrowDesc")}
              </p>
              <div>
                <div className="spec-box-label" style={{ marginBottom: "6px" }}>{t("modalActiveEscrowsLabel")}</div>
                {detectedEscrows.length === 0 ? (
                  <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                    {t("modalNoActiveEscrows")}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {detectedEscrows.map((e) => (
                      <button
                        key={e.buyer}
                        type="button"
                        className="btn-terminal btn-terminal-ghost"
                        style={{ justifyContent: "space-between", fontSize: "11px", height: "30px", width: "100%" }}
                        onClick={() => setEscrowBuyerInput(e.buyer)}
                      >
                        <span style={{ fontFamily: "var(--font-mono)" }}>
                          {e.buyer.slice(0, 10)}...{e.buyer.slice(-6)}
                          {e.deadline ? ` (${new Date(e.deadline * 1000).toLocaleString()}${e.manualExtension ? ` · ${t("escrowManualExtTag")}` : ""})` : ""}
                        </span>
                        <span>
                          {e.disputed ? t("escrowDisputedActive") : e.delivered ? t("escrowStatusDelivered") : t("escrowPendingDelivery")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label htmlFor="input-release-escrow-buyer" className="field-label">
                  {t("modalReleaseBuyerLabel")}
                </label>
                <input
                  id="input-release-escrow-buyer"
                  type="text"
                  className="field-input"
                  placeholder="0x0000000000000000000000000000000000000000"
                  aria-label={t("modalReleaseBuyerLabel")}
                  value={escrowBuyerInput}
                  onChange={(e) => setEscrowBuyerInput(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button
                type="button"
                className="btn-terminal btn-terminal-ghost"
                onClick={() => setEscrowModalData(null)}
              >
                {t("cancel")}
              </button>
              <button
                id={`btn-release-escrow-${escrowModalData.dataId}`}
                type="button"
                className="btn-terminal btn-terminal-primary"
                disabled={
                  busyEscrowRelease ||
                  loadingEscrows ||
                  Boolean(
                    detectedEscrows.find(
                      (e) =>
                        e.buyer.toLowerCase() === escrowBuyerInput.trim().toLowerCase() &&
                        !(e.delivered && !e.disputed && escrowModalNowSec >= e.deadline)
                    )
                  )
                }
                onClick={async () => {
                  const targetBuyer = escrowBuyerInput.trim();
                  if (!ethers.isAddress(targetBuyer)) {
                    showToast(t("vaultErrInvalidAddress"), "error");
                    return;
                  }
                  setBusyEscrowRelease(true);
                  try {
                    if (onReleaseEscrow) {
                      await onReleaseEscrow(escrowModalData.dataId, targetBuyer);
                    } else {
                      const activeSigner = signer || (await getProviderAndSigner?.())?.signer;
                      await releaseEscrowSvc({ dataId: escrowModalData.dataId, buyer: targetBuyer, signer: activeSigner });
                      showToast?.(t("escrowReleasedSuccess") || "Escrow released successfully!");
                      await fetchOnChainDatasets?.(account);
                    }
                    setEscrowModalData(null);
                  } catch (err) {
                    if (!onReleaseEscrow) {
                      showToast?.((err.shortMessage || err.message), "error");
                    }
                  } finally {
                    setBusyEscrowRelease(false);
                  }
                }}
              >
                <span>{busyEscrowRelease ? "..." : t("btnExecuteReleaseEscrow")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}