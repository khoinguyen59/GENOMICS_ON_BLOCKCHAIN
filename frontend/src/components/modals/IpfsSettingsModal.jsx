import React from "react";
import { ServerDriveIcon, CloseCrossIcon } from "../icons/GenoIcons";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export default function IpfsSettingsModal() {
  const {
    showIpfsSettings,
    setShowIpfsSettings,
    pinataJwtInput,
    setPinataJwtInput,
    kuboRpcInput,
    setKuboRpcInput,
    kuboGatewayInput,
    setKuboGatewayInput,
    updateIpfsSettings,
    showToast
  } = useWeb3();
  const { t } = useLanguage();
  const modalRef = useModalFocusTrap(showIpfsSettings, () => setShowIpfsSettings(false));

  if (!showIpfsSettings) return null;

  const handleSave = () => {
    try {
      updateIpfsSettings?.(pinataJwtInput, kuboRpcInput, kuboGatewayInput);
      setShowIpfsSettings(false);
      showToast(t("success") + ": " + t("savePreferences"));
    } catch (err) {
      showToast(err?.message || "Invalid Kubo RPC or Gateway endpoint URL.", "error");
    }
  };

  return (
    <div className="terminal-modal-backdrop" onClick={() => setShowIpfsSettings(false)}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="terminal-modal-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ipfs-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header-bar" role="region" aria-label={t("ipfsModalTitle") || "IPFS Node Settings"}>
          <div className="modal-title-left">
            <ServerDriveIcon size={16} color="var(--accent-cyan)" />
            <h2 id="ipfs-modal-title" style={{ fontSize: "14px", fontWeight: 700, margin: 0, padding: 0, display: "inline" }}>
              {t("ipfsModalTitle")}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowIpfsSettings(false)}
            title={t("close")}
            aria-label={t("close") || "Close"}
          >
            <CloseCrossIcon size={16} color="#94a3b8" />
          </button>
        </div>

        <div className="modal-body" role="region" aria-label={t("ipfsNodeConfig") || "IPFS Node Configuration"}>
          <div className="form-field">
            <label htmlFor="input-pinata-jwt" className="field-label">{t("ipfsPinataLabel")}</label>
            <input
              id="input-pinata-jwt"
              type="password"
              aria-label={t("ipfsPinataLabel")}
              className="field-input"
              value={pinataJwtInput}
              onChange={(e) => setPinataJwtInput(e.target.value)}
              placeholder="eyJhbGciOi..."
            />
          </div>

          <div className="form-field">
            <label htmlFor="input-kubo-rpc" className="field-label">{t("ipfsKuboLabel")}</label>
            <input
              id="input-kubo-rpc"
              type="text"
              aria-label={t("ipfsKuboLabel")}
              className="field-input"
              value={kuboRpcInput}
              onChange={(e) => setKuboRpcInput(e.target.value)}
              placeholder={
                typeof __GENOCHAIN_NON_LOCAL_CHAIN__ !== "undefined" && __GENOCHAIN_NON_LOCAL_CHAIN__
                  ? "https://ipfs-api.genochain.example.com"
                  : "http://127.0.0.1:5001"
              }
            />
          </div>

          <div className="form-field">
            <label htmlFor="input-kubo-gateway" className="field-label">{t("ipfsKuboGatewayLabel")}</label>
            <input
              id="input-kubo-gateway"
              type="text"
              aria-label={t("ipfsKuboGatewayLabel")}
              className="field-input"
              value={kuboGatewayInput}
              onChange={(e) => setKuboGatewayInput(e.target.value)}
              placeholder="https://ipfs.genochain.example.com"
            />
          </div>
        </div>

        <div className="modal-footer-bar" role="region" aria-label={t("savePreferences") || "IPFS Settings Actions"}>
          <button type="button" className="btn-terminal btn-terminal-ghost" onClick={() => setShowIpfsSettings(false)}>
            {t("cancel")}
          </button>
          <button type="button" className="btn-terminal btn-terminal-primary" onClick={handleSave}>
            {t("savePreferences")}
          </button>
        </div>
      </div>
    </div>
  );
}