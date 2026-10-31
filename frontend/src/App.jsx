import React from "react";
import { ThemeProvider } from "./context/ThemeContext";
import { LanguageProvider } from "./context/LanguageContext";
import { Web3Provider, useWeb3 } from "./context/Web3Context";
import { DatasetProvider, useDatasets } from "./context/DatasetContext";
import Navbar from "./components/common/Navbar";
import OpenSeaLeftSidebar from "./components/common/OpenSeaLeftSidebar";
import OpenSeaBottomBar from "./components/common/OpenSeaBottomBar";
import Toast from "./components/common/Toast";
import AssetDetailModal from "./components/modals/AssetDetailModal";
import IpfsSettingsModal from "./components/modals/IpfsSettingsModal";
import DonorPortal from "./features/donor/DonorPortal";
import ResearcherMarketplace from "./features/researcher/ResearcherMarketplace";
import {
  publishGenomicDataset,
  updateDatasetStatus,
  updateDatasetPrice,
  grantDirectDatasetAccess,
  dispatchCapsuleToBuyer,
  purchaseDatasetAccess,
  purchaseDatasetWithEscrow,
  claimDatasetEscrowRefund,
  decryptDatasetPayload,
  decryptSummaryReport,
  fetchPhenopacketMetadata
} from "./services/datasetService";

