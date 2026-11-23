import React from "react";
import {
  DnaHelixIcon,
  CheckCircleIcon,
  EyeInspectIcon,
  LockClosedIcon,
  LockOpenIcon,
  VerifiedBadgeIcon,
  GenoTokenIcon,
  ShieldCheckIcon,
  AlertTriangleIcon,
  RefreshSpinIcon
} from "../../components/icons/GenoIcons";
import GenomicVisualCover from "../../components/common/GenomicVisualCover";
import { useWeb3, CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import { formatConfiguredChainText } from "../../utils/asyncResilience";

export default function DatasetCatalogGrid({ onPurchase }) {
  const { account, setResearcherTab } = useWeb3();
  const {
    filteredDatasets,
    purchasedData,
    loadingChain,
    catalogError,
    fetchOnChainDatasets,
    setSelectedAssetModal,
    getLocalizedTitle,
    getLocalizedSignificance
  } = useDatasets();
  const { t, lang } = useLanguage();

  return (
    <div className="opensea-nft-grid">
      {filteredDatasets.map((ds) => {
        const purchasedItem = purchasedData.find((p) => p.dataId === ds.dataId);
        const isPurchased = Boolean(purchasedItem);
        const isEscrowDisputed = Boolean(purchasedItem?.escrowInfo?.isDisputed);
        const isEscrowPendingDelivery = Boolean(
          purchasedItem?.isEscrowPending &&
          !(purchasedItem?.capsuleDelivered ?? purchasedItem?.escrowInfo?.capsuleDelivered)
        );
        const isOwner = account && ds.owner.toLowerCase() === account.toLowerCase();
        const displayTitle = getLocalizedTitle ? getLocalizedTitle(ds, lang) : ds.disease;
        const displayCategory = getLocalizedSignificance
          ? getLocalizedSignificance(ds.clinicalSignificance, lang)
          : (ds.clinicalSignificance || "Physiological Traits");

        return (
          <article
            key={ds.dataId}
            className="opensea-nft-card"
          >
            {/* 1. Media Artwork Wrapper with Aspect Ratio & Zoom Animation */}
            <div className="nft-card-media-wrap">
              <button
                type="button"
                className="nft-card-image-scaler"
                onClick={() => setSelectedAssetModal(ds)}
                aria-label={`${t("inspectProofs") || "View Details"}: ${displayTitle}`}
              >
                <GenomicVisualCover dataset={ds} height={190} showAvatar={false} showBadges={false} />
              </button>

              {/* Top Floating Badges */}
              <div className="nft-card-overlay-top">
                <div className="nft-gene-badge">
                  <span className="gene-name">{ds.geneSymbol?.split(" ")?.[0] || ds.gene || "—"}</span>
                  <span className="gene-chrom">{ds.chromosome || "—"}</span>
                </div>
                <div className="nft-format-badge">
                  <span>{ds.format || "VCF v4.2"}</span>
                </div>
              </div>

              {/* Hover Quick Action Eye Button */}
              <button
                type="button"
                className="nft-hover-inspect-btn"
                onClick={() => setSelectedAssetModal(ds)}
                title={t("inspectProofs") || "View Details"}
                aria-label={t("inspectProofs") || "View Details"}
              >
                <EyeInspectIcon size={16} />
              </button>
            </div>

            {/* 2. Card Content & Metadata Hierarchy (single clean non-nested interactive target) */}
            <div
              className="nft-card-content"
              role="button"
              tabIndex={0}
              onClick={() => setSelectedAssetModal(ds)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedAssetModal(ds);
                }
              }}
            >
              {/* Creator / Collection Byline */}
              <div className="nft-card-creator-row">
                <div className="nft-creator-avatar">
                  <DnaHelixIcon size={12} color="var(--accent-cyan)" />
                </div>
                <span className="nft-creator-name">
                  {lang === "vi"
                    ? ds.categoryVi || ds.clinicalSignificance
                    : ds.categoryEn || ds.clinicalSignificance}
                </span>
                {ds.metadataVerificationStatus === "verified" && !ds.metadataTampered ? (
                  <span data-verification-badge="verified" title={t("evmSha256Match") || "EVM SHA-256 MATCH"} style={{ display: "inline-flex", alignItems: "center" }}>
                    <VerifiedBadgeIcon size={12} color="var(--accent-cyan)" />
                  </span>
                ) : ds.metadataTampered || ds.metadataVerificationStatus === "tampered" ? (
                  <span data-verification-badge="tampered" title={t("evmMetadataTamperWarn")} style={{ display: "inline-flex", alignItems: "center" }}>
                    <AlertTriangleIcon size={12} color="var(--accent-rose)" />
                  </span>
                ) : (
                  <span
                    data-verification-badge={ds.metadataVerificationStatus || "unverified"}
                    title={ds.metadataVerificationStatus === "unanchored" ? t("evmMetadataUnanchoredBadge") : t("evmMetadataUnverifiedBadge")}
                    style={{ display: "inline-flex", alignItems: "center" }}
                  >
                    <AlertTriangleIcon size={12} color="var(--accent-amber)" />
                  </span>
                )}
                <span className="nft-token-id">#{String(ds.dataId).padStart(2, "0")}</span>
              </div>

              {/* Dataset Title */}
              <h3 className="nft-card-title" title={displayTitle}>
                {displayTitle}
              </h3>

              {/* Trait & Biological Chips */}
              <div className="nft-traits-row">
                <span className="nft-trait-pill">
                  {displayCategory}
                </span>
                <span className="nft-trait-pill mono">
                  {ds.rsId || "—"}
                </span>
                <span className="nft-trait-pill subtle">
                  {ds.ancestry ? ds.ancestry.split(" ")?.[0] : "—"}
                </span>
              </div>
            </div>

            {/* 3. Card Footer: OpenSea High-Contrast Price & Quick Actions */}
            <div className="nft-card-footer">
              <div>
                <div className="nft-price-label">
                  {t("priceLabel") || "PRICE"}
                </div>
                <div className="nft-price-value">
                  <GenoTokenIcon size={15} color="var(--accent-cyan)" />
                  <span>{ds.price} $GENO</span>
                </div>
              </div>

              <div className="nft-card-actions">
                {isOwner ? (
                  <span className="owner-chip" style={{ fontSize: "11px", padding: "4px 8px" }}>
                    {t("btnYourDataset")}
                  </span>
                ) : isPurchased ? (
                  <button
                    className={`btn-terminal ${isEscrowDisputed || isEscrowPendingDelivery ? "" : "btn-terminal-success"} btn-card-action`}
                    style={
                      isEscrowDisputed
                        ? {
                            color: "var(--accent-rose-text)",
                            borderColor: "var(--accent-rose)",
                            background: "rgba(239, 68, 68, 0.14)"
                          }
                        : isEscrowPendingDelivery
                          ? {
                              color: "var(--accent-amber-text)",
                              borderColor: "var(--accent-amber)",
                              background: "rgba(245, 158, 11, 0.14)"
                            }
                          : undefined
                    }
                    onClick={() => setResearcherTab("licensed")}
                    type="button"
                  >
                    {isEscrowDisputed ? (
                      <>
                        <AlertTriangleIcon size={13} color="var(--accent-rose-text)" />
                        <span>{t("escrowStatusDisputed")}</span>
                      </>
                    ) : isEscrowPendingDelivery ? (
                      <>
                        <RefreshSpinIcon size={13} />
                        <span>{t("escrowPendingDelivery")}</span>
                      </>
                    ) : (
                      <>
                        <LockOpenIcon size={13} color="var(--accent-emerald)" />
                        <span>{t("btnPurchased")}</span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    className="btn-terminal btn-terminal-primary btn-card-action"
                    onClick={() => onPurchase?.(ds)}
                    disabled={ds.status !== "Active" || Boolean(ds.metadataTampered)}
                    title={ds.metadataTampered ? t("evmMetadataTamperWarn") : undefined}
                    type="button"
                  >
                    <LockClosedIcon size={13} />
                    <span>{ds.metadataTampered ? t("btnMetadataTampered") : t("btnPurchase")}</span>
                  </button>
                )}
              </div>
            </div>
          </article>
        );
      })}

      {/* Empty State (Only shown after chain sync completes) */}
      {!loadingChain && filteredDatasets.length === 0 && (
        catalogError ? (
          <div
            className="opensea-empty-state rpc-error-state"
            role="alert"
            style={{
              border: "1px dashed var(--accent-rose)",
              background: "var(--accent-rose-subtle)",
              padding: "32px 24px",
              borderRadius: "var(--radius-sm)",
              textAlign: "center",
              gridColumn: "1 / -1"
            }}
          >
            <AlertTriangleIcon size={44} color="var(--accent-rose-text)" />
            <h3 className="empty-title" style={{ color: "var(--accent-rose-text)", marginTop: "12px", fontSize: "16px", fontWeight: 700 }}>
              {t("rpcOfflineTitle") || "Mất kết nối Node RPC Blockchain"}
            </h3>
            <p className="empty-desc" style={{ color: "var(--text-secondary)", maxWidth: "520px", margin: "8px auto 16px" }}>
              {formatConfiguredChainText(
                t("rpcOfflineDesc") || "Không thể đồng bộ danh mục hệ gen on-chain do cổng RPC Ethereum không phản hồi hoặc bị ngắt kết nối.",
                CONFIGURED_CHAIN_ID,
                CONFIGURED_CHAIN_NAME
              )}
            </p>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-secondary)", marginBottom: "16px" }}>
              RPC: {catalogError}
            </div>
            <button
              type="button"
              className="btn-terminal btn-terminal-primary"
              onClick={() => fetchOnChainDatasets?.(account)}
              style={{ padding: "0 20px", height: "36px", fontSize: "12px", margin: "0 auto" }}
            >
              <RefreshSpinIcon size={13} />
              <span>{t("retryConnection") || "Thử lại kết nối RPC"}</span>
            </button>
          </div>
        ) : (
          <div className="opensea-empty-state">
            <DnaHelixIcon size={48} color="var(--text-muted)" />
            <h3 className="empty-title">
              {t("noDatasetsFound") || "No Genomic Datasets Found"}
            </h3>
            <p className="empty-desc">
              {t("noDatasetsFoundDesc")}
            </p>
          </div>
        )
      )}
    </div>
  );
}