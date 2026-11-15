import React from "react";
import { ServerDriveIcon, CloseCrossIcon } from "../icons/GenoIcons";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { setPinataJwt, setKuboRpcEndpoint } from "../../../../ipfs/pinata_uploader.js";

export default function IpfsSettingsModal() {
  const {
    showIpfsSettings,
    setShowIpfsSettings,
    pinataJwtInput,
    setPinataJwtInput,
    kuboRpcInput,
    setKuboRpcInput,
    updateIpfsSettings,
    showToast
  } = useWeb3();
  const { t } = useLanguage();

  if (!showIpfsSettings) return null;

  const handleSave = () => {
    updateIpfsSettings?.(pinataJwtInput, kuboRpcInput);
    setShowIpfsSettings(false);
    showToast(t("success") + ": " + t("savePreferences"));
  };

  return (
    <div className="terminal-modal-backdrop" onClick={() => setShowIpfsSettings(false)}>
      <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-bar">
          <div className="modal-title-left">
            <ServerDriveIcon size={16} color="var(--accent-cyan)" />
            <span>{t("ipfsModalTitle")}</span>
          </div>
          <button className="modal-close-btn" onClick={() => setShowIpfsSettings(false)} title={t("close")}>
            <CloseCrossIcon size={16} color="#94a3b8" />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-field">
            <label htmlFor="input-pinata-jwt" className="field-label">{t("ipfsPinataLabel")}</label>
            <input
              id="input-pinata-jwt"
              type="password"
              aria-label={t("ipfsPinataLabel")}
              className="field-input"
              value={pinataJwtInput}
              onChange={(e) => setPinataJwtInput(e.target.value)}
              placeholder="Bearer eyJhbGciOi..."
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
              placeholder="http://127.0.0.1:5001"
            />
          </div>
        </div>

        <div className="modal-footer-bar">
          <button className="btn-terminal btn-terminal-ghost" onClick={() => setShowIpfsSettings(false)}>
            {t("cancel")}
          </button>
          <button className="btn-terminal btn-terminal-primary" onClick={handleSave}>
            {t("savePreferences")}
          </button>
        </div>
      </div>
    </div>
  );
}
