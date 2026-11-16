import React, { useState } from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import {
  InMemoryDecryptIcon,
  VerifiedBadgeIcon,
  GenoLogoIcon,
  SealedCipherIcon,
  RefreshSpinIcon,
  AlertTriangleIcon,
  LockClosedIcon
} from "../../components/icons/GenoIcons";

const sanitizeFileName = (name) => (!name ? "Genomic_Data" : name.replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_"));

const MAX_PREVIEW_BYTES = 50 * 1024; // 50KB preview cap for browser DOM performance
const MAX_PREVIEW_LINES = 1000;

function formatDecryptedPreview(rawContent) {
  if (!rawContent || typeof rawContent !== "string") {
    return { previewText: "", isTruncated: false, totalBytes: 0, totalLines: 0 };
  }
  const totalBytes = new TextEncoder().encode(rawContent).length;
  const lines = rawContent.split("\n");
  const totalLines = lines.length;

  let isTruncated = false;
  let truncatedLines = lines;
  if (lines.length > MAX_PREVIEW_LINES) {
    truncatedLines = lines.slice(0, MAX_PREVIEW_LINES);
    isTruncated = true;
  }
  let joined = truncatedLines.join("\n");
  if (joined.length > MAX_PREVIEW_BYTES) {
    joined = joined.slice(0, MAX_PREVIEW_BYTES);
    isTruncated = true;
  } else if (totalBytes > MAX_PREVIEW_BYTES) {
    isTruncated = true;
  }

  return { previewText: joined, isTruncated, totalBytes, totalLines };
}

export default function LicensedDatasetsView({
  onDecrypt,
  onDownload,
  onDownloadPdf,
  onClaimRefund,
  onRecordStudyReuse,
  onConfirmEscrow,
  onDisputeCapsule,
  onSetManualEscrow
}) {
  const { setResearcherTab, showToast, account, getContracts } = useWeb3();
  const {
    purchasedData,
    getLocalizedTitle,
    confirmCapsuleAndReleaseEscrow,
    disputeCapsule,
    setManualEscrowRelease,
    fetchOnChainDatasets
  } = useDatasets();
  const { t, language } = useLanguage();
  const [activePreviewTab, setActivePreviewTab] = useState({});
  const [reuseInputs, setReuseInputs] = useState({});
  const [busyReuseId, setBusyReuseId] = useState(null);
  const [busyEscrowId, setBusyEscrowId] = useState(null);

  const handleConfirmEscrow = async (dataId) => {
    try {
      setBusyEscrowId(dataId);
      showToast?.(t("escrowConfirming") || `Confirming escrow release for dataset #${dataId}...`, "info");
      if (onConfirmEscrow) {
        await onConfirmEscrow(dataId);
      } else if (confirmCapsuleAndReleaseEscrow) {
        await confirmCapsuleAndReleaseEscrow(dataId);
      } else {
        const { registry } = await getContracts();
        const tx = await registry.confirmCapsuleAndReleaseEscrow(dataId);
        await tx.wait();
        await fetchOnChainDatasets?.(account);
      }
      showToast?.(t("escrowConfirmedSuccess") || "Escrow released successfully to seller!");
    } catch (err) {
      showToast?.((err.shortMessage || err.message), "error");
    } finally {
      setBusyEscrowId(null);
    }
  };

  const handleDisputeCapsule = async (dataId) => {
    try {
      setBusyEscrowId(dataId);
      showToast?.(t("escrowDisputing") || `Disputing escrow delivery for dataset #${dataId}...`, "info");
      if (onDisputeCapsule) {
        await onDisputeCapsule(dataId);
      } else if (disputeCapsule) {
        await disputeCapsule(dataId);
      } else {
        const { registry } = await getContracts();
        const tx = await registry.disputeCapsule(dataId);
        await tx.wait();
        await fetchOnChainDatasets?.(account);
      }
      showToast?.(t("escrowDisputedSuccess") || "Dispute submitted! Escrow is now frozen pending admin arbitration.");
    } catch (err) {
      showToast?.((err.shortMessage || err.message), "error");
    } finally {
      setBusyEscrowId(null);
    }
  };

  const handleToggleManualEscrow = async (dataId, currentManual) => {
    try {
      setBusyEscrowId(dataId);
      const nextManual = !currentManual;
      if (onSetManualEscrow) {
        await onSetManualEscrow(dataId, nextManual);
      } else if (setManualEscrowRelease) {
        await setManualEscrowRelease(dataId, nextManual);
      } else {
        const { registry } = await getContracts();
        const tx = await registry.setManualEscrowRelease(dataId, nextManual);
        await tx.wait();
        await fetchOnChainDatasets?.(account);
      }
      showToast?.(nextManual ? (t("escrowManualEnabled") || "Manual escrow release enabled") : (t("escrowManualDisabled") || "Manual escrow release disabled"));
    } catch (err) {
      showToast?.((err.shortMessage || err.message), "error");
    } finally {
      setBusyEscrowId(null);
    }
  };

  const handleTriggerReuse = async (dataId) => {
    setBusyReuseId(dataId);
    try {
      const label = reuseInputs[dataId]?.trim() || `GWAS_STUDY_${dataId}_${Date.now()}`;
      await onRecordStudyReuse?.(dataId, label);
    } finally {
      setBusyReuseId(null);
    }
  };

  const setTab = (dataId, tab) => {
    setActivePreviewTab((prev) => ({ ...prev, [dataId]: tab }));
  };

  const handleDownloadJson = (jsonObj, filename) => {
    const jsonStr = JSON.stringify(jsonObj, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sanitizeFileName(filename);
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="vault-section-title">
        <InMemoryDecryptIcon size={18} color="#10b981" />
        <span style={{ fontSize: "14px", fontWeight: 700 }}>
          {t("licensedTitle")} ({purchasedData.length})
        </span>
      </div>

      {purchasedData.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "48px 24px",
            background: "var(--bg-surface)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-strong)"
          }}
        >
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: "14px",
              marginBottom: "16px",
              fontFamily: "var(--font-mono)"
            }}
          >
            {t("licensedEmpty")}
          </p>
          <button
            className="btn-terminal btn-terminal-primary"
            style={{ height: "36px", padding: "0 16px", fontSize: "13px" }}
            onClick={() => setResearcherTab("catalog")}
            type="button"
          >
            {t("btnBrowseCatalog")}
          </button>
        </div>
      ) : (
        <div className="vault-grid">
          {purchasedData.map((item) => {
            const currentTab = activePreviewTab[item.dataId] || "vcf";

            return (
              <div key={item.dataId} className="vault-card">
                <div>
                  <div className="vault-card-header">
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        color: "var(--text-secondary)"
                      }}
                    >
                      {t("cohortPrefix")}{item.dataId} • {item.format || "VCF v4.2"} • {item.ancestry || item.region || "Global"}
                    </span>
                    {item.isEscrowPending || item.escrowInfo?.isPending ? (
                      <span
                        className="vault-status-active"
                        style={{
                          color: item.escrowInfo?.isDisputed ? "var(--accent-rose-text)" : item.escrowInfo?.capsuleDelivered ? "var(--accent-emerald-text)" : "var(--accent-amber-text)",
                          borderColor: item.escrowInfo?.isDisputed ? "rgba(239, 68, 68, 0.35)" : item.escrowInfo?.capsuleDelivered ? "rgba(16, 185, 129, 0.35)" : "rgba(245, 158, 11, 0.35)",
                          background: item.escrowInfo?.isDisputed ? "rgba(239, 68, 68, 0.12)" : item.escrowInfo?.capsuleDelivered ? "rgba(16, 185, 129, 0.12)" : "rgba(245, 158, 11, 0.12)",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {item.escrowInfo?.isDisputed ? (
                          <>
                            <AlertTriangleIcon size={12} color="var(--accent-rose-text)" />
                            <span>{t("escrowStatusDisputed") || "Ký Quỹ Đang Khiếu Nại"}</span>
                          </>
                        ) : item.escrowInfo?.capsuleDelivered ? (
                          <>
                            <VerifiedBadgeIcon size={12} color="var(--accent-emerald-text)" />
                            <span>{t("escrowStatusDelivered") || "Khóa Đã Giao (Chờ Xác Nhận)"}</span>
                          </>
                        ) : (
                          <>
                            <RefreshSpinIcon size={12} />
                            <span>{t("escrowPendingDelivery")}</span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="vault-status-active" style={{ whiteSpace: "nowrap" }}>
                        <VerifiedBadgeIcon size={12} color="var(--accent-emerald-text)" />
                        <span>{t("btnPurchased")}</span>
                      </span>
                    )}
                  </div>

                  <div style={{ marginTop: "12px" }}>
                    <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
                      {getLocalizedTitle ? getLocalizedTitle(item, language) : item.disease}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "13px",
                        color: "var(--accent-cyan)",
                        marginTop: "3px"
                      }}
                    >
                      {t("licensedTargetLabel")} {item.gene}
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
                      {t("licenseDurationLabel")} {item.durationDays} {t("durationDays")} • {t("ipfsCidLabel")}{" "}
                      {item.rawCid ? item.rawCid.substring(0, 10) : "N/A"}...
                      {item.expiryLabel ? (
                        <span style={{ marginLeft: "6px", color: "var(--accent-cyan)", fontFamily: "var(--font-mono)" }}>
                          • {item.expiryLabel}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--accent-emerald-text)", marginTop: "4px" }}>
                      {item.artifactHashCount || 1}/3 {t("licensedArtifactHashes")} • {t("licensedReusesLabel")} {item.reuseCount || 0} • 5% {language === "vi" ? "Phí" : "Fee"}:{" "}
                      {item.reuseFeeGeno ?? Number(((item.price || 0) * 0.05).toFixed(4))} $GENO
                    </div>
                  </div>
                </div>

                {/* Escrow Dispute & Timelock Status Box */}
                {item.escrowInfo?.isPending && (
                  <div
                    style={{
                      marginTop: "12px",
                      padding: "10px 12px",
                      background: item.escrowInfo.isDisputed
                        ? "rgba(239, 68, 68, 0.15)"
                        : item.escrowInfo.capsuleDelivered
                        ? "rgba(16, 185, 129, 0.12)"
                        : item.escrowInfo.canRefund
                        ? "rgba(239, 68, 68, 0.12)"
                        : "rgba(245, 158, 11, 0.08)",
                      border: `1px solid ${
                        item.escrowInfo.isDisputed
                          ? "rgba(239, 68, 68, 0.45)"
                          : item.escrowInfo.capsuleDelivered
                          ? "rgba(16, 185, 129, 0.35)"
                          : item.escrowInfo.canRefund
                          ? "rgba(239, 68, 68, 0.35)"
                          : "rgba(245, 158, 11, 0.3)"
                      }`,
                      borderRadius: "var(--radius-xs)",
                      fontSize: "11px",
                      fontFamily: "var(--font-mono)"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          color:
                            item.escrowInfo.isDisputed || item.escrowInfo.canRefund
                              ? "var(--accent-rose-text)"
                              : item.escrowInfo.capsuleDelivered
                              ? "var(--accent-emerald-text)"
                              : "var(--accent-amber-text)",
                          fontWeight: 700
                        }}
                      >
                        {item.escrowInfo.isDisputed ? (
                          <>
                            <AlertTriangleIcon size={12} color="var(--accent-rose-text)" />
                            <span>{t("escrowStatusDisputed") || "Ký quỹ đang bị khiếu nại"}</span>
                          </>
                        ) : item.escrowInfo.capsuleDelivered ? (
                          <>
                            <VerifiedBadgeIcon size={12} color="var(--accent-emerald-text)" />
                            <span>{t("escrowStatusDelivered") || "Khóa đã giao - Chờ xác nhận hoặc khiếu nại"}</span>
                          </>
                        ) : item.escrowInfo.canRefund ? (
                          <>
                            <AlertTriangleIcon size={12} color="var(--accent-rose-text)" />
                            <span>{t("escrowRefundEligible")}</span>
                          </>
                        ) : (
                          <>
                            <LockClosedIcon size={12} color="var(--accent-amber-text)" />
                            <span>{t("escrowStatusActive")}</span>
                          </>
                        )}
                      </span>
                      <span style={{ color: "var(--text-secondary)" }}>{item.escrowInfo.amount} GENO</span>
                    </div>

                    <div style={{ color: "var(--text-secondary)", marginTop: "4px" }}>
                      {t("escrowDeadlineLabel")} {new Date(item.escrowInfo.deadline * 1000).toLocaleString()}
                    </div>

                    {/* Escrow Action Buttons */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" }}>
                      {/* If capsule is delivered and escrow pending: Buyer can Confirm to release or Dispute */}
                      {item.escrowInfo.capsuleDelivered && !item.escrowInfo.released && (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            id={`btn-confirm-escrow-${item.dataId}`}
                            className="btn-terminal btn-terminal-success"
                            style={{ flex: 1, height: "32px", fontSize: "11px", justifyContent: "center" }}
                            onClick={() => handleConfirmEscrow(item.dataId)}
                            disabled={busyEscrowId === item.dataId}
                            type="button"
                          >
                            <span>{busyEscrowId === item.dataId ? "..." : (t("btnConfirmEscrowRelease") || "Xác nhận & Giải phóng")}</span>
                          </button>
                          <button
                            id={`btn-dispute-escrow-${item.dataId}`}
                            className="btn-terminal btn-terminal-danger"
                            style={{ flex: 1, height: "32px", fontSize: "11px", justifyContent: "center", background: "#b91c1c", borderColor: "#991b1b", color: "#ffffff" }}
                            onClick={() => handleDisputeCapsule(item.dataId)}
                            disabled={busyEscrowId === item.dataId || item.escrowInfo.isDisputed}
                            type="button"
                          >
                            <span>{item.escrowInfo.isDisputed ? (t("escrowDisputedActive") || "Đã khiếu nại") : (t("btnDisputeCapsule") || "Khiếu nại khóa")}</span>
                          </button>
                        </div>
                      )}

                      {/* Manual Escrow Toggle */}
                      <button
                        id={`btn-toggle-manual-${item.dataId}`}
                        className="btn-terminal btn-terminal-ghost"
                        style={{ width: "100%", height: "28px", fontSize: "11px", justifyContent: "center" }}
                        onClick={() => handleToggleManualEscrow(item.dataId, item.escrowInfo.isManual)}
                        disabled={busyEscrowId === item.dataId}
                        type="button"
                      >
                        <span>
                          {item.escrowInfo.isManual
                            ? (t("escrowManualActive") || "Ký quỹ thủ công: ĐANG BẬT (Bấm để tắt)")
                            : (t("btnToggleManualEscrow") || "Bật chế độ giải phóng ký quỹ thủ công")}
                        </span>
                      </button>

                      {/* 100% Refund Button */}
                      {item.escrowInfo.canRefund && (
                        <button
                          id={`btn-claim-refund-${item.dataId}`}
                          className="btn-terminal btn-terminal-danger"
                          style={{
                            width: "100%",
                            height: "32px",
                            justifyContent: "center",
                            fontSize: "12px",
                            background: "#dc2626",
                            color: "#ffffff"
                          }}
                          onClick={() => onClaimRefund?.(item.dataId)}
                          type="button"
                        >
                          <span>{t("btnClaimRefund")}</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: "18px" }}>
                  {!item.decryptedContent ? (
                    (!item.escrowInfo?.capsuleDelivered && (item.isEscrowPending || item.escrowInfo?.isPending)) ? (
                      <div
                        style={{
                          width: "100%",
                          padding: "10px",
                          textAlign: "center",
                          borderRadius: "var(--radius-xs)",
                          background: "rgba(245, 158, 11, 0.12)",
                          border: "1px dashed rgba(245, 158, 11, 0.45)",
                          color: "var(--accent-amber-text)",
                          fontSize: "12px",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "6px"
                        }}
                      >
                        <SealedCipherIcon size={14} color="var(--accent-amber-text)" />
                        <span>{t("escrowPendingDelivery")}</span>
                      </div>
                    ) : (
                      <button
                        id={`btn-decrypt-dataset-${item.dataId}`}
                        type="button"
                        className="btn-terminal btn-terminal-success"
                        title={t("btnDecryptPayload")}
                        style={{ width: "100%", height: "38px", justifyContent: "center", fontSize: "13px" }}
                        disabled={item.escrowInfo?.isPending && !item.escrowInfo?.capsuleDelivered}
                        onClick={() => onDecrypt?.(item.dataId)}
                      >
                        <InMemoryDecryptIcon size={15} />
                        <span>{t("btnDecryptPayload")}</span>
                      </button>
                    )
                  ) : (
                    <div>
                      {/* Action Download Buttons */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
                        <button
                          className="btn-terminal btn-terminal-primary"
                          style={{ width: "100%", height: "34px", justifyContent: "center", fontSize: "12px" }}
                          onClick={() =>
                            onDownload?.(
                              item.decryptedContent,
                              `${sanitizeFileName(item.geneSymbol || item.gene.split(" ")[0])}.vcf`
                            )
                          }
                          type="button"
                        >
                          <span>{t("btnDownloadVcf")}</span>
                        </button>

                        {item.decryptedPdfBytes && (
                          <button
                            className="btn-terminal btn-terminal-ghost"
                            style={{
                              width: "100%",
                              height: "34px",
                              justifyContent: "center",
                              fontSize: "12px"
                            }}
                            onClick={() =>
                              onDownloadPdf?.(
                                item.decryptedPdfBytes,
                                `${sanitizeFileName(item.geneSymbol || "Cohort")}_Genomic_Report.pdf`
                              )
                            }
                            type="button"
                          >
                            <span>{t("btnDownloadPdf")}</span>
                          </button>
                        )}

                        {item.phenopacketJson && (
                          <button
                            className="btn-terminal btn-terminal-ghost"
                            style={{
                              width: "100%",
                              height: "34px",
                              justifyContent: "center",
                              fontSize: "12px"
                            }}
                            onClick={() =>
                              handleDownloadJson(
                                item.phenopacketJson,
                                `${item.geneSymbol || "Cohort"}_phenopacket_v2.json`
                              )
                            }
                            type="button"
                          >
                            <span>{t("btnDownloadJson")}</span>
                          </button>
                        )}
                      </div>

                      <div
                        style={{
                          fontSize: "11px",
                          color: "var(--accent-emerald-text)",
                          fontFamily: "var(--font-mono)",
                          marginBottom: "6px"
                        }}
                      >
                        {t("shaAnchorVerified")} ({item.rawDataHash ? item.rawDataHash.substring(0, 10) : ""}...)
                      </div>

                      {/* Preview Switcher */}
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "6px",
                          marginBottom: "8px",
                          borderBottom: "1px solid var(--border-subtle)",
                          paddingBottom: "6px"
                        }}
                      >
                        <button
                          className={`btn-terminal ${currentTab === "vcf" ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                          style={{ padding: "3px 10px", fontSize: "11px", height: "26px", whiteSpace: "nowrap" }}
                          onClick={() => setTab(item.dataId, "vcf")}
                          type="button"
                        >
                          <span>{t("tabPreviewVcf")}</span>
                        </button>
                        {item.phenopacketJson && (
                          <button
                            className={`btn-terminal ${currentTab === "json" ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                            style={{ padding: "3px 10px", fontSize: "11px", height: "26px", whiteSpace: "nowrap" }}
                            onClick={() => setTab(item.dataId, "json")}
                            type="button"
                          >
                            <span>{t("tabPreviewPhenopacket")}</span>
                          </button>
                        )}
                        {item.decryptedPdfBytes && (
                          <button
                            className={`btn-terminal ${currentTab === "pdf" ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                            style={{ padding: "3px 10px", fontSize: "11px", height: "26px", whiteSpace: "nowrap" }}
                            onClick={() => setTab(item.dataId, "pdf")}
                            type="button"
                          >
                            <span>{t("tabPreviewPdf")}</span>
                          </button>
                        )}
                      </div>

                      {currentTab === "vcf" && (() => {
                        const { previewText, isTruncated, totalBytes, totalLines } = formatDecryptedPreview(item.decryptedContent);
                        return (
                          <div>
                            {isTruncated && (
                              <div
                                style={{
                                  marginBottom: "8px",
                                  padding: "8px 12px",
                                  background: "rgba(56, 189, 248, 0.1)",
                                  border: "1px solid rgba(56, 189, 248, 0.35)",
                                  borderRadius: "var(--radius-xs)",
                                  fontSize: "11px",
                                  fontFamily: "var(--font-mono)",
                                  color: "var(--accent-cyan)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "8px",
                                  flexWrap: "wrap"
                                }}
                              >
                                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                  <AlertTriangleIcon size={13} color="var(--accent-cyan)" />
                                  <span>
                                    {t("previewTruncated") || (language === "vi"
                                      ? `Bản xem trước được rút gọn (hiển thị 50KB / 1000 dòng đầu tiên của ${totalBytes.toLocaleString()} bytes, ${totalLines.toLocaleString()} dòng) — Tải toàn bộ tệp bên dưới`
                                      : `Preview truncated (showing first 50KB / 1000 lines of ${totalBytes.toLocaleString()} bytes, ${totalLines.toLocaleString()} lines) — Download full file below`)}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  className="btn-terminal btn-terminal-primary"
                                  style={{ height: "26px", fontSize: "11px", padding: "0 10px", whiteSpace: "nowrap" }}
                                  onClick={() =>
                                    onDownload?.(
                                      item.decryptedContent,
                                      `${sanitizeFileName(item.geneSymbol || item.gene?.split(" ")[0] || "dataset")}.vcf`
                                    )
                                  }
                                >
                                  <span>{t("btnDownloadFullFile") || (language === "vi" ? "Tải toàn bộ tệp" : "Download Full File")}</span>
                                </button>
                              </div>
                            )}
                            <pre
                              style={{
                                maxHeight: "140px",
                                overflowY: "auto",
                                background: "var(--bg-input)",
                                border: "1px solid var(--border-subtle)",
                                padding: "10px",
                                borderRadius: "var(--radius-xs)",
                                fontFamily: "var(--font-mono)",
                                fontSize: "11px",
                                color: "var(--text-primary)"
                              }}
                            >
                              {previewText}
                            </pre>
                          </div>
                        );
                      })()}

                      {currentTab === "json" && item.phenopacketJson && (
                        <pre
                          style={{
                            maxHeight: "140px",
                            overflowY: "auto",
                            background: "var(--bg-input)",
                            border: "1px solid var(--border-subtle)",
                            padding: "10px",
                            borderRadius: "var(--radius-xs)",
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            color: "var(--accent-emerald-text)"
                          }}
                        >
                          {JSON.stringify(item.phenopacketJson, null, 2)}
                        </pre>
                      )}

                      {currentTab === "pdf" && item.decryptedPdfBytes && (
                        <div
                          style={{
                            padding: "12px",
                            background: "var(--bg-input)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--radius-xs)",
                            fontSize: "12px",
                            fontFamily: "var(--font-mono)",
                            color: "var(--accent-cyan)"
                          }}
                        >
                          <div>{t("pdfClinicalFormat")}</div>
                          <div>{t("pdfDecryptedSize")} {item.decryptedPdfBytes.length.toLocaleString()} bytes</div>
                          <div style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                            {t("verifiedZeroDisk")}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Secondary Study Reuse 5% Royalty Payment Panel */}
                  {!item.isOwner && !item.isEscrowPending && item.hasActiveAccess && (
                    <div
                      id={`reuse-study-box-${item.dataId}`}
                      style={{
                        marginTop: "12px",
                        padding: "10px 12px",
                        borderRadius: "var(--radius-xs)",
                        border: "1px solid var(--border-subtle)",
                        background: "var(--bg-input)"
                      }}
                    >
                      <div style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--text-primary)", marginBottom: "6px" }}>
                        {t("reuseSectionTitle")} ({item.reuseFeeGeno ?? Number(((item.price || 0) * 0.05).toFixed(4))} $GENO)
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <input
                          id={`input-reuse-study-${item.dataId}`}
                          type="text"
                          className="field-input"
                          style={{ flex: 1, height: "34px", fontSize: "12px" }}
                          placeholder={t("licensedReusePlaceholder")}
                          aria-label={t("reuseStudyLabel")}
                          value={reuseInputs[item.dataId] || ""}
                          onChange={(e) => setReuseInputs((prev) => ({ ...prev, [item.dataId]: e.target.value }))}
                        />
                        <button
                          id={`btn-record-reuse-${item.dataId}`}
                          type="button"
                          className="btn-terminal btn-terminal-primary"
                          style={{ height: "34px", padding: "0 12px", fontSize: "12px", flexShrink: 0, whiteSpace: "nowrap" }}
                          title={t("reuseRecordBtn")}
                          disabled={busyReuseId === item.dataId}
                          onClick={() => handleTriggerReuse(item.dataId)}
                        >
                          <span>{busyReuseId === item.dataId ? "..." : t("reuseRecordBtn")}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
