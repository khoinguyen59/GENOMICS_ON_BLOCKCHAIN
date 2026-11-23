import React from "react";
import { useLanguage } from "../../context/LanguageContext";
import {
  DataOwnerShieldIcon,
  CpuChipIcon,
  NetworkMeshIcon,
  DatabaseNodesIcon
} from "../../components/icons/GenoIcons";

export default function LiveTransmissionAudit({ liveTransmissionAudit, rawFileText, royaltyBps = 1000 }) {
  const { t } = useLanguage();
  if (!liveTransmissionAudit) return null;
  const royaltyPct = Number(((Number(royaltyBps ?? 1000)) / 100).toFixed(2));

  return (
    <div className="transmission-audit-card">
      <div className="audit-card-title">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <DataOwnerShieldIcon size={16} color="var(--accent-emerald)" />
          <span>{t("privacyAuditTitle")}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {liveTransmissionAudit.previewSliceBytes > 0 && (
            <span
              id="audit-preview-slice-badge"
              style={{
                fontSize: "10.5px",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                padding: "3px 8px",
                borderRadius: "var(--radius-sm)",
                background: "rgba(245, 158, 11, 0.14)",
                color: "var(--accent-amber-text)",
                border: "1px solid rgba(245, 158, 11, 0.35)"
              }}
              title={liveTransmissionAudit.status || ""}
            >
              {t("auditPreviewSliceBadge")}
            </span>
          )}
          <span className="audit-chip-live">{t("auditLiveChip")}</span>
        </div>
      </div>

      {liveTransmissionAudit.previewSliceBytes > 0 && (
        <div
          id="audit-preview-slice-details"
          style={{
            marginBottom: "10px",
            padding: "8px 12px",
            borderRadius: "var(--radius-xs)",
            background: "var(--bg-input)",
            border: "1px solid rgba(245, 158, 11, 0.35)",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "var(--text-secondary)",
            display: "flex",
            flexDirection: "column",
            gap: "4px"
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
            <span>
              <strong style={{ color: "var(--accent-amber-text)" }}>{t("auditPreviewSliceLabel")}</strong>{" "}
              {Number(liveTransmissionAudit.previewSliceBytes).toLocaleString()} bytes (~{Math.round(liveTransmissionAudit.previewSliceBytes / 1024)} KB)
            </span>
            <span>
              <strong style={{ color: "var(--accent-emerald-text)" }}>{t("auditFullFileOnSubmitLabel")}</strong>{" "}
              {Number(liveTransmissionAudit.plaintextSizeInRam || 0).toLocaleString()} bytes ({(Number(liveTransmissionAudit.plaintextSizeInRam || 0) / (1024 * 1024)).toFixed(2)} MB)
            </span>
          </div>
          {liveTransmissionAudit.status && (
            <div style={{ color: "var(--text-muted)", fontSize: "10.5px" }}>
              {liveTransmissionAudit.status}
            </div>
          )}
        </div>
      )}

      <div className="audit-row">
        <div className="audit-box memory-box">
          <div className="audit-box-header">
            <CpuChipIcon size={14} color="var(--accent-cyan)" />
            <span>{t("auditMemoryHeader")}</span>
          </div>
          <div className="audit-box-sub">{t("auditMemorySub")}</div>
          <div className="audit-metric-val">
            {liveTransmissionAudit.plaintextSizeInRam.toLocaleString()} {t("providerRamUnit")}
          </div>
          <div className="audit-seq-preview">
            <code>{(rawFileText || "").substring(0, 140)}...</code>
          </div>
        </div>

        <div className="audit-row-arrow">
          <NetworkMeshIcon size={18} color="var(--accent-emerald)" />
          <span style={{ fontSize: "10px", color: "var(--accent-emerald)", fontWeight: 700 }}>
            AES-GCM
          </span>
        </div>

        <div className="audit-box wire-box">
          <div className="audit-box-header">
            <DatabaseNodesIcon size={14} color="var(--accent-emerald)" />
            <span>{t("auditWireHeader")}</span>
          </div>
          <div className="audit-box-sub">{t("auditWireSub")}</div>
          <div className="audit-metric-val" style={{ color: "var(--accent-emerald)" }}>
            {t("auditZeroLeakageVal")}
          </div>
          <div className="audit-seq-preview">
            <code>
              {`{\n  "alg": "AES-256-GCM",\n  "iv": "${liveTransmissionAudit.ivHex || ""}",\n  "tag": "${(liveTransmissionAudit.tagHex || "").substring(0, 16)}...",\n  "ciphertext_len": ${liveTransmissionAudit.ciphertextSize || 0}\n}`}
            </code>
          </div>
        </div>
      </div>

      {/* Security Verification Metrics */}
      <div className="audit-summary-metrics">
        <div className="summary-metric-item">
          <span className="summary-label">{t("auditWireExposure")}</span>
          <span className="summary-val zero-leakage">{t("auditZeroLeakageVal")}</span>
        </div>
        <div className="summary-metric-item">
          <span className="summary-label">{t("auditSymmetricCipher")}</span>
          <span className="summary-val">{t("auditCipherVal")}</span>
        </div>
        <div className="summary-metric-item">
          <span className="summary-label">{t("auditPreviewHashLabel")}</span>
          <span className="summary-val mono-hash" title={liveTransmissionAudit.dataHash}>
            {(liveTransmissionAudit.dataHash || "").substring(0, 14)}...
          </span>
        </div>
        <div className="summary-metric-item">
          <span className="summary-label">{t("auditSecondaryRoyalty")}</span>
          <span className="summary-val" style={{ color: "var(--accent-amber)" }}>
            {`${royaltyPct}% ${t("auditRoyaltyVal")}`}
          </span>
        </div>
      </div>
    </div>
  );
}