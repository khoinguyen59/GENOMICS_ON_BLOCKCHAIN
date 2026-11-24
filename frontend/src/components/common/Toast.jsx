import React from "react";
import { AlertTriangleIcon, CheckCircleIcon, RefreshSpinIcon, CloseCrossIcon } from "../icons/GenoIcons";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";

export default function Toast() {
  const { toast, clearToast } = useWeb3();
  const { t } = useLanguage();
  if (!toast) return null;

  const toastClass =
    toast.type === "error"
      ? "toast-error"
      : toast.type === "warning"
        ? "toast-warning"
        : toast.type === "info"
          ? "toast-info"
          : "toast-success";

  return (
    <div
      className={`terminal-toast ${toastClass}`}
      role="status"
      aria-live="polite"
    >
      {toast.type === "error" ? (
        <AlertTriangleIcon size={14} color="#ef4444" />
      ) : toast.type === "warning" ? (
        <AlertTriangleIcon size={14} color="var(--accent-amber-text)" />
      ) : toast.type === "info" ? (
        <RefreshSpinIcon size={14} color="#0284c7" className="spin" />
      ) : (
        <CheckCircleIcon size={14} color="#10b981" />
      )}
      <span className="terminal-toast-msg">{toast.message}</span>
      <button
        type="button"
        className="toast-close-btn"
        onClick={clearToast}
        aria-label={t("toastCloseLabel")}
        title={t("toastCloseLabel")}
      >
        <CloseCrossIcon size={12} />
      </button>
    </div>
  );
}
