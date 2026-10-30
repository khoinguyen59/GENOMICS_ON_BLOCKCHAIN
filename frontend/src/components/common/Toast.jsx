import React from "react";
import { AlertTriangleIcon, CheckCircleIcon, RefreshSpinIcon } from "../icons/GenoIcons";
import { useWeb3 } from "../../context/Web3Context";

export default function Toast() {
  const { toast } = useWeb3();
  if (!toast) return null;

  return (
    <div
      className={`terminal-toast ${
        toast.type === "error" ? "toast-error" : toast.type === "info" ? "toast-info" : "toast-success"
      }`}
    >
      {toast.type === "error" ? (
        <AlertTriangleIcon size={14} color="#ef4444" />
      ) : toast.type === "info" ? (
        <RefreshSpinIcon size={14} color="#38bdf8" className="spin" />
      ) : (
        <CheckCircleIcon size={14} color="#10b981" />
      )}
      <span>{toast.message}</span>
    </div>
  );
}
