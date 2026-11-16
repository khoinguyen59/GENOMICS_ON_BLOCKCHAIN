import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import contractAddresses from "../../contracts/contractAddresses.json";
import GenomicZkVerifierABI from "../../contracts/GenomicZkVerifierABI.json";
import { resolveEscrowDispute } from "../../services/datasetService";
import {
  DataOwnerShieldIcon,
  GenoTokenIcon,
  ShieldCheckIcon,
  CpuChipIcon,
  ServerDriveIcon,
  RefreshSpinIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  WalletKeyIcon,
  CopyIcon
} from "../../components/icons/GenoIcons";

const shortAddr = (addr) =>
  addr && addr.length > 14 ? `${addr.slice(0, 8)}...${addr.slice(-6)}` : addr || "...";

export default function AdminPortal() {
  const {
    account,
    localAccountIndex,
    connectLocalAccount,
    contracts,
    getProviderAndSigner,
    setShowIpfsSettings,
    pinataJwt,
    kuboRpc,
    showToast,
    refreshBalance
  } = useWeb3();
  const { fetchOnChainDatasets } = useDatasets();
  const { t, lang } = useLanguage();

  const [loadingTelemetry, setLoadingTelemetry] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [telemetry, setTelemetry] = useState({
    registryOwner: "",
    tokenOwner: "",
    dispatcher: "",
    zkVerifier: "",
    dataCount: 0,
    totalSupplyGeno: 0,
    registryTokenBal: 0,
    bountyCount: 0,
    reuseFeeBps: 500,
    maxBlindTags: 16,
    chainNowSec: 0
  });
  const [rpcError, setRpcError] = useState(null);
  const [bounties, setBounties] = useState([]);

  // Governance form states
  const [dispatcherInput, setDispatcherInput] = useState("");
  const [zkVerifierInput, setZkVerifierInput] = useState(contractAddresses.GenomicZkVerifier || "");

  // Treasury form states
  const [mintToInput, setMintToInput] = useState("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
  const [mintAmountInput, setMintAmountInput] = useState("1000");
  const [rescueTokenInput, setRescueTokenInput] = useState(contractAddresses.GenomicToken || "");
  const [rescueToInput, setRescueToInput] = useState("");
  const [rescueAmountInput, setRescueAmountInput] = useState("10");

  // ZK Bounty form states
  const [bountyTraitInput, setBountyTraitInput] = useState("ALDH2_rs671");
  const [bountyDescInput, setBountyDescInput] = useState("East Asian ALDH2 rs671 Variant Verification Cohort");
  const [bountyRewardInput, setBountyRewardInput] = useState("50");
  const [bountyMaxClaimsInput, setBountyMaxClaimsInput] = useState("5");
  const [bountyDurationInput, setBountyDurationInput] = useState("86400");

  // Escrow Dispute Arbitration states
  const [disputes, setDisputes] = useState([]);
  const [disputeDataIdInput, setDisputeDataIdInput] = useState("1");
  const [disputeBuyerInput, setDisputeBuyerInput] = useState("");

  const loadAdminTelemetry = useCallback(async () => {
    setLoadingTelemetry(true);
    try {
      const { provider } = await getProviderAndSigner();
      const activeContracts = contracts;
      if (!activeContracts?.registry || !activeContracts?.token) return;

      const latestBlock = await provider?.getBlock?.("latest").catch(() => null);
      const chainNowSec = latestBlock?.timestamp ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

      const [
        regOwner,
        tokOwner,
        disp,
        zkAddr,
        dCount,
        totSupply,
        regTokBal,
        reuseBps,
        maxTags
      ] = await Promise.all([
        activeContracts.registry.owner(),
        activeContracts.token.owner(),
        activeContracts.registry.capsuleDispatcher(),
        activeContracts.registry.zkVerifier(),
        activeContracts.registry.dataCount(),
        activeContracts.token.totalSupply(),
        activeContracts.token.balanceOf(contractAddresses.GenomicsRegistry),
        activeContracts.registry.REUSE_FEE_BPS(),
        activeContracts.registry.MAX_BLIND_TAGS_PER_DATASET()
      ]);

      const activeZkAddr =
        zkAddr && zkAddr !== ethers.ZeroAddress ? zkAddr : contractAddresses.GenomicZkVerifier;

      let bCount = 0;
      const bountyList = [];
      if (activeZkAddr && activeZkAddr !== ethers.ZeroAddress && provider) {
        const zk = new ethers.Contract(activeZkAddr, GenomicZkVerifierABI, provider);
        bCount = Number(await zk.bountyCount());
        for (let i = 1; i <= bCount; i++) {
          try {
            const b = await zk.bounties(i);
            bountyList.push({
              bountyId: Number(b.bountyId),
              sponsor: b.sponsor,
              targetTraitId: b.targetTraitId,
              traitDescription: b.traitDescription,
              rewardPerClaim: Number(ethers.formatUnits(b.rewardPerClaim, 18)),
              maxClaims: Number(b.maxClaims),
              currentClaims: Number(b.currentClaims),
              remainingFunding: Number(ethers.formatUnits(b.remainingFunding, 18)),
              expiresAt: Number(b.expiresAt),
              isActive: Boolean(b.isActive),
              isExpired: chainNowSec >= Number(b.expiresAt)
            });
          } catch {
            // Skip malformed entry
          }
        }
      }

      setTelemetry({
        registryOwner: regOwner,
        tokenOwner: tokOwner,
        dispatcher: disp,
        zkVerifier: zkAddr,
        dataCount: Number(dCount || 0n),
        totalSupplyGeno: Number(ethers.formatUnits(totSupply || 0n, 18)),
        registryTokenBal: Number(ethers.formatUnits(regTokBal || 0n, 18)),
        bountyCount: bCount,
        reuseFeeBps: Number(reuseBps || 500n),
        maxBlindTags: Number(maxTags || 16n),
        chainNowSec
      });
      const disputeList = [];
      try {
        const dispEvs = await activeContracts.registry.queryFilter(
          activeContracts.registry.filters.EscrowDisputed(),
          0,
          "latest"
        );
        const seenDisp = new Set();
        for (const ev of dispEvs) {
          const dId = Number(ev.args?.dataId || 0);
          const bAddr = ev.args?.buyer;
          const k = `${dId}:${(bAddr || "").toLowerCase()}`;
          if (!dId || !bAddr || seenDisp.has(k)) continue;
          seenDisp.add(k);
          const [isDisp, dep] = await Promise.all([
            activeContracts.registry.escrowDisputed(dId, bAddr).catch(() => false),
            activeContracts.registry.escrowDeposits(dId, bAddr).catch(() => null)
          ]);
          if (isDisp && dep && dep.amount > 0n && !dep.released && !dep.refunded) {
            disputeList.push({
              dataId: dId,
              buyer: bAddr,
              seller: dep.seller,
              amount: Number(ethers.formatUnits(dep.amount, 18))
            });
          }
        }
      } catch {}

      setDisputes(disputeList);
      if (disputeList.length > 0 && !disputeBuyerInput) {
        setDisputeDataIdInput(String(disputeList[0].dataId));
        setDisputeBuyerInput(disputeList[0].buyer);
      }
      setBounties(bountyList);
      setDispatcherInput((prev) => prev || disp || regOwner || "");
      setRescueToInput((prev) => prev || account || regOwner || "");
      setRpcError(null);
    } catch (err) {
      const errMsg = err.shortMessage || err.message;
      setRpcError(errMsg);
      showToast("Admin telemetry warning: " + errMsg, "error");
    } finally {
      setLoadingTelemetry(false);
    }
  }, [account, contracts, getProviderAndSigner, showToast]);

  useEffect(() => {
    loadAdminTelemetry();
  }, [loadAdminTelemetry, account]);

  const requireActiveSigner = async () => {
    const { signer: s } = await getProviderAndSigner();
    if (!s) throw new Error("Connect Hardhat #0 Admin or wallet signer first.");
    return s;
  };

  const handleSetDispatcher = async () => {
    try {
      setBusyAction("dispatcher");
      if (!ethers.isAddress(dispatcherInput)) throw new Error("Invalid dispatcher EVM address.");
      const s = await requireActiveSigner();
      const reg = contracts.registry.connect(s);
      showToast("Submitting setCapsuleDispatcher transaction...", "info");
      const tx = await reg.setCapsuleDispatcher(dispatcherInput);
      await tx.wait();
      showToast("Capsule Dispatcher updated on-chain!");
      await loadAdminTelemetry();
    } catch (err) {
      showToast("setCapsuleDispatcher failed: " + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleSetZkVerifier = async () => {
    try {
      setBusyAction("zkverifier");
      if (!ethers.isAddress(zkVerifierInput)) throw new Error("Invalid ZK Verifier EVM address.");
      const s = await requireActiveSigner();
      const reg = contracts.registry.connect(s);
      showToast("Submitting setZkVerifier transaction...", "info");
      const tx = await reg.setZkVerifier(zkVerifierInput);
      await tx.wait();
      showToast("ZK Verifier linked on-chain!");
      await loadAdminTelemetry();
    } catch (err) {
      showToast("setZkVerifier failed: " + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleMintGeno = async () => {
    try {
      setBusyAction("mint");
      if (!ethers.isAddress(mintToInput)) throw new Error("Invalid recipient EVM address.");
      const amt = Number(mintAmountInput);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Mint amount must be > 0.");
      const s = await requireActiveSigner();
      const tok = contracts.token.connect(s);
      showToast(`Minting ${amt} $GENO to ${mintToInput.slice(0, 8)}...`, "info");
      const tx = await tok.mint(mintToInput, ethers.parseUnits(String(amt), 18));
      await tx.wait();
      showToast(`Minted ${amt} $GENO successfully!`);
      await refreshBalance(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast("Mint failed: " + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleRescueTokens = async () => {
    try {
      setBusyAction("rescue");
      if (!ethers.isAddress(rescueTokenInput) || !ethers.isAddress(rescueToInput)) {
        throw new Error("Invalid token or recipient EVM address.");
      }
      const amt = Number(rescueAmountInput);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Rescue amount must be > 0.");
      const s = await requireActiveSigner();
      const reg = contracts.registry.connect(s);
      showToast(`Rescuing ${amt} tokens from Registry...`, "info");
      const tx = await reg.rescueTokens(rescueTokenInput, rescueToInput, ethers.parseUnits(String(amt), 18));
      await tx.wait();
      showToast(`Rescued ${amt} tokens successfully!`);
      await refreshBalance(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast("rescueTokens failed: " + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const computedTraitId = /^0x[0-9a-fA-F]{64}$/.test(bountyTraitInput.trim())
    ? bountyTraitInput.trim()
    : ethers.id(bountyTraitInput.trim() || "ALDH2_rs671");

  const handleCreateZkBounty = async () => {
    try {
      setBusyAction("bounty-create");
      const reward = Number(bountyRewardInput);
      const maxClaims = parseInt(bountyMaxClaimsInput, 10);
      const dur = parseInt(bountyDurationInput, 10);
      if (!Number.isFinite(reward) || reward <= 0) throw new Error("Reward per claim must be > 0.");
      if (!Number.isFinite(maxClaims) || maxClaims < 1) throw new Error("Max claims must be >= 1.");
      if (!Number.isFinite(dur) || dur < 3600) throw new Error("Duration must be >= 3600 seconds.");

      const s = await requireActiveSigner();
      const activeAddr = await s.getAddress();
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;

      const rewardWei = ethers.parseUnits(String(reward), 18);
      const totalFundingWei = rewardWei * BigInt(maxClaims);
      const tok = contracts.token.connect(s);
      const allowance = await tok.allowance(activeAddr, targetZkAddr);
      if (allowance < totalFundingWei) {
        showToast("1/2: Approving $GENO funding for GenomicZkVerifier...", "info");
        const approveTx = await tok.approve(targetZkAddr, totalFundingWei);
        await approveTx.wait();
      }

      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);
      showToast("2/2: Creating on-chain ZK Trait Verification Bounty...", "info");
      const tx = await zk.createZkBounty(
        computedTraitId,
        bountyDescInput.trim() || "Verified Genomic Trait Cohort",
        rewardWei,
        maxClaims,
        dur
      );
      await tx.wait();
      showToast("ZK Trait Bounty created and funded on-chain!");
      await refreshBalance(account);
      await fetchOnChainDatasets(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast("createZkBounty failed: " + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleCloseBounty = async (bountyId) => {
    try {
      setBusyAction(`close-${bountyId}`);
      const s = await requireActiveSigner();
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;
      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);
      showToast(`Closing expired ZK Bounty #${bountyId}...`, "info");
      const tx = await zk.closeExpiredBounty(bountyId);
      await tx.wait();
      showToast(`Closed Bounty #${bountyId} and refunded remaining $GENO.`);
      await refreshBalance(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast("closeExpiredBounty failed: " + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleResolveDispute = async (targetDataId, targetBuyer, refundBuyer) => {
    try {
      setBusyAction(`dispute-${refundBuyer ? "refund" : "release"}`);
      const dId = parseInt(targetDataId ?? disputeDataIdInput, 10);
      const buyerAddr = (targetBuyer ?? disputeBuyerInput).trim();
      if (!Number.isFinite(dId) || dId <= 0) throw new Error("Invalid Dataset ID.");
      if (!ethers.isAddress(buyerAddr)) throw new Error("Invalid disputing buyer EVM address.");
      const s = await requireActiveSigner();
      showToast(
        refundBuyer
          ? `Resolving dispute #${dId}: Refunding 100% to buyer...`
          : `Resolving dispute #${dId}: Rejecting dispute & releasing funds to seller...`,
        "info"
      );
      await resolveEscrowDispute({ dataId: dId, buyer: buyerAddr, refundBuyer, signer: s });
      showToast(
        refundBuyer
          ? `Dispute #${dId} resolved: Buyer refunded 100%.`
          : `Dispute #${dId} resolved: Escrow released to seller + EIP-2981 creator.`
      );
      await refreshBalance(account);
      await fetchOnChainDatasets(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast("resolveEscrowDispute failed: " + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const isOwnerMatch =
    account &&
    telemetry.registryOwner &&
    account.toLowerCase() === telemetry.registryOwner.toLowerCase();

  const copyAddr = (val) => {
    if (!val || !navigator.clipboard) return;
    navigator.clipboard.writeText(val);
    showToast(t("copiedToast") || (lang === "vi" ? "Đã sao chép!" : "Copied!"));
  };

  return (
    <div>
      {/* Top Admin Governance Header & Quick Role Switcher */}
      <div className="portal-subnav-bar" style={{ flexWrap: "wrap", gap: "12px" }}>
        <div className="admin-subnav-controls">
          <span className="admin-subnav-label">
            {t("adminQuickAccounts")}:
          </span>
          <span className="admin-acct-group">
            <button
              id="admin-switch-acct-0"
              type="button"
              className={`btn-terminal ${localAccountIndex === 0 ? "btn-terminal-primary" : ""}`}
              style={{ padding: "5px 10px", fontSize: "12px" }}
              title={t("adminAcct0")}
              onClick={() => connectLocalAccount(0)}
            >
              <WalletKeyIcon size={13} />
              <span>{t("adminAcct0")}</span>
            </button>
            <button
              id="admin-switch-acct-1"
              type="button"
              className={`btn-terminal ${localAccountIndex === 1 ? "btn-terminal-primary" : ""}`}
              style={{ padding: "5px 10px", fontSize: "12px" }}
              title={t("adminAcct1")}
              onClick={() => connectLocalAccount(1)}
            >
              <DataOwnerShieldIcon size={13} />
              <span>{t("adminAcct1")}</span>
            </button>
            <button
              id="admin-switch-acct-2"
              type="button"
              className={`btn-terminal ${localAccountIndex === 2 ? "btn-terminal-primary" : ""}`}
              style={{ padding: "5px 10px", fontSize: "12px" }}
              title={t("adminAcct2")}
              onClick={() => connectLocalAccount(2)}
            >
              <CpuChipIcon size={13} />
              <span>{t("adminAcct2")}</span>
            </button>
          </span>
          <span className="admin-subnav-sep" aria-hidden="true" />
          <button
            id="admin-open-ipfs-btn"
            type="button"
            className="btn-terminal"
            style={{ padding: "5px 10px", fontSize: "12px" }}
            title={t("adminOpenIpfs")}
            onClick={() => setShowIpfsSettings(true)}
          >
            <ServerDriveIcon size={13} />
            <span>{t("adminOpenIpfs")}</span>
          </button>
          <button
            id="admin-refresh-telemetry-btn"
            type="button"
            className="btn-terminal"
            style={{ padding: "5px 10px", fontSize: "12px" }}
            title={t("adminRefreshTelemetry")}
            onClick={loadAdminTelemetry}
          >
            <RefreshSpinIcon size={13} />
            <span>{loadingTelemetry ? "..." : t("adminRefreshTelemetry")}</span>
          </button>
        </div>

        <div className="portal-role-badge-static">
          <ShieldCheckIcon size={14} color={isOwnerMatch ? "#10b981" : "#f59e0b"} />
          <span>{t("roleAdminBadge")}</span>
        </div>
      </div>

      {/* Clear Page Heading & Subtitle */}
      <div className="admin-header-row">
        <div>
          <h1 className="admin-page-title">{t("adminPageTitle")}</h1>
          <p className="admin-portal-subtitle">{t("adminPortalSubtitle")}</p>
        </div>
      </div>

      {/* Persistent Inline RPC Error Banner */}
      {rpcError && (
        <div
          id="admin-rpc-error-banner"
          className="admin-rpc-error-banner"
          role="alert"
          style={{
            marginBottom: "18px",
            padding: "14px 18px",
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid rgba(239, 68, 68, 0.45)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
            flexWrap: "wrap"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <AlertTriangleIcon size={20} color="var(--accent-rose-text)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: "13px", color: "var(--accent-rose-text)" }}>
                {t("rpcOfflineTitle") || "Mất kết nối Node RPC Blockchain (Hardhat 31337)"}
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                {t("rpcOfflineDesc") || "Chỉ số hệ thống hiển thị trạng thái ngắt kết nối. Vui lòng kiểm tra Hardhat Node."} ({rpcError})
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn-terminal btn-terminal-primary"
            style={{ height: "32px", fontSize: "12px", padding: "0 14px", whiteSpace: "nowrap" }}
            onClick={loadAdminTelemetry}
          >
            <RefreshSpinIcon size={13} />
            <span>{t("retryConnection") || "Thử lại kết nối RPC"}</span>
          </button>
        </div>
      )}

      {/* 2x2 Admin Governance Studio Grid */}
      <div className="admin-governance-grid">
        {/* CARD 1: Protocol Telemetry & IPFS Configuration */}
        <section id="admin-telemetry-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <ServerDriveIcon size={16} color="var(--accent-cyan)" />
              </span>
              {t("adminTelemetryTitle")}
            </h2>
            <span className={`admin-owner-pill ${isOwnerMatch ? "is-match" : "is-mismatch"}`}>
              {isOwnerMatch ? <CheckCircleIcon size={12} /> : <AlertTriangleIcon size={12} />}
              <span>{isOwnerMatch ? t("adminOwnerMatch") : t("adminOwnerMismatch")}</span>
            </span>
          </div>

          <div className="admin-kpi-grid">
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiDatasets")}</div>
              <div className="admin-kpi-val">
                {rpcError ? "RPC Offline" : `${telemetry.dataCount} / ${telemetry.bountyCount}`}
              </div>
            </div>
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiSupply")}</div>
              <div className="admin-kpi-val is-accent">
                {rpcError ? "RPC Offline" : telemetry.totalSupplyGeno.toLocaleString()}
              </div>
            </div>
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiRoyalty")}</div>
              <div className="admin-kpi-val" style={{ fontSize: "15px" }}>
                {rpcError ? "RPC Offline" : `${telemetry.reuseFeeBps / 100}% (${telemetry.reuseFeeBps} bps) / ${telemetry.maxBlindTags}`}
              </div>
            </div>
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiEscrow")}</div>
              <div className="admin-kpi-val is-emerald" style={{ fontSize: "15px" }}>
                {rpcError ? "RPC Offline" : `${telemetry.registryTokenBal.toLocaleString()} $GENO`}
              </div>
            </div>
          </div>

          <div className="admin-kv-table">
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminRegistryOwner")}</span>
              <span className="admin-kv-val" title={telemetry.registryOwner}>
                <span>{shortAddr(telemetry.registryOwner)}</span>
                {telemetry.registryOwner && (
                  <button type="button" className="admin-copy-btn" title={telemetry.registryOwner} onClick={() => copyAddr(telemetry.registryOwner)}>
                    <CopyIcon size={11} />
                  </button>
                )}
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminConnectedSigner")}</span>
              <span className="admin-kv-val" title={account || ""}>
                <span>{account ? shortAddr(account) : (lang === "vi" ? "Chưa kết nối" : "Disconnected")}</span>
                {account && (
                  <button type="button" className="admin-copy-btn" title={account} onClick={() => copyAddr(account)}>
                    <CopyIcon size={11} />
                  </button>
                )}
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminLabelDispatcher")}</span>
              <span className="admin-kv-val" title={telemetry.dispatcher || ethers.ZeroAddress}>
                <span>{shortAddr(telemetry.dispatcher || ethers.ZeroAddress)}</span>
                <button type="button" className="admin-copy-btn" title={telemetry.dispatcher || ethers.ZeroAddress} onClick={() => copyAddr(telemetry.dispatcher || ethers.ZeroAddress)}>
                  <CopyIcon size={11} />
                </button>
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminLabelZkVerifier")}</span>
              <span className="admin-kv-val" title={telemetry.zkVerifier || ethers.ZeroAddress}>
                <span>{shortAddr(telemetry.zkVerifier || ethers.ZeroAddress)}</span>
                <button type="button" className="admin-copy-btn" title={telemetry.zkVerifier || ethers.ZeroAddress} onClick={() => copyAddr(telemetry.zkVerifier || ethers.ZeroAddress)}>
                  <CopyIcon size={11} />
                </button>
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminLabelIpfs")}</span>
              <span className="admin-kv-val">
                {pinataJwt ? "Pinata JWT" : (lang === "vi" ? "Chưa cấu hình Pinata" : "Pinata Unset")} | {kuboRpc}
              </span>
            </div>
          </div>
        </section>

        {/* CARD 2: Dispatcher & ZK Verifier Governance */}
        <section id="admin-governance-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <ShieldCheckIcon size={16} color="#818cf8" />
              </span>
              {t("adminGovPanelTitle")}
            </h2>
          </div>

          <div className="form-field">
            <label className="field-label" htmlFor="admin-dispatcher-input">
              <span>{t("adminDispatcherLabel")}</span>
              <button
                id="admin-fill-dispatcher-btn"
                type="button"
                className="admin-inline-fill-btn"
                title={t("adminBtnUseConnected")}
                onClick={() => setDispatcherInput(account || telemetry.registryOwner || "")}
              >
                {t("adminBtnUseConnected")}
              </button>
            </label>
            <input
              id="admin-dispatcher-input"
              type="text"
              className="field-input"
              value={dispatcherInput}
              onChange={(e) => setDispatcherInput(e.target.value)}
              placeholder="0x..."
            />
            <button
              id="admin-set-dispatcher-btn"
              type="button"
              className="btn-terminal btn-terminal-primary admin-full-btn"
              title={t("adminSetDispatcherBtn")}
              disabled={busyAction === "dispatcher"}
              onClick={handleSetDispatcher}
            >
              {busyAction === "dispatcher" ? "..." : t("adminSetDispatcherBtn")}
            </button>
          </div>

          <div className="form-field" style={{ marginTop: "14px", marginBottom: 0 }}>
            <label className="field-label" htmlFor="admin-zkverifier-input">
              <span>{t("adminZkVerifierLabel")}</span>
              <button
                id="admin-fill-zkverifier-btn"
                type="button"
                className="admin-inline-fill-btn"
                title={t("adminBtnUseDeployed")}
                onClick={() => setZkVerifierInput(contractAddresses.GenomicZkVerifier || "")}
              >
                {t("adminBtnUseDeployed")}
              </button>
            </label>
            <input
              id="admin-zkverifier-input"
              type="text"
              className="field-input"
              value={zkVerifierInput}
              onChange={(e) => setZkVerifierInput(e.target.value)}
              placeholder="0x..."
            />
            <button
              id="admin-set-zkverifier-btn"
              type="button"
              className="btn-terminal btn-terminal-primary admin-full-btn"
              title={t("adminSetZkVerifierBtn")}
              disabled={busyAction === "zkverifier"}
              onClick={handleSetZkVerifier}
            >
              {busyAction === "zkverifier" ? "..." : t("adminSetZkVerifierBtn")}
            </button>
          </div>
        </section>

        {/* CARD 3: $GENO Treasury Mint & Registry Token Rescue */}
        <section id="admin-treasury-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <GenoTokenIcon size={16} color="#fbbf24" />
              </span>
              {t("adminTreasuryTitle")}
            </h2>
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-mint-to-input">
                {t("adminMintToLabel")}
              </label>
              <input
                id="admin-mint-to-input"
                type="text"
                className="field-input"
                value={mintToInput}
                onChange={(e) => setMintToInput(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-mint-amount-input">
                {t("adminMintAmountLabel")}
              </label>
              <input
                id="admin-mint-amount-input"
                type="number"
                className="field-input"
                value={mintAmountInput}
                onChange={(e) => setMintAmountInput(e.target.value)}
              />
            </div>
          </div>
          <button
            id="admin-mint-btn"
            type="button"
            className="btn-terminal btn-terminal-primary admin-full-btn"
            title={t("adminMintBtn")}
            disabled={busyAction === "mint"}
            onClick={handleMintGeno}
          >
            {busyAction === "mint" ? "..." : t("adminMintBtn")}
          </button>

          <div className="admin-section-divider">
            <span>{t("adminTreasuryDivider")}</span>
          </div>

          <div className="form-field">
            <label className="field-label" htmlFor="admin-rescue-token-input">
              {t("adminRescueTokenLabel")}
            </label>
            <input
              id="admin-rescue-token-input"
              type="text"
              className="field-input"
              value={rescueTokenInput}
              onChange={(e) => setRescueTokenInput(e.target.value)}
              placeholder="0x..."
            />
          </div>
          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-rescue-to-input">
                {t("adminRescueToLabel")}
              </label>
              <input
                id="admin-rescue-to-input"
                type="text"
                className="field-input"
                value={rescueToInput}
                onChange={(e) => setRescueToInput(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-rescue-amount-input">
                {t("adminRescueAmtLabel")}
              </label>
              <input
                id="admin-rescue-amount-input"
                type="number"
                className="field-input"
                value={rescueAmountInput}
                onChange={(e) => setRescueAmountInput(e.target.value)}
              />
            </div>
          </div>
          <button
            id="admin-rescue-btn"
            type="button"
            className="btn-terminal btn-terminal-danger admin-full-btn"
            title={t("adminRescueBtn")}
            disabled={busyAction === "rescue"}
            onClick={handleRescueTokens}
          >
            {busyAction === "rescue" ? "..." : t("adminRescueBtn")}
          </button>
        </section>

        {/* CARD 4: ZK Trait Bounty Governance */}
        <section id="admin-bounty-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <CpuChipIcon size={16} color="#10b981" />
              </span>
              {t("adminBountyTitle")} ({bounties.length})
            </h2>
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-trait-input">
                {t("adminBountyTraitLabel")}
              </label>
              <input
                id="admin-bounty-trait-input"
                type="text"
                className="field-input"
                value={bountyTraitInput}
                onChange={(e) => setBountyTraitInput(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-duration-input">
                {t("adminBountyDurationLabel")}
              </label>
              <input
                id="admin-bounty-duration-input"
                type="number"
                className="field-input"
                value={bountyDurationInput}
                onChange={(e) => setBountyDurationInput(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field" style={{ marginBottom: "12px" }}>
            <label className="field-label" htmlFor="admin-bounty-desc-input">
              {t("adminBountyDescLabel")}
            </label>
            <input
              id="admin-bounty-desc-input"
              type="text"
              className="field-input"
              value={bountyDescInput}
              onChange={(e) => setBountyDescInput(e.target.value)}
            />
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-reward-input">
                {t("adminBountyRewardLabel")}
              </label>
              <input
                id="admin-bounty-reward-input"
                type="number"
                className="field-input"
                value={bountyRewardInput}
                onChange={(e) => setBountyRewardInput(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-maxclaims-input">
                {t("adminBountyMaxClaimsLabel")}
              </label>
              <input
                id="admin-bounty-maxclaims-input"
                type="number"
                className="field-input"
                value={bountyMaxClaimsInput}
                onChange={(e) => setBountyMaxClaimsInput(e.target.value)}
              />
            </div>
          </div>

          <div className="admin-trait-hash-bar">
            <span>
              <strong>{t("adminTraitHashLabel")}:</strong> {computedTraitId.slice(0, 14)}...{computedTraitId.slice(-8)}
            </span>
            <button
              type="button"
              className="admin-copy-btn"
              title={computedTraitId}
              onClick={() => copyAddr(computedTraitId)}
            >
              <CopyIcon size={11} />
            </button>
          </div>

          <button
            id="admin-create-bounty-btn"
            type="button"
            className="btn-terminal btn-terminal-primary admin-full-btn"
            style={{ marginTop: 0 }}
            title={t("adminBountyCreateBtn")}
            disabled={busyAction === "bounty-create"}
            onClick={handleCreateZkBounty}
          >
            {busyAction === "bounty-create" ? "..." : t("adminBountyCreateBtn")}
          </button>

          {/* Active Bounties List */}
          <div className="admin-bounty-list">
            {bounties.map((b) => {
              const badgeCls = !b.isActive ? "is-closed" : b.isExpired ? "is-expired" : "is-active";
              const badgeText = !b.isActive
                ? t("adminBountyClosedBadge")
                : b.isExpired
                  ? t("adminBountyExpiredBadge")
                  : t("adminBountyActiveBadge");
              return (
                <div key={b.bountyId} className="admin-bounty-row">
                  <div style={{ fontSize: "12px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontWeight: 700, color: "var(--text-primary)" }}>
                      <span>#{b.bountyId} {b.traitDescription}</span>
                      <span className={`admin-bounty-badge ${badgeCls}`}>{badgeText}</span>
                    </div>
                    <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11px", marginTop: "3px" }}>
                      {b.rewardPerClaim} $GENO | {b.currentClaims}/{b.maxClaims} {t("adminClaimsUnit")} | {b.remainingFunding} $GENO
                    </div>
                  </div>
                  {b.isActive && (
                    <button
                      id={`admin-close-bounty-${b.bountyId}`}
                      type="button"
                      className="btn-terminal"
                      style={{ padding: "5px 10px", fontSize: "11.5px", flexShrink: 0 }}
                      title={t("adminBountyCloseBtn")}
                      disabled={busyAction === `close-${b.bountyId}`}
                      onClick={() => handleCloseBounty(b.bountyId)}
                    >
                      {t("adminBountyCloseBtn")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* CARD 5: Escrow Dispute Arbiter Governance */}
        <section id="admin-escrow-disputes-card" className="studio-panel" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <AlertTriangleIcon size={16} color="var(--accent-rose-text)" />
              </span>
              {t("adminEscrowPanelTitle")}
            </h2>
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-dispute-dataid-input">
                {t("adminDisputeDataIdLabel")}
              </label>
              <input
                id="admin-dispute-dataid-input"
                type="number"
                className="field-input"
                value={disputeDataIdInput}
                onChange={(e) => setDisputeDataIdInput(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-dispute-buyer-input">
                {t("adminDisputeBuyerLabel")}
              </label>
              <input
                id="admin-dispute-buyer-input"
                type="text"
                className="field-input"
                value={disputeBuyerInput}
                onChange={(e) => setDisputeBuyerInput(e.target.value)}
                placeholder="0x..."
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
            <button
              id="admin-resolve-refund-btn"
              type="button"
              className="btn-terminal btn-terminal-danger"
              style={{ flex: 1, justifyContent: "center", background: "#b91c1c", color: "#ffffff" }}
              disabled={busyAction.startsWith("dispute-")}
              onClick={() => handleResolveDispute(disputeDataIdInput, disputeBuyerInput, true)}
            >
              <span>{busyAction === "dispute-refund" ? "..." : t("adminResolveRefundBtn")}</span>
            </button>
            <button
              id="admin-resolve-release-btn"
              type="button"
              className="btn-terminal btn-terminal-success"
              style={{ flex: 1, justifyContent: "center" }}
              disabled={busyAction.startsWith("dispute-")}
              onClick={() => handleResolveDispute(disputeDataIdInput, disputeBuyerInput, false)}
            >
              <span>{busyAction === "dispute-release" ? "..." : t("adminResolveReleaseBtn")}</span>
            </button>
          </div>

          <div style={{ marginTop: "12px" }}>
            <div className="spec-box-label" style={{ marginBottom: "6px" }}>{t("adminActiveDisputesLabel")}</div>
            {disputes.length === 0 ? (
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                {t("adminNoActiveDisputes")}
              </div>
            ) : (
              <div className="admin-bounty-list">
                {disputes.map((d) => (
                  <div key={`${d.dataId}-${d.buyer}`} className="admin-bounty-row">
                    <div style={{ fontSize: "12px", minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>
                        #{d.dataId} • {d.amount} $GENO
                      </div>
                      <div style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                        Buyer: {shortAddr(d.buyer)} | Seller: {shortAddr(d.seller)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                      <button
                        type="button"
                        className="btn-terminal btn-terminal-danger"
                        style={{ padding: "5px 10px", fontSize: "11px", background: "#b91c1c", color: "#ffffff" }}
                        onClick={() => handleResolveDispute(d.dataId, d.buyer, true)}
                      >
                        {t("adminResolveRefundBtn")}
                      </button>
                      <button
                        type="button"
                        className="btn-terminal btn-terminal-success"
                        style={{ padding: "5px 10px", fontSize: "11px" }}
                        onClick={() => handleResolveDispute(d.dataId, d.buyer, false)}
                      >
                        {t("adminResolveReleaseBtn")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
