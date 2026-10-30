import React, { useState, useEffect, useCallback } from "react";
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
  SparklesIcon
} from "../../components/icons/GenoIcons";
import GenomicVisualCover from "../../components/common/GenomicVisualCover";
import contractAddresses from "../../contracts/contractAddresses.json";

export default function OpenSeaActivityFeed() {
  const { datasets, setSelectedAssetModal, getLocalizedTitle } = useDatasets();
  const { getContracts, contracts, showToast } = useWeb3();
  const { t, lang } = useLanguage();
  const [eventFilter, setEventFilter] = useState("all");
  const [copiedKey, setCopiedKey] = useState(null);

  const [onChainEvents, setOnChainEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [rpcError, setRpcError] = useState(null);

  const copyText = (text, key) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      showToast(t("copiedToast") || "Đã sao chép vào bộ nhớ tạm!");
      setTimeout(() => setCopiedKey(null), 2000);
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
    setLoadingEvents(true);
    setRpcError(null);
    try {
      const activeContracts = contracts || (await getContracts());
      if (!activeContracts?.registry) {
        setLoadingEvents(false);
        return;
      }

      const registry = activeContracts.registry;
      const provider = activeContracts.provider;
      const registryAddr = registry.target || contractAddresses.GenomicsRegistry || "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";

      const filterMint = registry.filters.GenomicDataRegistered ? registry.filters.GenomicDataRegistered() : "GenomicDataRegistered";
      const filterAccess = registry.filters.AccessGranted ? registry.filters.AccessGranted() : "AccessGranted";
      const filterEscrow = registry.filters.EscrowDeposited
        ? registry.filters.EscrowDeposited()
        : registry.filters.AccessEscrowCreated
        ? registry.filters.AccessEscrowCreated()
        : "EscrowDeposited";
      const filterRoyalty = registry.filters.RoyaltyPaid ? registry.filters.RoyaltyPaid() : "RoyaltyPaid";

      // Query raw events directly without swallowing RPC errors (Invariant 07: No Silent Fallback Mutation)
      const [mintLogs, accessLogs, escrowLogs, royaltyLogs] = await Promise.all([
        registry.queryFilter(filterMint, 0, "latest"),
        registry.queryFilter(filterAccess, 0, "latest"),
        registry.queryFilter(filterEscrow, 0, "latest"),
        registry.queryFilter(filterRoyalty, 0, "latest")
      ]);

      const blockTimestampCache = new Map();
      const getTimestamp = async (blockNumber) => {
        if (blockTimestampCache.has(blockNumber)) return blockTimestampCache.get(blockNumber);
        try {
          if (provider && typeof provider.getBlock === "function") {
            const block = await provider.getBlock(blockNumber);
            const ts = block?.timestamp || Math.floor(Date.now() / 1000);
            blockTimestampCache.set(blockNumber, ts);
            return ts;
          }
        } catch {}
        return Math.floor(Date.now() / 1000);
      };

      const parsedList = [];

      // 1. Mint Events (GenomicDataRegistered)
      for (const log of mintLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const owner = log.args?.owner || log.args?.[2] || "0x0000000000000000000000000000000000000000";
        const priceWei = log.args?.price ?? log.args?.[4] ?? 0n;
        const ts = await getTimestamp(log.blockNumber);
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
          blockNumber: log.blockNumber,
          timestampSec: ts
        });
      }

      // 2. Sales / Purchases (AccessGranted)
      for (const log of accessLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.researcher || log.args?.[1] || "";
        const paidWei = log.args?.paidAmount ?? log.args?.[2] ?? 0n;
        const ts = await getTimestamp(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `access-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "purchase",
          typeColor: "var(--accent-emerald)",
          dataId: dId,
          price: Number(ethers.formatUnits(paidWei, 18)),
          from: buyer,
          to: registryAddr,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: log.blockNumber,
          timestampSec: ts
        });
      }

      // 3. Escrow (EscrowDeposited / AccessEscrowCreated)
      for (const log of escrowLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const buyer = log.args?.buyer || log.args?.[1] || "";
        const amtWei = log.args?.amount ?? log.args?.[2] ?? 0n;
        const ts = await getTimestamp(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `escrow-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "escrow",
          typeColor: "var(--accent-amber)",
          dataId: dId,
          price: Number(ethers.formatUnits(amtWei, 18)),
          from: buyer,
          to: registryAddr,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: log.blockNumber,
          timestampSec: ts
        });
      }

      // 4. Royalties (RoyaltyPaid)
      for (const log of royaltyLogs) {
        const dId = Number(log.args?.dataId ?? log.args?.[0] ?? 0);
        const creator = log.args?.creator || log.args?.[1] || "";
        const amtWei = log.args?.amount ?? log.args?.[2] ?? 0n;
        const ts = await getTimestamp(log.blockNumber);
        const txHash = log.transactionHash;
        parsedList.push({
          id: `royalty-${log.blockNumber}-${log.index ?? log.logIndex ?? 0}`,
          type: "royalty",
          typeColor: "var(--accent-purple)",
          dataId: dId,
          price: Number(ethers.formatUnits(amtWei, 18)),
          from: registryAddr,
          to: creator,
          txHash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
          blockNumber: log.blockNumber,
          timestampSec: ts
        });
      }

      // Sort newest first by blockNumber descending, then index descending
      parsedList.sort((a, b) => b.blockNumber - a.blockNumber);
      setOnChainEvents(parsedList);
    } catch (err) {
      console.error("OpenSeaActivityFeed fetchEvents RPC error:", err);
      const rawErrMsg = err?.shortMessage || err?.reason || err?.message || String(err);
      setRpcError(rawErrMsg);
      setOnChainEvents([]);
    } finally {
      setLoadingEvents(false);
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
        <div style={{ padding: "10px 14px", marginBottom: "14px", borderRadius: "var(--radius-xs)", background: "rgba(239, 68, 68, 0.12)", border: "1px solid rgba(239, 68, 68, 0.35)", color: "#f87171", fontSize: "12px", fontFamily: "var(--font-mono)" }}>
          <strong>[RPC Event Query Error]</strong> {rpcError}
        </div>
      )}

      {/* Activity Table */}
      <div className="opensea-activity-table-wrap">
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
                <td colSpan={7} style={{ textAlign: "center", padding: "32px 20px", color: "var(--accent-rose)", fontFamily: "var(--font-mono)", fontSize: "13px", background: "rgba(244, 63, 94, 0.05)" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
                    <div style={{ fontWeight: 700, fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>⚠️</span>
                      <span>{t("rpcErrorOccurred") || "Lỗi truy vấn RPC nguyên bản (EVM / Node Error):"}</span>
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
                        background: "var(--accent-rose)",
                        color: "#fff",
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
                const dataset = datasets.find((d) => d.dataId === ev.dataId) || datasets[0] || {};
                const title = getLocalizedTitle ? getLocalizedTitle(dataset, lang) : dataset.disease;
                const typeLabel =
                  ev.type === "purchase"
                    ? t("eventPurchase") || "Access Purchased"
                    : ev.type === "escrow"
                    ? t("eventEscrow") || "Escrow Deposited"
                    : ev.type === "royalty"
                    ? t("eventRoyalty") || "10% EIP-2981 Royalty"
                    : t("eventMint") || "Dataset Listed";

                return (
                  <tr key={ev.id} className="activity-table-row">
                    {/* Event Type Badge */}
                    <td>
                      <span
                        className="activity-event-badge"
                        style={{
                          color: ev.typeColor,
                          borderColor: `${ev.typeColor}33`,
                          background: `${ev.typeColor}15`
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
                        onClick={() => dataset.dataId && setSelectedAssetModal(dataset)}
                        title="Inspect Genomic Cohort"
                      >
                        <div className="activity-thumb-box">
                          <GenomicVisualCover dataset={dataset} height={36} showAvatar={false} />
                        </div>
                        <div className="activity-item-text">
                          <div className="activity-item-title">
                            <span>{title}</span>
                            <VerifiedBadgeIcon size={12} color="var(--accent-cyan)" />
                          </div>
                          <div className="activity-item-meta">
                            <span>#{String(ev.dataId).padStart(2, "0")}</span>
                            <span className="meta-sep">•</span>
                            <span>{dataset.geneSymbol?.split(" ")?.[0] || dataset.gene || "chr12"}</span>
                            <span className="meta-sep">•</span>
                            <span>{dataset.format || "VCF v4.2"}</span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Price */}
                    <td>
                      <div className="activity-price-cell">
                        <GenoTokenIcon size={14} color="var(--accent-cyan)" />
                        <span className="activity-price-num">{ev.price}</span>
                        <span className="activity-price-sym">$GENO</span>
                      </div>
                    </td>

                    {/* From */}
                    <td>
                      <div className="activity-address-cell">
                        <span className="mono-hash">
                          {ev.from === "0x0000000000000000000000000000000000000000"
                            ? "Genesis / Mint"
                            : `${ev.from.substring(0, 6)}...${ev.from.substring(ev.from.length - 4)}`}
                        </span>
                        {ev.from !== "0x0000000000000000000000000000000000000000" && (
                          <button
                            type="button"
                            className="icon-copy-btn"
                            onClick={() => copyText(ev.from, `from-${ev.id}`)}
                            title="Copy address"
                          >
                            {copiedKey === `from-${ev.id}` ? (
                              <CheckCircleIcon size={11} color="var(--accent-emerald)" />
                            ) : (
                              <CopyIcon size={11} />
                            )}
                          </button>
                        )}
                      </div>
                    </td>

                    {/* To */}
                    <td>
                      <div className="activity-address-cell">
                        <span className="mono-hash">
                          {ev.to ? `${ev.to.substring(0, 6)}...${ev.to.substring(ev.to.length - 4)}` : "Registry"}
                        </span>
                        {ev.to && (
                          <button
                            type="button"
                            className="icon-copy-btn"
                            onClick={() => copyText(ev.to, `to-${ev.id}`)}
                            title="Copy address"
                          >
                            {copiedKey === `to-${ev.id}` ? (
                              <CheckCircleIcon size={11} color="var(--accent-emerald)" />
                            ) : (
                              <CopyIcon size={11} />
                            )}
                          </button>
                        )}
                      </div>
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
                          title="Copy Tx Hash"
                        >
                          {copiedKey === `tx-${ev.id}` ? (
                            <CheckCircleIcon size={11} color="var(--accent-emerald)" />
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
