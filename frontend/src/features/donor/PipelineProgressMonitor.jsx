import React from "react";
import { useLanguage } from "../../context/LanguageContext";
import { DataOwnerShieldIcon, CheckCircleIcon } from "../../components/icons/GenoIcons";
import LiveTransmissionAudit from "./LiveTransmissionAudit";

export default function PipelineProgressMonitor({
  publishStep,
  liveTransmissionAudit,
  rawFileText
}) {
  const { t } = useLanguage();

  return (
    <div className="studio-panel" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div className="panel-title-bar">
        <div className="panel-title">
          <DataOwnerShieldIcon size={16} color="var(--accent-emerald)" />
          <span>{t("privacyAuditTitle")}</span>
        </div>
        <span className="audit-pass-badge" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <CheckCircleIcon size={12} color="var(--accent-emerald)" />
          <span>{t("auditPassedBadge")}</span>
        </span>
      </div>

      <LiveTransmissionAudit
        liveTransmissionAudit={liveTransmissionAudit}
        rawFileText={rawFileText}
      />

      {/* Pipeline Architecture Summary */}
      <div className="pipeline-step-list">
        <div className="pipeline-step-card">
          <div className="step-card-header">
            <div className="step-number-title">
              <span className="step-idx">1</span>
              <span>{t("step1Title")}</span>
            </div>
            <span
              className={`step-status-chip ${
                publishStep >= 1 ? "step-status-ready" : "step-status-idle"
              }`}
            >
              {publishStep === 1 ? t("stepRunning") : publishStep > 1 ? t("stepCompleted") : t("stepReady")}
            </span>
          </div>
          <div className="step-crypto-detail">
            {t("step1Desc")}
          </div>
        </div>

        <div className="pipeline-step-card">
          <div className="step-card-header">
            <div className="step-number-title">
              <span className="step-idx">2</span>
              <span>{t("step2Title")}</span>
            </div>
            <span
              className={`step-status-chip ${
                publishStep >= 2 ? "step-status-ready" : "step-status-idle"
              }`}
            >
              {publishStep === 2 ? t("stepRunning") : publishStep > 2 ? t("stepCompleted") : t("stepWaiting")}
            </span>
          </div>
          <div className="step-crypto-detail">
            {t("step2Desc")}
          </div>
        </div>

        <div className="pipeline-step-card">
          <div className="step-card-header">
            <div className="step-number-title">
              <span className="step-idx">3</span>
              <span>{t("step3Title")}</span>
            </div>
            <span
              className={`step-status-chip ${
                publishStep >= 3 ? "step-status-ready" : "step-status-idle"
              }`}
            >
              {publishStep === 3 ? t("stepRunning") : t("stepReady")}
            </span>
          </div>
          <div className="step-crypto-detail">
            {t("step3Desc")}
          </div>
        </div>
      </div>
    </div>
  );
}
