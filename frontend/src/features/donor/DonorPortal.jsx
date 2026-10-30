import React from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import {
  DataOwnerShieldIcon,
  SealedCipherIcon
} from "../../components/icons/GenoIcons";
import DragDropMintingStudio from "./DragDropMintingStudio";
import PatientSovereignVault from "./PatientSovereignVault";

export default function DonorPortal({
  onPublishDataset,
  onUpdateStatus,
  onUpdatePrice,
  onGrantDirectAccess,
  onDispatchCapsule
}) {
  const { donorTab, setDonorTab, account } = useWeb3();
  const { datasets } = useDatasets();
  const { t } = useLanguage();

  const myDatasetsCount = datasets.filter(
    (d) => account && d.owner.toLowerCase() === account.toLowerCase()
  ).length;

  return (
    <div>
      {/* Sub-navigation for Donor */}
      <div className="portal-subnav-bar">
        <div className="subnav-tabs">
          <button
            className={`subnav-tab-item ${donorTab === "upload" ? "active" : ""}`}
            onClick={() => setDonorTab("upload")}
            type="button"
          >
            <SealedCipherIcon size={16} color={donorTab === "upload" ? "#38bdf8" : "#94a3b8"} />
            <span>{t("tabMintStudio")}</span>
          </button>
          <button
            className={`subnav-tab-item ${donorTab === "vault" ? "active" : ""}`}
            onClick={() => setDonorTab("vault")}
            type="button"
          >
            <DataOwnerShieldIcon size={16} color={donorTab === "vault" ? "#38bdf8" : "#94a3b8"} />
            <span>{t("tabSovereignVault")} ({myDatasetsCount})</span>
          </button>
        </div>

        <div className="portal-role-tag">
          <DataOwnerShieldIcon size={14} color="#38bdf8" />
          <span>{t("roleDonorBadge")}</span>
        </div>
      </div>

      {/* Sub-tab 1: Drag & Drop Minting Studio */}
      {donorTab === "upload" && (
        <DragDropMintingStudio onPublishSuccess={onPublishDataset} />
      )}

      {/* Sub-tab 2: Patient Sovereign Vault & Royalties */}
      {donorTab === "vault" && (
        <PatientSovereignVault
          onUpdateStatus={onUpdateStatus}
          onUpdatePrice={onUpdatePrice}
          onGrantDirectAccess={onGrantDirectAccess}
          onDispatchCapsule={onDispatchCapsule}
        />
      )}
    </div>
  );
}