function AppContent() {
  const {
    userRole,
    account,
    signer,
    contracts,
    researcherKeyPair,
    setDonorTab,
    setResearcherTab,
    showToast,
    refreshBalance
  } = useWeb3();

  const {
    datasets,
    fetchOnChainDatasets,
    setPurchasedData,
    selectedAssetModal,
    setSelectedAssetModal
  } = useDatasets();

  // Minting & Registration Pipeline (Data Owner)
  const handlePublishDataset = async (formData) => {
    try {
      showToast("1/3: Encrypting genomic sequence client-side...", "info");
      await publishGenomicDataset({
        ...formData,
        account,
        signer
      });
      showToast("Dataset encrypted client-side and registered on-chain!");
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      setDonorTab("vault");
    } catch (err) {
      showToast("Publish failed: " + (err.shortMessage || err.message), "error");
      throw err;
    }
  };

  // Data Status Updates (Pause / Resume / Revoke)
  const handleUpdateStatus = async (dataId, newStatusNum) => {
    try {
      showToast(`Broadcasting updateDataStatus(${dataId}, ${newStatusNum})...`, "info");
      await updateDatasetStatus({ dataId, newStatusNum, signer });
      const label = newStatusNum === 0 ? "Active" : newStatusNum === 1 ? "Paused" : "Revoked";
      showToast(`Dataset #${dataId} status updated to: ${label}`);
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
    } catch (err) {
      showToast("Status update failed: " + (err.shortMessage || err.message), "error");
    }
  };

  // Data Access Fee Update (Access Control Policy)
  const handleUpdatePrice = async (dataId, newPriceGeno) => {
    try {
      showToast(`Broadcasting updateDataPrice(${dataId}, ${newPriceGeno} GENO)...`, "info");
      await updateDatasetPrice({ dataId, newPriceGeno, signer });
      showToast(`Dataset #${dataId} access fee successfully updated to ${newPriceGeno} GENO!`);
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
    } catch (err) {
      showToast("Update price failed: " + (err.shortMessage || err.message), "error");
    }
  };

  // Grant Direct Viewing Access on Blockchain (Access Control Policy)
  const handleGrantDirectAccess = async (dataId, recipientAddress) => {
    try {
      showToast(`Broadcasting grantDirectAccess(${dataId}, ${recipientAddress.slice(0, 8)}...)...`, "info");
      await grantDirectDatasetAccess({ dataId, recipientAddress, signer });
      showToast(`Direct access granted on-chain to ${recipientAddress}!`);
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
    } catch (err) {
      showToast("Grant access failed: " + (err.shortMessage || err.message), "error");
    }
  };

  // Dispatch Asymmetric Key Capsule On-Chain
  const handleDispatchCapsule = async ({ dataId, recipientAddress, rawCid }) => {
    try {
      showToast(`Fetching researcher's on-chain public key for ${recipientAddress.slice(0, 8)}...`, "info");
      const pubKeyJwk = await contracts.registry.researcherPublicKeys(recipientAddress);
      if (!pubKeyJwk || pubKeyJwk.trim().length === 0) {
        throw new Error("Recipient researcher has not registered their public key on-chain yet.");
      }
      showToast("Packaging RSA-OAEP Key Capsule and writing to EVM...", "info");
      await dispatchCapsuleToBuyer({
        dataId,
        recipientAddress,
        recipientPublicKeyJwk: pubKeyJwk,
        rawCid,
        ownerAddress: account,
        signer
      });
      showToast(`Key Capsule dispatched on-chain for ${recipientAddress.slice(0, 8)}!`);
      await refreshBalance(account);
    } catch (err) {
      showToast("Dispatch capsule failed: " + (err.shortMessage || err.message), "error");
    }
  };

  // Escrow Purchase Access (Researcher)
  const handlePurchaseAccess = async (dataset, options = {}) => {
    try {
      const { useEscrow = true, disputeWindowDays = 1 } = options;
      if (useEscrow) {
        showToast("1/2: Approving $GENO allowance to Escrow Contract...", "info");
        await purchaseDatasetWithEscrow({
          dataset,
          disputeWindowDays,
          account,
          signer
        });
        showToast(`Access granted with Timelock Escrow Protection! Funds held in contract until capsule delivery.`);
      } else {
        showToast("1/2: Approving $GENO allowance to Contract...", "info");
        await purchaseDatasetAccess({
          dataset,
          account,
          signer,
          researcherKeyPair
        });
        showToast(`Access granted for Dataset #${dataset.dataId}! Ready for in-memory decryption.`);
      }
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      setResearcherTab("licensed");
      if (selectedAssetModal) setSelectedAssetModal(null);
    } catch (err) {
      showToast("Purchase failed: " + (err.shortMessage || err.message), "error");
    }
  };

  // Claim 100% Escrow Refund if dispatcher fails to deliver capsule within dispute window
  const handleClaimEscrowRefund = async (dataId) => {
    try {
      showToast(`Initiating 100% Escrow Refund for Dataset #${dataId}...`, "info");
      await claimDatasetEscrowRefund({ dataId, signer });
      showToast(`100% Refund claimed successfully! Access revoked and tokens returned.`);
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
    } catch (err) {
      showToast("Refund claim failed: " + (err.shortMessage || err.message), "error");
    }
  };

  // In-Memory Decryption (Researcher)
  const handleDecryptData = async (dataId) => {
    try {
      const ds = datasets.find((d) => d.dataId === dataId);
      if (!ds) return;

      showToast("1/4: Fetching encrypted sequence & summary report from IPFS...", "info");
      const decryptedPlaintext = await decryptDatasetPayload({
        dataset: ds,
        account,
        contracts,
        researcherKeyPair
      });

      let decryptedPdfBytes = null;
      if (ds.summaryCid) {
        showToast("2/4: Decrypting ISO 32000 / PDF-1.4 Genomic Summary...", "info");
        try {
          decryptedPdfBytes = await decryptSummaryReport({
            dataset: ds,
            account,
            contracts,
            researcherKeyPair
          });
        } catch (e) {
          console.warn("PDF summary report decryption notice:", e);
        }
      }

      let phenopacketJson = null;
      if (ds.metadataCid) {
        showToast("3/4: Fetching GA4GH Phenopacket v2 JSON metadata...", "info");
        try {
          phenopacketJson = await fetchPhenopacketMetadata({ metadataCid: ds.metadataCid });
        } catch (e) {
          console.warn("Phenopacket metadata fetch notice:", e);
        }
      }

      setPurchasedData((prev) =>
        prev.map((p) =>
          p.dataId === dataId
            ? {
                ...p,
                decryptedContent: decryptedPlaintext,
                decryptedPdfBytes: decryptedPdfBytes,
                phenopacketJson: phenopacketJson
              }
            : p
        )
      );
      showToast("Decrypted successfully! Raw VCF, Genomic PDF, and Phenopacket verified.");
    } catch (err) {
      showToast(`Decryption error: ${err.message}`, "error");
    }
  };

  // Export Decrypted VCF File
  const handleDownloadFile = (content, filename) => {
    const cleanName = (filename || "Genomic_Data.vcf").replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = cleanName;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`Downloaded ${cleanName}`);
  };

  // Export Decrypted PDF Report
  const handleDownloadPdf = (pdfBytes, filename) => {
    if (!pdfBytes) {
      showToast("Genomic PDF report not available or still decrypting.", "error");
      return;
    }
    const cleanName = (filename || "Genomic_Report.pdf").replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_");
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = cleanName;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`Downloaded Genomic Summary Report: ${cleanName}`);
  };

  return (
    <div className="app-container os2-app-shell">
      {/* Toast Alert Notification */}
      <Toast />

      {/* OpenSea OS2 Left Collapsible Sidebar Rail (52px -> 220px) */}
      <OpenSeaLeftSidebar />

      {/* OpenSea OS2 Minimal Top Search & Auth Bar */}
      <Navbar />

      {/* Main Feature Layout */}
      <main className="terminal-main os2-main-content">
        {userRole === "donor" ? (
          <DonorPortal
            onPublishDataset={handlePublishDataset}
            onUpdateStatus={handleUpdateStatus}
            onUpdatePrice={handleUpdatePrice}
            onGrantDirectAccess={handleGrantDirectAccess}
            onDispatchCapsule={handleDispatchCapsule}
          />
        ) : (
          <ResearcherMarketplace
            onPurchase={handlePurchaseAccess}
            onDecrypt={handleDecryptData}
            onDownload={handleDownloadFile}
            onDownloadPdf={handleDownloadPdf}
            onClaimRefund={handleClaimEscrowRefund}
          />
        )}
      </main>

      {/* OpenSea OS2 Fixed Bottom Status Bar (32px) */}
      <OpenSeaBottomBar />

      {/* Modals */}
      <AssetDetailModal onPurchase={handlePurchaseAccess} />
      <IpfsSettingsModal />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <Web3Provider>
          <DatasetProvider>
            <AppContent />
          </DatasetProvider>
        </Web3Provider>
      </LanguageProvider>
    </ThemeProvider>
  );
}

