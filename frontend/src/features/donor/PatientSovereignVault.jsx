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
  importSovereignVault,
  computeBlindTagHex
} from "../../services/datasetService";

export default function PatientSovereignVault({
  onUpdateStatus,
  onUpdatePrice,
  onGrantDirectAccess,
  onDispatchCapsule,
  onAuthorizeWorker,
  onUpdateBlindTags
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
  const [workerModalData, setWorkerModalData] = useState(null);
  const [workerAddressInput, setWorkerAddressInput] = useState("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  const [tagsModalData, setTagsModalData] = useState(null);
  const [tagKeyInput, setTagKeyInput] = useState("gene");
  const [tagValInput, setTagValInput] = useState("ALDH2");
  const [tagSaltInput, setTagSaltInput] = useState("GENOCHAIN_COHORT_SALT_V1");

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
          border: "1px solid var(--border-subtle)",
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
                  className="status-badge-chip badge-active"
                  style={{
                    fontSize: "10px",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600
                  }}
                >
                  {String(t("vaultActivePersistence")).replace(/^[●•]\s*/, "")}
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
              aria-label="Import Sovereign Vault JSON"
              id="vault-file-import"
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
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--accent-cyan-light)" }}>
                    {d.gene}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "10.5px", color: "var(--text-muted)", marginTop: "2px" }}>
                    {d.artifactHashCount || 1}/3 {t("licensedArtifactHashes")} • {d.blindTagCount || 0} {t("vaultTagsSummary")} • {t("licensedReusesLabel")} {d.reuseCount || 0}
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
                        placeholder="GENO"
                        aria-label={t("tableColPrice")}
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
                  <div className="action-cell-btns" style={{ justifyContent: "flex-end", gap: "6px", flexWrap: "wrap", maxWidth: "380px", marginLeft: "auto" }}>
                    {d.status === "Active" && (
                      <>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => setGrantModalData(d)}
                          title={t("btnGrantAccess")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnGrantAccess")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => setDispatchModalData(d)}
                          title={t("btnDispatchCapsule")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnDispatchCapsule")}</span>
                        </button>
                        <button
                          id={`btn-vault-tags-${d.dataId}`}
                          type="button"
                          className="btn-terminal btn-terminal-ghost"
                          title={t("modalBlindTagsTitle")}
                          style={{ fontSize: "12px", height: "30px" }}
                          onClick={() => {
                            setTagsModalData(d);
                            setTagKeyInput("gene");
                            setTagValInput(d.geneSymbol || d.gene || "ALDH2");
                          }}
                        >
                          <span>{t("vaultBtnTags")}</span>
                        </button>
                        <button
                          id={`btn-vault-worker-${d.dataId}`}
                          type="button"
                          className="btn-terminal btn-terminal-ghost"
                          title={t("workerAuthLabel")}
                          style={{ fontSize: "12px", height: "30px" }}
                          onClick={() => setWorkerModalData(d)}
                        >
                          <span>{t("vaultBtnWorker")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-ghost"
                          onClick={() => onUpdateStatus?.(d.dataId, 1)}
                          title={t("btnPause")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnPause")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-danger"
                          onClick={() => onUpdateStatus?.(d.dataId, 2)}
                          title={t("btnRevoke")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnRevoke")}</span>
                        </button>
                      </>
                    )}
                    {d.status === "Paused" && (
                      <>
                        <button
                          className="btn-terminal btn-terminal-success"
                          onClick={() => onUpdateStatus?.(d.dataId, 0)}
                          title={t("btnResume")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnResume")}</span>
                        </button>
                        <button
                          className="btn-terminal btn-terminal-danger"
                          onClick={() => onUpdateStatus?.(d.dataId, 2)}
                          title={t("btnRevoke")}
                          style={{ fontSize: "12px", height: "30px" }}
                          type="button"
                        >
                          <span>{t("btnRevoke")}</span>
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
                <label className="field-label" htmlFor="input-grant-recipient">
                  {t("modalRecipientLabel")}
                </label>
                <input
                  id="input-grant-recipient"
                  type="text"
                  className="field-input"
                  placeholder="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
                  value={grantRecipient}
                  onChange={(e) => setGrantRecipient(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button type="button" className="btn-terminal btn-terminal-ghost" onClick={() => setGrantModalData(null)}>
                {t("cancel")}
              </button>
              <button type="button" className="btn-terminal btn-terminal-success" onClick={handleExecuteGrant}>
                <CheckCircleIcon size={12} color="var(--accent-emerald)" />
                <span>{t("btnGrantDirectEvm")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Dispatch RSA-OAEP Capsule */}
      {dispatchModalData && (
        <div className="terminal-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setDispatchModalData(null)}>
          <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <SendPaperIcon size={16} color="var(--accent-cyan)" />
                <span>{t("modalDispatchTitle")}{dispatchModalData.dataId}</span>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setDispatchModalData(null)} title={t("close")}>
                <CloseCrossIcon size={16} color="var(--text-muted)" />
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
                <label className="field-label" htmlFor="input-dispatch-recipient">
                  {t("modalBuyerLabel")}
                </label>
                <input
                  id="input-dispatch-recipient"
                  type="text"
                  className="field-input"
                  placeholder="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
                  value={dispatchRecipient}
                  onChange={(e) => setDispatchRecipient(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button type="button" className="btn-terminal btn-terminal-ghost" onClick={() => setDispatchModalData(null)}>
                {t("cancel")}
              </button>
              <button type="button" className="btn-terminal btn-terminal-primary" onClick={handleExecuteDispatch}>
                <SendPaperIcon size={12} />
                <span>{t("btnPackageCapsuleEvm")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Authorize / Revoke Delegated Capsule Worker */}
      {workerModalData && (
        <div className="terminal-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setWorkerModalData(null)}>
          <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <WalletKeyIcon size={16} color="#a855f7" />
                <span>{t("workerAuthLabel")} #{workerModalData.dataId}</span>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                title={t("close")}
                onClick={() => setWorkerModalData(null)}
              >
                <CloseCrossIcon size={16} color="var(--text-muted)" />
              </button>
            </div>
            <div className="modal-body">
              <label htmlFor="input-vault-worker-addr" className="field-label">
                {t("modalWorkerAddrLabel")}
              </label>
              <input
                id="input-vault-worker-addr"
                type="text"
                className="field-input"
                placeholder="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
                aria-label={t("modalWorkerAddrLabel")}
                value={workerAddressInput}
                onChange={(e) => setWorkerAddressInput(e.target.value)}
              />
            </div>
            <div className="modal-footer-bar">
              <button
                id="btn-confirm-worker-revoke"
                type="button"
                className="btn-terminal btn-terminal-ghost"
                title={t("workerRevokeBtn")}
                onClick={async () => {
                  await onAuthorizeWorker?.(workerModalData.dataId, workerAddressInput, false);
                  setWorkerModalData(null);
                }}
              >
                <span>{t("workerRevokeBtn")}</span>
              </button>
              <button
                id="btn-confirm-worker-auth"
                type="button"
                className="btn-terminal btn-terminal-primary"
                title={t("workerAuthBtn")}
                onClick={async () => {
                  await onAuthorizeWorker?.(workerModalData.dataId, workerAddressInput, true);
                  setWorkerModalData(null);
                }}
              >
                <span>{t("workerAuthBtn")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Update On-Chain Blinded Search Tags */}
      {tagsModalData && (
        <div className="terminal-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setTagsModalData(null)}>
          <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-bar">
              <div className="modal-title-left">
                <SealedCipherIcon size={16} color="#818cf8" />
                <span>{t("modalBlindTagsTitle")} #{tagsModalData.dataId}</span>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                title={t("close")}
                onClick={() => setTagsModalData(null)}
              >
                <CloseCrossIcon size={16} color="var(--text-muted)" />
              </button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <label htmlFor="input-vault-tag-key" className="field-label">
                  {t("blindSearchKey")}
                </label>
                <input
                  id="input-vault-tag-key"
                  type="text"
                  className="field-input"
                  placeholder="gene / disease / hpo / ancestry"
                  aria-label={t("blindSearchKey")}
                  value={tagKeyInput}
                  onChange={(e) => setTagKeyInput(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="input-vault-tag-val" className="field-label">
                  {t("blindSearchVal")}
                </label>
                <input
                  id="input-vault-tag-val"
                  type="text"
                  className="field-input"
                  placeholder={t("blindSearchVal")}
                  aria-label={t("blindSearchVal")}
                  value={tagValInput}
                  onChange={(e) => setTagValInput(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="input-vault-tag-salt" className="field-label">
                  {t("blindSaltLabel")}
                </label>
                <input
                  id="input-vault-tag-salt"
                  type="text"
                  className="field-input"
                  placeholder="GENOCHAIN_COHORT_SALT_V1"
                  aria-label={t("blindSaltLabel")}
                  value={tagSaltInput}
                  onChange={(e) => setTagSaltInput(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer-bar">
              <button
                type="button"
                className="btn-terminal btn-terminal-ghost"
                title={t("cancel")}
                onClick={() => setTagsModalData(null)}
              >
                {t("cancel")}
              </button>
              <button
                id="btn-confirm-blind-tags"
                type="button"
                className="btn-terminal btn-terminal-primary"
                title={t("confirm")}
                onClick={async () => {
                  const tag = computeBlindTagHex(tagKeyInput, tagValInput, tagSaltInput);
                  await onUpdateBlindTags?.(tagsModalData.dataId, [tag]);
                  setTagsModalData(null);
                }}
              >
                <span>{t("confirm")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
