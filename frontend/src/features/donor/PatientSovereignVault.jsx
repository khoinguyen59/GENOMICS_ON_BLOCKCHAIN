import React, { useState, useRef } from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import {
  DataOwnerShieldIcon,
  GenoTokenIcon,
  EditPencilIcon,
  CheckCircleIcon,
  CloseCrossIcon,
  SendPaperIcon,
  UserPlusIcon,
  DatabaseNodesIcon,
  WalletKeyIcon,
  SealedCipherIcon
} from "../../components/icons/GenoIcons";
import {
  exportSovereignVault,
  importSovereignVault
} from "../../services/datasetService";

export default function PatientSovereignVault({
  onUpdateStatus,
  onUpdatePrice,
  onGrantDirectAccess,
  onDispatchCapsule
}) {
  const { account, signer, getProviderAndSigner, showToast } = useWeb3();
  const { datasets, getLocalizedTitle } = useDatasets();
  const { t, language } = useLanguage();

  const [editingPriceDataId, setEditingPriceDataId] = useState(null);
  const [newPriceInput, setNewPriceInput] = useState("");
  const [grantModalData, setGrantModalData] = useState(null);
  const [grantRecipient, setGrantRecipient] = useState("");
  const [dispatchModalData, setDispatchModalData] = useState(null);
  const [dispatchRecipient, setDispatchRecipient] = useState("");

  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultFeedback, setVaultFeedback] = useState(null);
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [showPassphraseInput, setShowPassphraseInput] = useState(false);
  const fileInputRef = useRef(null);

  const myDatasets = datasets.filter(
    (d) => account && d.owner.toLowerCase() === account.toLowerCase()
  );

  const handleStartEditPrice = (d) => {
    setEditingPriceDataId(d.dataId);
    setNewPriceInput(d.price.toString());
  };

  const handleSavePrice = async (dataId) => {
    const p = parseFloat(newPriceInput);
    if (isNaN(p) || p <= 0) {
      showToast("Please enter a valid positive price in $GENO.", "error");
      return;
    }
    await onUpdatePrice?.(dataId, p);
    setEditingPriceDataId(null);
  };

  const handleExecuteGrant = async () => {
    if (!grantRecipient || !grantRecipient.startsWith("0x") || grantRecipient.length !== 42) {
      showToast("Please enter a valid 42-character EVM address (0x...).", "error");
      return;
    }
    await onGrantDirectAccess?.(grantModalData.dataId, grantRecipient);
    setGrantModalData(null);
    setGrantRecipient("");
  };

  const handleExecuteDispatch = async () => {
    if (!dispatchRecipient || !dispatchRecipient.startsWith("0x") || dispatchRecipient.length !== 42) {
      showToast("Please enter a valid 42-character EVM address (0x...).", "error");
      return;
    }
    await onDispatchCapsule?.({
      dataId: dispatchModalData.dataId,
      recipientAddress: dispatchRecipient,
      rawCid: dispatchModalData.rawCid
    });
    setDispatchModalData(null);
    setDispatchRecipient("");
  };

  const handleExportVault = async () => {
    if (!account) {
      showToast("Please connect your wallet first.", "error");
      return;
    }
    setVaultLoading(true);
    setVaultFeedback(null);
    try {
      const activeSigner = signer || (await getProviderAndSigner?.())?.signer;
      const backupJson = await exportSovereignVault({
        signer: activeSigner,
        account,
        password: vaultPassphrase.trim() || null
      });

      const blob = new Blob([backupJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const shortAddr = account.slice(0, 8);
      link.href = url;
      link.download = `genochain-sovereign-vault-${shortAddr}-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      const parsed = JSON.parse(backupJson);
      const successMsg = `Sovereign Vault exported successfully (${parsed.capsuleCount || 0} dataset capsules secured).`;
      setVaultFeedback({ type: "success", msg: successMsg });
      showToast?.(successMsg, "success");
    } catch (err) {
      console.error("Vault export error:", err);
      setVaultFeedback({ type: "error", msg: err.message || "Failed to export sovereign key vault." });
    } finally {
      setVaultLoading(false);
    }
  };

  const handleImportVaultFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setVaultLoading(true);
    setVaultFeedback(null);
    try {
      const text = await file.text();
      const activeSigner = signer || (await getProviderAndSigner?.())?.signer;
      const res = await importSovereignVault({
        signer: activeSigner,
        account,
        backupData: text,
        password: vaultPassphrase.trim() || null
      });

      const successMsg = `Sovereign Vault imported! ${res.restoredCount} dataset capsules securely written to persistent IndexedDB.`;
      setVaultFeedback({ type: "success", msg: successMsg });
      showToast?.(successMsg, "success");
    } catch (err) {
      console.error("Vault import error:", err);
      setVaultFeedback({ type: "error", msg: err.message || "Failed to import key vault. Check signature/password." });
    } finally {
      setVaultLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div>
      {/* Sovereign Decryption Key Vault & Cold Backup Bar */}
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-md)",
          padding: "16px 20px",
          marginBottom: "18px",
          display: "flex",
          flexDirection: "column",
          gap: "12px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <DatabaseNodesIcon size={20} color="#10b981" />
            <div>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>{t("vaultIndexedDbTitle")}</span>
                <span
                  style={{
                    fontSize: "10px",
                    padding: "2px 8px",
                    background: "rgba(16, 185, 129, 0.15)",
                    color: "#10b981",
                    border: "1px solid rgba(16, 185, 129, 0.3)",
                    borderRadius: "12px",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600
                  }}
                >
                  {t("vaultActivePersistence")}
                </span>
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                {t("vaultIndexedDbSub")}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="file"
              ref={fileInputRef}
              accept=".json"
              style={{ display: "none" }}
              onChange={handleImportVaultFile}
            />
            <button
              className="btn-terminal btn-terminal-ghost"
              onClick={() => setShowPassphraseInput((prev) => !prev)}
              style={{ fontSize: "11px", height: "30px", padding: "0 10px" }}
              type="button"
            >
              <WalletKeyIcon size={12} color="#94a3b8" />
              <span>{showPassphraseInput ? t("vaultHidePassphrase") : t("vaultSetPassphrase")}</span>
            </button>
            <button
              className="btn-terminal btn-terminal-primary"
              onClick={handleExportVault}
              disabled={vaultLoading || !account}
              style={{ fontSize: "11px", height: "30px", padding: "0 12px" }}
              type="button"
            >
              <SealedCipherIcon size={12} />
              <span>{vaultLoading ? t("vaultSecuring") : t("vaultExportJson")}</span>
            </button>
            <button
              className="btn-terminal btn-terminal-success"
              onClick={() => fileInputRef.current?.click()}
              disabled={vaultLoading || !account}
              style={{ fontSize: "11px", height: "30px", padding: "0 12px" }}
              type="button"
            >
              <CheckCircleIcon size={12} color="#10b981" />
              <span>{vaultLoading ? t("vaultRestoring") : t("vaultImportJson")}</span>
            </button>
          </div>
        </div>

        {showPassphraseInput && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", background: "var(--bg-input)", padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)" }}>
            <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {t("vaultPassphrasePrompt")}
            </span>
            <input
              type="password"
              placeholder={t("vaultPassphrasePlaceholder")}
              value={vaultPassphrase}
              onChange={(e) => setVaultPassphrase(e.target.value)}
              style={{
                flex: 1,
                padding: "4px 8px",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-strong)",
                color: "var(--text-primary)",
                fontSize: "11px",
                fontFamily: "var(--font-mono)",
                borderRadius: "4px"
              }}
            />
          </div>
        )}

        {vaultFeedback && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              fontSize: "11.5px",
              fontFamily: "var(--font-mono)",
              background: vaultFeedback.type === "success" ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
              color: vaultFeedback.type === "success" ? "#10b981" : "#ef4444",
              border: `1px solid ${vaultFeedback.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`
            }}
          >
            {vaultFeedback.msg}
          </div>
        )}
      </div>

      <div className="vault-section-title">
        <DataOwnerShieldIcon size={18} color="#38bdf8" />
        <span style={{ fontSize: "14px", fontWeight: 700 }}>{t("vaultTitle")}</span>
      </div>

      <div className="terminal-table-container">
        <table className="terminal-table">
          <thead>
            <tr>
              <th className="col-id">{t("vaultColId")}</th>
              <th>{t("vaultColTarget")}</th>
              <th>{t("vaultColAncestryRegion")}</th>
              <th>{t("vaultColPrice")}</th>
              <th>{t("vaultColAccessRoyalty")}</th>
              <th>{t("vaultColStatus")}</th>
              <th style={{ textAlign: "right", paddingRight: "18px" }}>{t("vaultColControls")}</th>
            </tr>
          </thead>
          <tbody>
            {myDatasets.map((d) => (
              <tr key={d.dataId}>
                <td className="col-id">#{d.tokenId}</td>
                <td>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                    {getLocalizedTitle ? getLocalizedTitle(d, language) : d.disease}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--accent-cyan)" }}>
                    {d.gene}
                  </div>
                </td>
                <td>
                  <div>
                    <span className="chrom-chip" style={{ fontSize: "11px", padding: "2px 6px" }}>
                      {d.format || "VCF v4.2"}
                    </span>
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)", marginLeft: "6px" }}>
                      {d.ancestry || d.region || "Global"}
                    </span>
                  </div>
                </td>
                <td>
                  {editingPriceDataId === d.dataId ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={newPriceInput}
                        onChange={(e) => setNewPriceInput(e.target.value)}
                        style={{
                          width: "70px",
                          padding: "2px 6px",
                          background: "var(--bg-input)",
                          border: "1px solid var(--border-strong)",
                          color: "var(--text-primary)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "12px",
                          borderRadius: "4px"
                        }}
                      />
                      <button
                        className="btn-terminal btn-terminal-success"
                        style={{ padding: "2px 6px", height: "24px" }}
                        onClick={() => handleSavePrice(d.dataId)}
                        title={t("confirm")}
                      >
                        <CheckCircleIcon size={12} color="#10b981" />
                      </button>
                      <button
                        className="btn-terminal btn-terminal-ghost"
                        style={{ padding: "2px 6px", height: "24px" }}
                        onClick={() => setEditingPriceDataId(null)}
                        title={t("cancel")}
                      >
                        <CloseCrossIcon size={11} color="#94a3b8" />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text-primary)" }}>{d.price} $GENO</span>
                      {d.status === "Active" && (
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          style={{ padding: "2px 4px", height: "20px" }}
                          onClick={() => handleStartEditPrice(d)}
                          title={t("btnEditPrice")}
                        >
                          <EditPencilIcon size={11} color="var(--accent-cyan)" />
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-primary)" }}>
                    {d.accessCount} {t("purchasesCount")}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--accent-amber-text)" }}>
                    +{d.accumulatedRoyalty.toFixed(1)} {t("earnedRoyalty")}
                  </div>
                </td>
                <td>
                  <span
                    className={`status-badge-chip ${
                      d.status === "Active"
                        ? "badge-active"
                        : d.status === "Paused"
                        ? "badge-paused"
                        : "badge-revoked"
                    }`}
                  >
                    {d.status === "Active" ? t("statusActive") : d.status === "Paused" ? t("statusPaused") : t("statusRevoked")}
                  </span>
                </td>
                <td style={{ textAlign: "right", paddingRight: "18px" }}>
                  <div className="action-cell-btns" style={{ justifyContent: "flex-end", gap: "6px" }}>
                    {d.status === "Active" && (
                      <>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => setGrantModalData(d)}
                          title="Grant Direct Access to EVM Address (Ràng buộc 1)"
                          style={{ border: "1px solid #10b981", color: "#10b981", fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnGrantAccess")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => setDispatchModalData(d)}
                          title="Dispatch RSA-OAEP Key Capsule to Buyer on-chain"
                          style={{ border: "1px solid #38bdf8", color: "#38bdf8", fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnDispatchCapsule")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => onUpdateStatus?.(d.dataId, 1)}
                          title="Pause Access on Blockchain"
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span style={{ color: "#f59e0b" }}>{t("btnPause")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => onUpdateStatus?.(d.dataId, 2)}
                          title="Permanently Revoke Access on Blockchain"
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span style={{ color: "#ef4444" }}>{t("btnRevoke")}</span>
                        </button>
                      </>
                    )}
                    {d.status === "Paused" && (
                      <>
                        <button
                          className="btn-terminal btn-terminal-success"
                          onClick={() => onUpdateStatus?.(d.dataId, 0)}
                          title="Resume Access on Blockchain"
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnResume")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => onUpdateStatus?.(d.dataId, 2)}
                          title="Permanently Revoke Access"
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span style={{ color: "#ef4444" }}>{t("btnRevoke")}</span>
                        </button>
                      </>
                    )}
                    {d.status === "Revoked" && (
                      <span style={{ fontSize: "12px", color: "var(--text-disabled)", fontStyle: "italic" }}>
                        {t("statusRevoked")}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {myDatasets.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    textAlign: "center",
                    padding: "48px 20px",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)"
                  }}
                >
                  {t("vaultEmptyMsg")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal: Grant Direct Access */}
      {grantModalData && (
        <div className="terminal-modal-backdrop" onClick={() => setGrantModalData(null)}>
          <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <UserPlusIcon size={16} color="var(--accent-emerald)" />
                <span>{t("modalGrantTitle")}{grantModalData.dataId}</span>
              </div>
              <button className="modal-close-btn" onClick={() => setGrantModalData(null)} title={t("close")}>
                <CloseCrossIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                {t("modalGrantDesc")}
              </p>
              <div className="spec-box">
                <div className="spec-box-label">{t("modalTargetDataset")}</div>
                <div className="spec-box-val" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {grantModalData.disease} ({grantModalData.gene})
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginBottom: "6px" }}>
                  {t("modalRecipientLabel")}
                </label>
                <input
                  type="text"
                  placeholder="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
                  value={grantRecipient}
                  onChange={(e) => setGrantRecipient(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    background: "var(--bg-input)",
                    border: "1px solid var(--border-strong)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "12px",
                    borderRadius: "var(--radius-sm)"
                  }}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button className="btn-terminal btn-terminal-ghost" onClick={() => setGrantModalData(null)}>
                {t("cancel")}
              </button>
              <button className="btn-terminal btn-terminal-success" onClick={handleExecuteGrant}>
                <CheckCircleIcon size={12} color="#10b981" />
                <span>{t("btnGrantDirectEvm")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Dispatch RSA-OAEP Capsule */}
      {dispatchModalData && (
        <div className="terminal-modal-backdrop" onClick={() => setDispatchModalData(null)}>
          <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <SendPaperIcon size={16} color="var(--accent-cyan)" />
                <span>{t("modalDispatchTitle")}{dispatchModalData.dataId}</span>
              </div>
              <button className="modal-close-btn" onClick={() => setDispatchModalData(null)} title={t("close")}>
                <CloseCrossIcon size={16} color="#94a3b8" />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                {t("modalDispatchDesc")}
              </p>
              <div className="spec-box">
                <div className="spec-box-label">{t("modalTargetDataset")}</div>
                <div className="spec-box-val" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {dispatchModalData.disease} ({dispatchModalData.gene})
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginBottom: "6px" }}>
                  {t("modalBuyerLabel")}
                </label>
                <input
                  type="text"
                  placeholder="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
                  value={dispatchRecipient}
                  onChange={(e) => setDispatchRecipient(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    background: "var(--bg-input)",
                    border: "1px solid var(--border-strong)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "12px",
                    borderRadius: "var(--radius-sm)"
                  }}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button className="btn-terminal btn-terminal-ghost" onClick={() => setDispatchModalData(null)}>
                {t("cancel")}
              </button>
              <button className="btn-terminal btn-terminal-primary" onClick={handleExecuteDispatch}>
                <SendPaperIcon size={12} />
                <span>{t("btnPackageCapsuleEvm")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
