import React, { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { useDatasets } from "../../context/DatasetContext";
import { useLanguage } from "../../context/LanguageContext";
import { useWeb3 } from "../../context/Web3Context";
import {
  ActivityPulseIcon,
  VerifiedBadgeIcon,
  GenoTokenIcon,
  CopyIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  LockClosedIcon,
  ShieldCheckIcon,
  DnaHelixIcon,
  SparklesIcon,
  AlertTriangleIcon
} from "../../components/icons/GenoIcons";
import GenomicVisualCover from "../../components/common/GenomicVisualCover";
import contractAddresses from "../../contracts/contractAddresses.json";
import { queryFilterChunked, getDeploymentStartBlock } from "../../services/datasetService";

export default function OpenSeaActivityFeed() {
  const { datasets, setSelectedAssetModal, getLocalizedTitle } = useDatasets();
  const { getContracts, contracts, showToast } = useWeb3();
  const { t, lang } = useLanguage();
  const [eventFilter, setEventFilter] = useState("all");
  const [copiedKey, setCopiedKey] = useState(null);

  const [onChainEvents, setOnChainEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [rpcError, setRpcError] = useState(null);
  const fetchSeqRef = useRef(0);
  const isMountedRef = useRef(true);
  const datasetsRef = useRef(datasets);
  datasetsRef.current = datasets;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const copyText = (text, key) => {
    if (navigator.clipboard?.writeText) {
      Promise.resolve(navigator.clipboard.writeText(text))
        .then(() => {
          setCopiedKey(key);
          showToast(t("copiedToast") || "Đã sao chép vào bộ nhớ tạm!");
          setTimeout(() => setCopiedKey(null), 2000);
        })
        .catch(() => {
          showToast(lang === "vi" ? "Không có quyền ghi bộ nhớ tạm." : "Clipboard permission denied.", "error");
        });
    }
  };

  const formatRelativeTime = (timestampSec, currentLang) => {
    if (!timestampSec) return currentLang === "vi" ? "vừa xong" : "just now";
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = Math.max(0, nowSec - Number(timestampSec));
    if (diff < 60) {
      return currentLang === "vi" ? "vừa xong" : "just now";
    }
    const minutes = Math.floor(diff / 60);
    if (minutes < 60) {
      return currentLang === "vi" ? `${minutes} phút trước` : `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return currentLang === "vi" ? `${hours} giờ trước` : `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return currentLang === "vi" ? `${days} ngày trước` : `${days}d ago`;
  };

  // Fetch real on-chain event ledger from GenomicsRegistry contract (Invariant 03, 07 & 12 compliant)
  const fetchEvents = useCallback(async () => {
    const mySeq = ++fetchSeqRef.current;
    const isStale = () => !isMountedRef.current || fetchSeqRef.current !== mySeq;
    setLoadingEvents(true);
    setRpcError(null);
    try {
      const activeContracts = contracts || (await getContracts());
      if (isStale()) return;
      if (!activeContracts?.registry) {
        setLoadingEvents(false);
        return;
      }

      const registry = activeContracts.registry;
      const provider = activeContracts.provider;
      const registryAddr = registry.target || contractAddresses.GenomicsRegistry || "";

      const filterMint = registry.filters.GenomicDataRegistered ? registry.filters.GenomicDataRegistered() : "GenomicDataRegistered";
      const filterAccess = registry.filters.AccessGranted ? registry.filters.AccessGranted() : "AccessGranted";
      const filterDirectAccess = registry.filters.DirectAccessGranted ? registry.filters.DirectAccessGranted() : null;
      const filterEscrow = registry.filters.EscrowDeposited
        ? registry.filters.EscrowDeposited()
        : registry.filters.AccessEscrowCreated
        ? registry.filters.AccessEscrowCreated()
        : "EscrowDeposited";
      const filterEscrowReleased = registry.filters.EscrowReleased ? registry.filters.EscrowReleased() : null;
      const filterEscrowConfirmed = registry.filters.EscrowConfirmed ? registry.filters.EscrowConfirmed() : null;
      const filterRoyalty = registry.filters.RoyaltyPaid ? registry.filters.RoyaltyPaid() : "RoyaltyPaid";
      const filterDisputed = registry.filters.EscrowDisputed ? registry.filters.EscrowDisputed() : null;
      const filterResolved = registry.filters.EscrowDisputeResolved ? registry.filters.EscrowDisputeResolved() : null;
      const filterRefunded = registry.filters.EscrowRefunded ? registry.filters.EscrowRefunded() : null;
      const filterStudyReuse = registry.filters.StudyReuseRecorded ? registry.filters.StudyReuseRecorded() : null;
      const filterCapsule = registry.filters.CapsuleDelivered ? registry.filters.CapsuleDelivered() : null;

      // Query raw events via chunked block windows with Promise.allSettled so one rate-limited
      // query degrades gracefully while full RPC outage still surfaces verbatim (Invariant 07)
      const startBlock = getDeploymentStartBlock();
      const settledLogs = await Promise.allSettled([
        queryFilterChunked(registry, filterMint, startBlock, "latest"),
        queryFilterChunked(registry, filterAccess, startBlock, "latest"),
        filterDirectAccess ? queryFilterChunked(registry, filterDirectAccess, startBlock, "latest") : Promise.resolve([]),
        queryFilterChunked(registry, filterEscrow, startBlock, "latest"),
        filterEscrowReleased ? queryFilterChunked(registry, filterEscrowReleased, startBlock, "latest") : Promise.resolve([]),
        filterEscrowConfirmed ? queryFilterChunked(registry, filterEscrowConfirmed, startBlock, "latest") : Promise.resolve([]),
        queryFilterChunked(registry, filterRoyalty, startBlock, "latest"),
        filterDisputed ? queryFilterChunked(registry, filterDisputed, startBlock, "latest") : Promise.resolve([]),
        filterResolved ? queryFilterChunked(registry, filterResolved, startBlock, "latest") : Promise.resolve([]),
        filterRefunded ? queryFilterChunked(registry, filterRefunded, startBlock, "latest") : Promise.resolve([]),
        filterStudyReuse ? queryFilterChunked(registry, filterStudyReuse, startBlock, "latest") : Promise.resolve([]),
        filterCapsule ? queryFilterChunked(registry, filterCapsule, startBlock, "latest") : Promise.resolve([])
      ]);
      if (isStale()) return;

      const rejectedLogs = settledLogs.filter((r) => r.status === "rejected");
      if (rejectedLogs.length === settledLogs.length) {
        throw rejectedLogs[0].reason || new Error("All on-chain activity event queries failed.");
      }
      if (rejectedLogs.length > 0) {
        console.warn(
          `[ActivityFeed] ${rejectedLogs.length}/${settledLogs.length} event queries rate-limited/failed; rendering available events.`
        );
      }
      const [
        mintLogs,
        accessLogs,
        directAccessLogs,
        escrowLogs,
        escrowReleasedLogs,
        escrowConfirmedLogs,
        royaltyLogs,
        disputedLogs,
        resolvedLogs,
        refundedLogs,
        reuseLogs,
        capsuleLogs
      ] = settledLogs.map((r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []));

      // Deduplicated bounded-concurrency block-timestamp caching (max 8 concurrent getBlock calls)
      const allLogs = [
        ...mintLogs,
        ...accessLogs,
        ...directAccessLogs,
        ...escrowLogs,
        ...escrowReleasedLogs,
        ...escrowConfirmedLogs,
        ...royaltyLogs,
        ...disputedLogs,
        ...resolvedLogs,
        ...refundedLogs,
        ...reuseLogs,
        ...capsuleLogs
      ];
      const uniqueBlocks = Array.from(new Set(allLogs.map((l) => Number(l.blockNumber)).filter((n) => Number.isFinite(n))));
      const blockTimestampCache = new Map();
      const fallbackNowSec = Math.floor(Date.now() / 1000);
      if (provider && typeof provider.getBlock === "function" && uniqueBlocks.length > 0) {
        const CONCURRENCY = 8;
        for (let i = 0; i < uniqueBlocks.length; i += CONCURRENCY) {
          if (isStale()) return;
          const batch = uniqueBlocks.slice(i, i + CONCURRENCY);
          await Promise.all(
            batch.map(async (blkNum) => {
              try {
                const block = await provider.getBlock(blkNum);
                blockTimestampCache.set(blkNum, Number(block?.timestamp || fallbackNowSec));
              } catch {
                blockTimestampCache.set(blkNum, fallbackNowSec);
              }
            })
          );
        }
      }
      if (isStale()) return;

      const getCachedTs = (blockNumber) => blockTimestampCache.get(Number(blockNumber)) ?? fallbackNowSec;
      const parsedList = [];

      // 1. Mint Events (GenomicDataRegistered)
      for (const log of mintLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const owner = log.args?.owner || log.args?.[2] || "0x0000000000000000000000000000000000000000";
        const priceWei = log.args?.price ?? log.args?.[4] ?? 0n;
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `mint-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "mint",
          typeColor: "var(--accent-cyan)",
          dataId: dId,
          price: Number(ethers.formatUnits(priceWei, 18)),
          from: "0x0000000000000000000000000000000000000000",
          to: owner,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 2. Sales / Purchases (AccessGranted)
      for (const log of accessLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.researcher || log.args?.[1] || "";
        const paidWei = log.args?.paidAmount ?? log.args?.[2] ?? 0n;
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `access-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "purchase",
          typeColor: "var(--accent-emerald-text)",
          dataId: dId,
          price: Number(ethers.formatUnits(paidWei, 18)),
          from: buyer,
          to: registryAddr,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 2b. Direct Access Granted (DirectAccessGranted - non-priced owner grant)
      for (const log of directAccessLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const recipient = log.args?.recipient || log.args?.[1] || "";
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `direct-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "purchase",
          subType: "direct_access",
          typeColor: "var(--accent-cyan)",
          dataId: dId,
          price: null,
          from: registryAddr,
          to: recipient,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 3. Escrow (EscrowDeposited / AccessEscrowCreated)
      for (const log of escrowLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.buyer || log.args?.[1] || "";
        const amtWei = log.args?.amount ?? log.args?.[2] ?? 0n;
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `escrow-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "escrow",
          typeColor: "var(--accent-amber-text)",
          dataId: dId,
          price: Number(ethers.formatUnits(amtWei, 18)),
          from: buyer,
          to: registryAddr,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 3b. Escrow Released (EscrowReleased)
      for (const log of escrowReleasedLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const seller = log.args?.seller || log.args?.[2] || "";
        const sellerProceeds = BigInt(log.args?.sellerProceeds ?? log.args?.[3] ?? 0n);
        const royaltyAmt = BigInt(log.args?.royaltyAmount ?? log.args?.[4] ?? 0n);
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `escrow-rel-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "escrow",
          subType: "escrow_released",
          typeColor: "var(--accent-emerald-text)",
          dataId: dId,
          price: Number(ethers.formatUnits(sellerProceeds + royaltyAmt, 18)),
          from: registryAddr,
          to: seller,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 3c. Escrow Confirmed (EscrowConfirmed - non-priced confirmation signal)
      for (const log of escrowConfirmedLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.buyer || log.args?.[1] || "";
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `escrow-conf-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "escrow",
          subType: "escrow_confirmed",
          typeColor: "var(--accent-emerald-text)",
          dataId: dId,
          price: null,
          from: buyer,
          to: registryAddr,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 4. Royalties (RoyaltyPaid)
      for (const log of royaltyLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const creator = log.args?.creator || log.args?.[1] || "";
        const amtWei = log.args?.amount ?? log.args?.[2] ?? 0n;
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `royalty-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "royalty",
          typeColor: "var(--accent-purple-text)",
          dataId: dId,
          price: Number(ethers.formatUnits(amtWei, 18)),
          from: registryAddr,
          to: creator,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 5. Escrow Disputed (EscrowDisputed - non-priced lifecycle event)
      for (const log of disputedLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.buyer || log.args?.[1] || "";
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `disputed-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "escrow",
          subType: "escrow_disputed",
          typeColor: "var(--accent-rose-text)",
          dataId: dId,
          price: null,
          from: buyer,
          to: registryAddr,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 6. Escrow Dispute Resolved (EscrowDisputeResolved)
      const datasetById = new Map((datasetsRef.current || []).map((d) => [Number(d.dataId), d]));
      const releasedSellerByTxData = new Map();
      for (const relLog of escrowReleasedLogs) {
        const relDataId = Number(relLog.args?.dataId ?? relLog.args?.[0] ?? 0);
        const relBuyer = String(relLog.args?.buyer || relLog.args?.[1] || "").toLowerCase();
        const relSeller = relLog.args?.seller || relLog.args?.[2] || "";
        if (relDataId && relSeller && relLog.transactionHash) {
          const txLower = relLog.transactionHash.toLowerCase();
          if (relBuyer) releasedSellerByTxData.set(`${txLower}:${relDataId}:${relBuyer}`, relSeller);
          releasedSellerByTxData.set(`${txLower}:${relDataId}`, relSeller);
        }
      }
      for (const log of resolvedLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.buyer || log.args?.[1] || "";
        const refundBuyer = Boolean(log.args?.refundBuyer ?? log.args?.[2]);
        const amtWei = log.args?.amount ?? log.args?.[3] ?? 0n;
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        const txLower = String(txHash || "").toLowerCase();
        const resolvedSeller =
          releasedSellerByTxData.get(`${txLower}:${dId}:${String(buyer || "").toLowerCase()}`) ||
          releasedSellerByTxData.get(`${txLower}:${dId}`) ||
          datasetById.get(dId)?.owner ||
          "";
        parsedList.push({
          id: `resolved-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "escrow",
          subType: refundBuyer ? "escrow_resolved_refund" : "escrow_resolved_release",
          typeColor: refundBuyer ? "var(--accent-amber-text)" : "var(--accent-emerald-text)",
          dataId: dId,
          price: Number(ethers.formatUnits(amtWei, 18)),
          from: registryAddr,
          to: refundBuyer ? buyer : resolvedSeller,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 7. Escrow Refunded (EscrowRefunded)
      for (const log of refundedLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.buyer || log.args?.[1] || "";
        const amtWei = log.args?.amount ?? log.args?.[2] ?? 0n;
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `refunded-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "escrow",
          subType: "escrow_refunded",
          typeColor: "var(--accent-amber-text)",
          dataId: dId,
          price: Number(ethers.formatUnits(amtWei, 18)),
          from: registryAddr,
          to: buyer,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 8. Study Reuse Recorded (StudyReuseRecorded)
      for (const log of reuseLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const researcher = log.args?.researcher || log.args?.[1] || "";
        const feeWei = log.args?.totalFee ?? log.args?.[3] ?? 0n;
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `reuse-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "royalty",
          subType: "study_reuse",
          typeColor: "var(--accent-cyan)",
          dataId: dId,
          price: Number(ethers.formatUnits(feeWei, 18)),
          from: researcher,
          to: registryAddr,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // 9. Capsule Delivered (CapsuleDelivered - non-priced lifecycle event)
      for (const log of capsuleLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const researcher = log.args?.researcher || log.args?.[1] || "";
        const ts = getCachedTs(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `capsule-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "purchase",
          subType: "capsule_delivered",
          typeColor: "var(--accent-emerald-text)",
          dataId: dId,
          price: null,
          from: registryAddr,
          to: researcher,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          timestampSec: ts
        });
      }

      // Sort newest first by blockNumber descending, then logIndex descending
      parsedList.sort((a, b) => (b.blockNumber - a.blockNumber) || ((b.logIndex ?? 0) - (a.logIndex ?? 0)));
      if (!isStale()) {
        setOnChainEvents(parsedList);
      }
    } catch (err) {
      if (isStale()) return;
      console.error("OpenSeaActivityFeed fetchEvents RPC error:", err);
      const rawErrMsg = err?.shortMessage || err?.reason || err?.message || String(err);
      setRpcError(rawErrMsg);
      setOnChainEvents([]);
    } finally {
      if (!isStale()) {
        setLoadingEvents(false);
      }
    }
  }, [contracts, getContracts]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const filteredEvents = onChainEvents.filter((ev) => {
    if (eventFilter === "all") return true;
    return ev.type === eventFilter;
  });

  return (
    <div className="opensea-activity-wrapper">
      {/* Activity Filter Header */}
      <div className="activity-toolbar-row">
        <div className="activity-live-status">
          <ActivityPulseIcon size={18} color={rpcError ? "var(--accent-rose)" : "var(--accent-emerald)"} />
          <span style={{ fontSize: "14px", fontWeight: 800, color: "var(--text-primary)" }}>
            {t("activityLiveLedger") || "Real-Time Blockchain Activity Ledger"}
          </span>
          <span className="live-pulse-dot" style={rpcError ? { background: "var(--accent-rose)", boxShadow: "0 0 8px var(--accent-rose)" } : {}} />
        </div>

        <div className="activity-filter-pills">
          {[
            { id: "all", label: t("activityFilterAll") || "All Events" },
            { id: "purchase", label: t("activityFilterPurchases") || "Sales" },
            { id: "escrow", label: t("activityFilterEscrow") || "Escrow" },
            { id: "mint", label: t("activityFilterMints") || "Listings" },
            { id: "royalty", label: t("activityFilterRoyalties") || "Royalties" }
          ].map((pill) => (
            <button
              key={pill.id}
              type="button"
              className={`activity-pill-btn ${eventFilter === pill.id ? "active" : ""}`}
              onClick={() => setEventFilter(pill.id)}
            >
              <span>{pill.label}</span>
            </button>
          ))}
        </div>
      </div>

      {rpcError && (
        <div style={{ padding: "10px 14px", marginBottom: "14px", borderRadius: "var(--radius-xs)", background: "rgba(239, 68, 68, 0.12)", border: "1px solid rgba(239, 68, 68, 0.35)", color: "var(--accent-rose-text)", fontSize: "12px", fontFamily: "var(--font-mono)" }}>
          <strong>[RPC Event Query Error]</strong> {rpcError}
        </div>
      )}

      {/* Activity Table */}
      <div
        className="opensea-activity-table-wrap"
        tabIndex="0"
        role="region"
        aria-label={t("ariaActivityTableScroll")}
      >
        <table className="opensea-activity-table">
          <thead>
            <tr>
              <th style={{ width: "170px" }}>{t("activityColEvent") || "EVENT"}</th>
              <th>{t("activityColItem") || "GENOMIC COHORT"}</th>
              <th style={{ width: "130px" }}>{t("activityColPrice") || "PRICE"}</th>
              <th style={{ width: "160px" }}>{t("activityColFrom") || "FROM"}</th>
              <th style={{ width: "160px" }}>{t("activityColTo") || "TO"}</th>
              <th style={{ width: "150px" }}>{t("activityColTx") || "TRANSACTION"}</th>
              <th style={{ width: "100px", textAlign: "right" }}>{t("activityColTime") || "TIME"}</th>
            </tr>
          </thead>
          <tbody>
            {rpcError ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "32px 20px", color: "var(--accent-rose-text)", fontFamily: "var(--font-mono)", fontSize: "13px", background: "rgba(244, 63, 94, 0.05)" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
                    <div style={{ fontWeight: 700, fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <AlertTriangleIcon size={15} color="var(--accent-rose)" />
                      <span>{t("rpcErrorOccurred")}</span>
                    </div>
                    <div style={{ color: "var(--text-secondary)", maxWidth: "800px", wordBreak: "break-word", fontSize: "12px" }}>
                      {rpcError}
                    </div>
                    <button
                      type="button"
                      onClick={() => fetchEvents()}
                      style={{
                        marginTop: "8px",
                        padding: "6px 14px",
                        background: "#b91c1c",
                        color: "#ffffff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 600,
                        fontSize: "12px"
                      }}
                    >
                      {lang === "vi" ? "Thử Lại (Retry)" : "Retry RPC Query"}
                    </button>
                  </div>
                </td>
              </tr>
            ) : loadingEvents && onChainEvents.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "36px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  {t("loading") || "Đang tải dữ liệu sự kiện blockchain..."}
                </td>
              </tr>
            ) : filteredEvents.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "36px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "13px" }}>
                  {t("activityEmpty") || "Chưa ghi nhận sự kiện on-chain nào"}
                </td>
              </tr>
            ) : (
              filteredEvents.map((ev) => {
                const dataset = datasets.find((d) => d.dataId === ev.dataId) || { dataId: ev.dataId };
                const title = (getLocalizedTitle ? getLocalizedTitle(dataset, lang) : dataset.disease) || `${t("cohortPrefix")}${ev.dataId}`;
                const dsRoyaltyPct = Number((((dataset.royaltyBps ?? 1000)) / 100).toFixed(2));
                const typeLabel =
                  ev.subType === "escrow_disputed"
                    ? t("eventEscrowDisputed") || "Escrow Disputed"
                    : ev.subType === "escrow_resolved_refund"
                    ? t("eventEscrowResolvedRefund") || "Dispute Refunded"
                    : ev.subType === "escrow_resolved_release"
                    ? t("eventEscrowResolvedRelease") || "Dispute Released"
                    : ev.subType === "escrow_refunded"
                    ? t("eventEscrowRefunded") || "Escrow Refunded"
                    : ev.subType === "escrow_released"
                    ? t("eventEscrowReleased") || "Escrow Released"
                    : ev.subType === "escrow_confirmed"
                    ? t("eventEscrowConfirmed") || "Escrow Confirmed"
                    : ev.subType === "direct_access"
                    ? t("eventDirectAccess") || "Direct Access Granted"
                    : ev.subType === "study_reuse"
                    ? t("eventStudyReuse") || "Study Reuse (5%)"
                    : ev.subType === "capsule_delivered"
                    ? t("eventCapsuleDelivered") || "Capsule Delivered"
                    : ev.type === "purchase"
                    ? t("eventPurchase") || "Access Purchased"
                    : ev.type === "escrow"
                    ? t("eventEscrow") || "Escrow Deposited"
                    : ev.type === "royalty"
                    ? `${dsRoyaltyPct}% ${t("eip2981RoyaltyTag")}`
                    : t("eventMint") || "Dataset Listed";

                return (
                  <tr key={ev.id} className="activity-table-row">
                    {/* Event Type Badge */}
                    <td>
                      <span
                        className="activity-event-badge"
                        style={{
                          color: ev.typeColor,
                          borderColor: `color-mix(in srgb, ${ev.typeColor} 20%, transparent)`,
                          background: `color-mix(in srgb, ${ev.typeColor} 10%, transparent)`
                        }}
                      >
                        {ev.type === "purchase" ? (
                          <LockClosedIcon size={12} color={ev.typeColor} />
                        ) : ev.type === "escrow" ? (
                          <ShieldCheckIcon size={12} color={ev.typeColor} />
                        ) : ev.type === "royalty" ? (
                          <SparklesIcon size={12} color={ev.typeColor} />
                        ) : (
                          <DnaHelixIcon size={12} color={ev.typeColor} />
                        )}
                        <span>{typeLabel}</span>
                      </span>
                    </td>

                    {/* Genomic Item */}
                    <td>
                      <div
                        className="activity-item-cell"
                        role="button"
                        tabIndex={0}
                        onClick={() => dataset.dataId && setSelectedAssetModal(dataset)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            if (dataset.dataId) setSelectedAssetModal(dataset);
                          }
                        }}
                        title={t("ariaInspectCohort")}
                      >
                        <div className="activity-thumb-box">
                          <GenomicVisualCover dataset={dataset} height={36} showAvatar={false} />
                        </div>
                        <div className="activity-item-text">
                          <div className="activity-item-title">
                            <span>{title}</span>
                            {dataset.metadataVerificationStatus === "verified" && !dataset.metadataTampered ? (
                              <span data-verification-badge="verified" title={t("evmSha256Match") || "EVM SHA-256 MATCH"} style={{ display: "inline-flex", alignItems: "center" }}>
                                <VerifiedBadgeIcon size={12} color="var(--accent-cyan)" />
                              </span>
                            ) : dataset.metadataTampered || dataset.metadataVerificationStatus === "tampered" ? (
                              <span data-verification-badge="tampered" title={t("evmMetadataTamperWarn")} style={{ display: "inline-flex", alignItems: "center" }}>
                                <AlertTriangleIcon size={12} color="var(--accent-rose)" />
                              </span>
                            ) : (
                              <span
                                data-verification-badge={dataset.metadataVerificationStatus || "unverified"}
                                title={dataset.metadataVerificationStatus === "unanchored" ? t("evmMetadataUnanchoredBadge") : t("evmMetadataUnverifiedBadge")}
                                style={{ display: "inline-flex", alignItems: "center" }}
                              >
                                <AlertTriangleIcon size={12} color="var(--accent-amber)" />
                              </span>
                            )}
                          </div>
                          <div className="activity-item-meta">
                            <span>#{String(ev.dataId).padStart(2, "0")}</span>
                            <span className="meta-sep">•</span>
                            <span>{dataset.geneSymbol?.split(" ")?.[0] || dataset.gene || dataset.chromosome || "N/A"}</span>
                            <span className="meta-sep">•</span>
                            <span>{dataset.format || "VCF v4.2"}</span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Price */}
                    <td>
                      <div className="activity-price-cell">
                        {ev.price === null || ev.price === undefined ? (
                          <span className="activity-price-num" style={{ color: "var(--text-muted)" }}>—</span>
                        ) : (
                          <>
                            <GenoTokenIcon size={14} color="var(--accent-cyan)" />
                            <span className="activity-price-num">{ev.price}</span>
                            <span className="activity-price-sym">$GENO</span>
                          </>
                        )}
                      </div>
                    </td>

                    {/* From */}
                    <td>
                      <div className="activity-address-cell">
                        <span className="mono-hash">
                          {!ev.from
                            ? "Registry"
                            : ev.from === "0x0000000000000000000000000000000000000000"
                              ? "Genesis / Mint"
                              : `${ev.from.substring(0, 6)}...${ev.from.substring(ev.from.length - 4)}`}
                        </span>
                        {ev.from && ev.from !== "0x0000000000000000000000000000000000000000" && (
                          <button
                            type="button"
                            className="icon-copy-btn"
                            onClick={() => copyText(ev.from, `from-${ev.id}`)}
                            title={t("ariaCopyAddress")}
                            aria-label={t("ariaCopyAddress")}
                          >
                            {copiedKey === `from-${ev.id}` ? (
                              <CheckCircleIcon size={11} color="var(--accent-emerald-text)" />
                            ) : (
                              <CopyIcon size={11} />
                            )}
                          </button>
                        )}
                      </div>
                    </td>

                    {/* To */}
                    <td>
                      {(() => {
                        const displayTo =
                          ev.to || (ev.subType === "escrow_resolved_release" ? dataset.owner || "" : "");
                        return (
                          <div className="activity-address-cell">
                            <span className="mono-hash">
                              {displayTo ? `${displayTo.substring(0, 6)}...${displayTo.substring(displayTo.length - 4)}` : "Registry"}
                            </span>
                            {displayTo && (
                              <button
                                type="button"
                                className="icon-copy-btn"
                                onClick={() => copyText(displayTo, `to-${ev.id}`)}
                                title={t("ariaCopyAddress")}
                                aria-label={t("ariaCopyAddress")}
                              >
                                {copiedKey === `to-${ev.id}` ? (
                                  <CheckCircleIcon size={11} color="var(--accent-emerald-text)" />
                                ) : (
                                  <CopyIcon size={11} />
                                )}
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    {/* Tx Hash */}
                    <td>
                      <div className="activity-tx-cell">
                        <span className="mono-hash" title={ev.txHash}>
                          {ev.txHash.substring(0, 8)}...{ev.txHash.substring(ev.txHash.length - 4)}
                        </span>
                        <button
                          type="button"
                          className="icon-copy-btn"
                          onClick={() => copyText(ev.txHash, `tx-${ev.id}`)}
                          title={t("ariaCopyTxHash")}
                          aria-label={t("ariaCopyTxHash")}
                        >
                          {copiedKey === `tx-${ev.id}` ? (
                            <CheckCircleIcon size={11} color="var(--accent-emerald-text)" />
                          ) : (
                            <CopyIcon size={11} />
                          )}
                        </button>
                      </div>
                    </td>

                    {/* Timestamp */}
                    <td style={{ textAlign: "right" }}>
                      <span className="activity-time-text">{formatRelativeTime(ev.timestampSec, lang)}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}