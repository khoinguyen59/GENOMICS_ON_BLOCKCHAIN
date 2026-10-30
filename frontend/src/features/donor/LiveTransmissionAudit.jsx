import React from "react";
import { useLanguage } from "../../context/LanguageContext";
import {
  DataOwnerShieldIcon,
  CpuChipIcon,
  NetworkMeshIcon,
  DatabaseNodesIcon
} from "../../components/icons/GenoIcons";

export default function LiveTransmissionAudit({ liveTransmissionAudit, rawFileText }) {
  const { t } = useLanguage();
  if (!liveTransmissionAudit) return null;

  return (
    <div className="transmission-audit-card">
      <div className="audit-card-title">
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <DataOwnerShieldIcon size={16} color="var(--accent-emerald)" />
          <span>{t("privacyAuditTitle")}</span>
        </div>
        <span className="audit-chip-live">{t("auditLiveChip")}</span>
      </div>

      <div className="audit-row">
        <div className="audit-box memory-box">
          <div className="audit-box-header">
            <CpuChipIcon size={14} color="var(--accent-cyan)" />
            <span>{t("auditMemoryHeader")}</span>
          </div>
          <div className="audit-box-sub">{t("auditMemorySub")}</div>
          <div className="audit-metric-val">
            {liveTransmissionAudit.plaintextSizeInRam.toLocaleString()} Bytes in RAM
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
          <span className="summary-label">{t("auditAnchorHash")}</span>
          <span className="summary-val mono-hash" title={liveTransmissionAudit.dataHash}>
            {(liveTransmissionAudit.dataHash || "").substring(0, 14)}...
          </span>
        </div>
        <div className="summary-metric-item">
          <span className="summary-label">{t("auditSecondaryRoyalty")}</span>
          <span className="summary-val" style={{ color: "var(--accent-amber)" }}>
            {t("auditRoyaltyVal")}
          </span>
        </div>
      </div>
    </div>
  );
}
