import React from "react";
import { ThemeProvider } from "./context/ThemeContext";
import { LanguageProvider, useLanguage } from "./context/LanguageContext";
import { Web3Provider, useWeb3, CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME } from "./context/Web3Context";
import { formatConfiguredChainText } from "./utils/asyncResilience";
import { DatasetProvider, useDatasets } from "./context/DatasetContext";
import Navbar from "./components/common/Navbar";
import OpenSeaLeftSidebar from "./components/common/OpenSeaLeftSidebar";
import OpenSeaBottomBar from "./components/common/OpenSeaBottomBar";
import Toast from "./components/common/Toast";
import AssetDetailModal from "./components/modals/AssetDetailModal";
import IpfsSettingsModal from "./components/modals/IpfsSettingsModal";
import DonorPortal from "./features/donor/DonorPortal";
import ResearcherMarketplace from "./features/researcher/ResearcherMarketplace";
import AdminPortal from "./features/admin/AdminPortal";
import {
  publishGenomicDataset,
  updateDatasetStatus,
  updateDatasetPrice,
  grantDirectDatasetAccess,
  dispatchCapsuleToBuyer,
  setDatasetCapsuleWorker,
  updateDatasetBlindTags,
  purchaseDatasetAccess,
  purchaseDatasetWithEscrow,
  claimDatasetEscrowRefund,
  confirmCapsuleAndReleaseEscrow,
  disputeCapsule,
  setManualEscrowRelease,
  releaseEscrow,
  recordDatasetStudyReuse
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
    refreshBalance,
    rpcOnline,
    wrongChain,
    configuredChainId = CONFIGURED_CHAIN_ID,
    configuredChainName = CONFIGURED_CHAIN_NAME,
    connectWallet
  } = useWeb3();

  const { lang, t } = useLanguage();

  const {
    datasets,
    fetchOnChainDatasets,
    setPurchasedData,
    selectedAssetModal,
    setSelectedAssetModal,
    handleDecryptData,
    handleDownloadFile,
    handleDownloadPdf
  } = useDatasets();

  // Minting & Registration Pipeline (Data Owner)
  const handlePublishDataset = async (formData) => {
    try {
      showToast(t("appPublishEncrypting"), "info");
      await publishGenomicDataset({
        ...formData,
        account,
        signer
      });
      showToast(t("appPublishSuccess"));
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      setDonorTab("vault");
    } catch (err) {
      showToast(`${t("appPublishFailedPrefix")}${err.shortMessage || err.message}`, "error");
      throw err;
    }
  };

  // Data Status Updates (Pause / Resume / Revoke)
  const handleUpdateStatus = async (dataId, newStatusNum) => {
    try {
      showToast(lang === "vi" ? `Đang gửi cập nhật trạng thái dữ liệu #${dataId}...` : `Broadcasting updateDataStatus(${dataId}, ${newStatusNum})...`, "info");
      await updateDatasetStatus({ dataId, newStatusNum, account, signer });
      const label = newStatusNum === 0 ? t("statusActive") : newStatusNum === 1 ? t("statusPaused") : t("statusRevoked");
      showToast(lang === "vi" ? `Trạng thái dữ liệu #${dataId} đã cập nhật: ${label}` : `Dataset #${dataId} status updated to: ${label}`);
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật trạng thái thất bại: " : "Status update failed: ") + (err.shortMessage || err.message), "error");
    }
  };

  // Data Access Fee Update (Access Control Policy)
  const handleUpdatePrice = async (dataId, newPriceGeno) => {
    try {
      showToast(lang === "vi" ? `Đang cập nhật phí truy cập dữ liệu #${dataId}...` : `Broadcasting updateDataPrice(${dataId}, ${newPriceGeno} GENO)...`, "info");
      await updateDatasetPrice({ dataId, newPriceGeno, account, signer });
      showToast(lang === "vi" ? `Cập nhật phí truy cập dữ liệu #${dataId} thành công: ${newPriceGeno} $GENO!` : `Dataset #${dataId} access fee successfully updated to ${newPriceGeno} GENO!`);
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      return true;
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật phí thất bại: " : "Update price failed: ") + (err.shortMessage || err.message), "error");
      return false;
    }
  };

  // Grant Direct Viewing Access on Blockchain (Access Control Policy)
  const handleGrantDirectAccess = async (dataId, recipientAddress) => {
    try {
      showToast(
        lang === "vi"
          ? `Đang cấp quyền truy cập trực tiếp dữ liệu #${dataId} cho ${recipientAddress.slice(0, 8)}...`
          : `Broadcasting grantDirectAccess(${dataId}, ${recipientAddress.slice(0, 8)}...)...`,
        "info"
      );
      await grantDirectDatasetAccess({ dataId, recipientAddress, account, signer });
      showToast(
        lang === "vi"
          ? `Đã cấp quyền truy cập trực tiếp on-chain cho ${recipientAddress}!`
          : `Direct access granted on-chain to ${recipientAddress}!`
      );
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      return true;
    } catch (err) {
      showToast((lang === "vi" ? "Cấp quyền thất bại: " : "Grant access failed: ") + (err.shortMessage || err.message), "error");
      return false;
    }
  };

  // Dispatch Asymmetric Key Capsule On-Chain
  const handleDispatchCapsule = async ({ dataId, recipientAddress, rawCid }) => {
    try {
      showToast(
        lang === "vi"
          ? `Đang truy vấn khóa công khai on-chain của ${recipientAddress.slice(0, 8)}...`
          : `Fetching researcher's on-chain public key for ${recipientAddress.slice(0, 8)}...`,
        "info"
      );
      const pubKeyJwk = await contracts.registry.researcherPublicKeys(recipientAddress);
      if (!pubKeyJwk || pubKeyJwk.trim().length === 0) {
        throw new Error(
          lang === "vi"
            ? "Nhà nghiên cứu nhận khóa chưa đăng ký khóa công khai RSA trên chuỗi."
            : "Recipient researcher has not registered their public key on-chain yet."
        );
      }
      showToast(
        lang === "vi"
          ? "Đang đóng gói Key Capsule RSA-OAEP và ghi lên EVM..."
          : "Packaging RSA-OAEP Key Capsule and writing to EVM...",
        "info"
      );
      await dispatchCapsuleToBuyer({
        dataId,
        recipientAddress,
        recipientPublicKeyJwk: pubKeyJwk,
        rawCid,
        ownerAddress: account,
        signer
      });
      showToast(
        lang === "vi"
          ? `Đã bàn giao Key Capsule on-chain cho ${recipientAddress.slice(0, 8)}!`
          : `Key Capsule dispatched on-chain for ${recipientAddress.slice(0, 8)}!`
      );
      await refreshBalance(account);
      return true;
    } catch (err) {
      showToast((lang === "vi" ? "Bàn giao khóa thất bại: " : "Dispatch capsule failed: ") + (err.shortMessage || err.message), "error");
      return false;
    }
  };

  // Authorize Capsule Worker & Update Blinded Search Tags (Data Owner)
  const handleAuthorizeWorker = async (dataId, workerAddress, authorized = true) => {
    try {
      showToast(
        lang === "vi"
          ? `Đang cập nhật ủy quyền Worker cho dữ liệu #${dataId} (${workerAddress.slice(0, 8)}...)...`
          : `Broadcasting authorizeCapsuleWorker(${dataId}, ${workerAddress.slice(0, 8)}...)...`,
        "info"
      );
      await setDatasetCapsuleWorker({ dataId, workerAddress, authorized, account, signer });
      showToast(
        lang === "vi"
          ? `Đã ${authorized ? "ủy quyền" : "thu hồi"} Worker on-chain cho dữ liệu #${dataId}!`
          : `Capsule worker ${authorized ? "authorized" : "revoked"} on-chain for Dataset #${dataId}!`
      );
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      return true;
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật Worker thất bại: " : "Worker update failed: ") + (err.shortMessage || err.message), "error");
      return false;
    }
  };

  const handleUpdateBlindTags = async (dataId, blindTags) => {
    try {
      showToast(
        lang === "vi"
          ? `Đang neo ${blindTags.length} thẻ đặc tính ẩn danh lên chuỗi cho dữ liệu #${dataId}...`
          : `Anchoring ${blindTags.length} blinded trait tags on-chain for Dataset #${dataId}...`,
        "info"
      );
      await updateDatasetBlindTags({ dataId, blindTags, account, signer });
      showToast(
        lang === "vi"
          ? `Đã cập nhật ${blindTags.length} thẻ ẩn danh cho dữ liệu #${dataId}!`
          : `Updated ${blindTags.length} blinded trait tags for Dataset #${dataId}!`
      );
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      return true;
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật thẻ ẩn danh thất bại: " : "Blind tag update failed: ") + (err.shortMessage || err.message), "error");
      return false;
    }
  };

  // Record Secondary Study Reuse (5% Fee + EIP-2981 Royalty Split)
  const handleRecordStudyReuse = async (dataId, studyTitleOrId) => {
    try {
      showToast(
        lang === "vi"
          ? `1/2: Đang duyệt phí tái sử dụng nghiên cứu 5% cho dữ liệu #${dataId}...`
          : `1/2: Approving 5% Study Reuse Fee for Dataset #${dataId}...`,
        "info"
      );
      const res = await recordDatasetStudyReuse({ dataId, studyTitleOrId, account, signer });
      showToast(
        lang === "vi"
          ? `Đã ghi nhận tái sử dụng nghiên cứu on-chain! Đã thanh toán ${res.feeGeno} $GENO (chia bản quyền 5%).`
          : `Study Reuse recorded on-chain! Paid ${res.feeGeno} $GENO (5% Royalty Split).`
      );
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      return res;
    } catch (err) {
      showToast(`${t("appReuseFailedPrefix")}${err.shortMessage || err.message}`, "error");
      throw err;
    }
  };

  // Escrow Purchase Access (Researcher)
  const handlePurchaseAccess = async (dataset, options = {}) => {
    if (dataset?.metadataTampered || dataset?.metadataVerificationStatus === "tampered") {
      showToast(t("purchaseBlockedTamperedErr"), "error");
      return;
    }
    try {
      const { useEscrow = true, disputeWindowDays = 1 } = options;
      if (useEscrow) {
        showToast(
          lang === "vi"
            ? "1/2: Đang duyệt hạn mức $GENO cho Hợp đồng Ký quỹ..."
            : "1/2: Approving $GENO allowance to Escrow Contract...",
          "info"
        );
        await purchaseDatasetWithEscrow({
          dataset,
          disputeWindowDays,
          account,
          signer
        });
        showToast(
          lang === "vi"
            ? "Đã khóa tiền vào Ký quỹ Timelock! Hợp đồng giữ an toàn $GENO cho tới khi bàn giao khóa."
            : "Access granted with Timelock Escrow Protection! Funds held in contract until capsule delivery."
        );
      } else {
        showToast(
          lang === "vi"
            ? "1/2: Đang duyệt hạn mức $GENO cho Hợp đồng Registry..."
            : "1/2: Approving $GENO allowance to Contract...",
          "info"
        );
        await purchaseDatasetAccess({
          dataset,
          account,
          signer,
          researcherKeyPair
        });
        showToast(
          lang === "vi"
            ? `Đã cấp quyền truy cập dữ liệu #${dataset.dataId}! Sẵn sàng giải mã trên bộ nhớ.`
            : `Access granted for Dataset #${dataset.dataId}! Ready for in-memory decryption.`
        );
      }
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
      setResearcherTab("licensed");
      if (selectedAssetModal) setSelectedAssetModal(null);
    } catch (err) {
      showToast((lang === "vi" ? "Thanh toán thất bại: " : "Purchase failed: ") + (err.shortMessage || err.message), "error");
    }
  };

  // Claim 100% Escrow Refund if dispatcher fails to deliver capsule within dispute window
  const handleClaimEscrowRefund = async (dataId) => {
    try {
      showToast(
        lang === "vi"
          ? `Đang yêu cầu hoàn tiền ký quỹ 100% cho dữ liệu #${dataId}...`
          : `Initiating 100% Escrow Refund for Dataset #${dataId}...`,
        "info"
      );
      await claimDatasetEscrowRefund({ dataId, account, signer });
      showToast(
        lang === "vi"
          ? "Đã hoàn trả 100% tiền ký quỹ về ví thành công!"
          : "100% Refund claimed successfully! Access revoked and tokens returned."
      );
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
    } catch (err) {
      showToast((lang === "vi" ? "Yêu cầu hoàn tiền thất bại: " : "Refund claim failed: ") + (err.shortMessage || err.message), "error");
    }
  };

  // Buyer Serialized Escrow Controls (Confirm Release, Dispute, Manual Extension)
  const handleConfirmEscrow = async (dataId) => {
    await confirmCapsuleAndReleaseEscrow({ dataId, account, signer });
    await fetchOnChainDatasets(account);
    await refreshBalance(account);
  };

  const handleDisputeCapsule = async (dataId) => {
    await disputeCapsule({ dataId, account, signer });
    await fetchOnChainDatasets(account);
    await refreshBalance(account);
  };

  const handleSetManualRelease = async (dataId, manual) => {
    await setManualEscrowRelease({ dataId, manual, account, signer });
    await fetchOnChainDatasets(account);
  };

  // Seller Post-Window Release Escrow
  const handleReleaseEscrow = async (dataId, buyer) => {
    try {
      showToast(
        lang === "vi"
          ? `Đang giải phóng ký quỹ #${dataId}...`
          : `Releasing post-window escrow for Dataset #${dataId}...`,
        "info"
      );
      await releaseEscrow({ dataId, buyer, account, signer });
      showToast(t("escrowReleasedSuccess") || "Escrow released successfully!");
      await fetchOnChainDatasets(account);
      await refreshBalance(account);
    } catch (err) {
      showToast(
        (lang === "vi" ? "Giải phóng ký quỹ thất bại: " : "Release escrow failed: ") +
          (err.shortMessage || err.message),
        "error"
      );
      throw err;
    }
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
        {(wrongChain || !rpcOnline || datasets?.some((d) => d.metadataTampered)) && (
          <div
            role="alert"
            style={{
              margin: "12px 16px 0",
              padding: "10px 14px",
              borderRadius: "8px",
              background: "#7f1d1d",
              color: "#ffffff",
              border: "1px solid #ef4444",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              fontSize: "13px"
            }}
          >
            <div>
              <strong style={{ display: "block", marginBottom: "2px" }}>
                {wrongChain
                  ? t("wrongChainTitle")
                  : !rpcOnline
                    ? t("rpcOfflineTitle")
                    : t("metadataTamperBannerTitle")}
              </strong>
              <span>
                {wrongChain
                  ? formatConfiguredChainText(t("wrongChainDesc") || "", configuredChainId, configuredChainName)
                  : !rpcOnline
                    ? formatConfiguredChainText(t("rpcOfflineDesc") || "", configuredChainId, configuredChainName)
                    : t("metadataTamperBannerDesc")}
              </span>
            </div>
            {(wrongChain || !rpcOnline) && (
              <button
                type="button"
                onClick={() => (wrongChain ? connectWallet() : fetchOnChainDatasets(account))}
                style={{
                  background: "#ffffff",
                  color: "#7f1d1d",
                  border: "none",
                  borderRadius: "6px",
                  padding: "6px 12px",
                  fontWeight: 700,
                  cursor: "pointer",
                  whiteSpace: "nowrap"
                }}
              >
                {wrongChain
                  ? formatConfiguredChainText(t("switchNetworkBtn") || "", configuredChainId, configuredChainName)
                  : t("retryConnection")}
              </button>
            )}
          </div>
        )}
        {userRole === "admin" ? (
          <AdminPortal />
        ) : userRole === "donor" ? (
          <DonorPortal
            onPublishDataset={handlePublishDataset}
            onUpdateStatus={handleUpdateStatus}
            onUpdatePrice={handleUpdatePrice}
            onGrantDirectAccess={handleGrantDirectAccess}
            onDispatchCapsule={handleDispatchCapsule}
            onAuthorizeWorker={handleAuthorizeWorker}
            onUpdateBlindTags={handleUpdateBlindTags}
            onReleaseEscrow={handleReleaseEscrow}
          />
        ) : (
          <ResearcherMarketplace
            onPurchase={handlePurchaseAccess}
            onDecrypt={handleDecryptData}
            onDownload={handleDownloadFile}
            onDownloadPdf={handleDownloadPdf}
            onClaimRefund={handleClaimEscrowRefund}
            onRecordStudyReuse={handleRecordStudyReuse}
            onConfirmEscrow={handleConfirmEscrow}
            onDisputeCapsule={handleDisputeCapsule}
            onSetManualRelease={handleSetManualRelease}
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
