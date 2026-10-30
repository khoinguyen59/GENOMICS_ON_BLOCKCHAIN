import React, { useState } from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import {
  InMemoryDecryptIcon,
  VerifiedBadgeIcon,
  GenoLogoIcon,
  SealedCipherIcon
} from "../../components/icons/GenoIcons";

const sanitizeFileName = (name) => (!name ? "Genomic_Data" : name.replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_"));

export default function LicensedDatasetsView({ onDecrypt, onDownload, onDownloadPdf, onClaimRefund }) {
  const { setResearcherTab } = useWeb3();
  const { purchasedData, getLocalizedTitle } = useDatasets();
  const { t, language } = useLanguage();
  const [activePreviewTab, setActivePreviewTab] = useState({});

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
                        color: "var(--text-muted)"
                      }}
                    >
                      {t("cohortPrefix")}{item.dataId} • {item.format || "VCF v4.2"} • {item.ancestry || item.region || "Global"}
                    </span>
                    <span className="vault-status-active">
                      <VerifiedBadgeIcon size={12} color="#10b981" />
                      <span>{t("btnPurchased")}</span>
                    </span>
                  </div>

                  <div style={{ marginTop: "12px" }}>
                    <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
                      {getLocalizedTitle ? getLocalizedTitle(item, language) : item.disease}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "13px",
                        color: "#38bdf8",
                        marginTop: "3px"
                      }}
                    >
                      Target: {item.gene}
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                      {t("licenseDurationLabel")} {item.durationDays} {t("durationDays")} • {t("ipfsCidLabel")}{" "}
                      {item.rawCid ? item.rawCid.substring(0, 10) : "N/A"}...
                    </div>
                  </div>
                </div>

                {/* Escrow Dispute & Timelock Status Box */}
                {item.escrowInfo?.isPending && (
                  <div
                    style={{
                      marginTop: "12px",
                      padding: "10px 12px",
                      background: item.escrowInfo.canRefund ? "rgba(239, 68, 68, 0.12)" : "rgba(16, 185, 129, 0.08)",
                      border: `1px solid ${item.escrowInfo.canRefund ? "rgba(239, 68, 68, 0.35)" : "rgba(16, 185, 129, 0.3)"}`,
                      borderRadius: "var(--radius-xs)",
                      fontSize: "11px",
                      fontFamily: "var(--font-mono)"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ color: item.escrowInfo.canRefund ? "#ef4444" : "#10b981", fontWeight: 700 }}>
                        {item.escrowInfo.canRefund ? "⚠ " + t("escrowRefundEligible") : "🔒 " + t("escrowStatusActive")}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>{item.escrowInfo.amount} GENO</span>
                    </div>
                    <div style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                      {t("escrowDeadlineLabel")} {new Date(item.escrowInfo.deadline * 1000).toLocaleString()}
                    </div>
                    {item.escrowInfo.canRefund && (
                      <button
                        className="btn-terminal btn-terminal-danger"
                        style={{
                          width: "100%",
                          height: "32px",
                          marginTop: "8px",
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
                )}

                <div style={{ marginTop: "18px" }}>
                  {!item.decryptedContent ? (
                    (item.isEscrowPending || item.escrowInfo?.isPending) ? (
                      <div
                        style={{
                          width: "100%",
                          padding: "10px",
                          textAlign: "center",
                          borderRadius: "var(--radius-xs)",
                          background: "rgba(245, 158, 11, 0.12)",
                          border: "1px dashed rgba(245, 158, 11, 0.4)",
                          color: "#fbbf24",
                          fontSize: "12px",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "6px"
                        }}
                      >
                        <SealedCipherIcon size={14} color="#fbbf24" />
                        <span>{t("escrowPendingDelivery") || "Đang Chờ Người Bán Giao Khóa (Escrow Pending)"}</span>
                      </div>
                    ) : (
                      <button
                        className="btn-terminal btn-terminal-success"
                        style={{ width: "100%", height: "38px", justifyContent: "center", fontSize: "13px" }}
                        disabled={item.escrowInfo?.isPending}
                        onClick={() => onDecrypt?.(item.dataId)}
                        type="button"
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
                              border: "1px solid #38bdf8",
                              color: "#38bdf8",
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
                              border: "1px solid #10b981",
                              color: "#10b981",
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
                          gap: "6px",
                          marginBottom: "6px",
                          borderBottom: "1px solid var(--border-subtle)",
                          paddingBottom: "4px"
                        }}
                      >
                        <button
                          className={`btn-terminal ${currentTab === "vcf" ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                          style={{ padding: "2px 8px", fontSize: "11px", height: "24px" }}
                          onClick={() => setTab(item.dataId, "vcf")}
                          type="button"
                        >
                          <span>{t("tabPreviewVcf")}</span>
                        </button>
                        {item.phenopacketJson && (
                          <button
                            className={`btn-terminal ${currentTab === "json" ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                            style={{ padding: "2px 8px", fontSize: "11px", height: "24px" }}
                            onClick={() => setTab(item.dataId, "json")}
                            type="button"
                          >
                            <span>{t("tabPreviewPhenopacket")}</span>
                          </button>
                        )}
                        {item.decryptedPdfBytes && (
                          <button
                            className={`btn-terminal ${currentTab === "pdf" ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                            style={{ padding: "2px 8px", fontSize: "11px", height: "24px" }}
                            onClick={() => setTab(item.dataId, "pdf")}
                            type="button"
                          >
                            <span>{t("tabPreviewPdf")}</span>
                          </button>
                        )}
                      </div>

                      {currentTab === "vcf" && (
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
                          {item.decryptedContent}
                        </pre>
                      )}

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
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
