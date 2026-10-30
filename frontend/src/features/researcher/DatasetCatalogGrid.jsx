import React from "react";
import {
  DnaHelixIcon,
  CheckCircleIcon,
  EyeInspectIcon,
  LockClosedIcon,
  LockOpenIcon,
  VerifiedBadgeIcon,
  GenoTokenIcon,
  ShieldCheckIcon
} from "../../components/icons/GenoIcons";
import GenomicVisualCover from "../../components/common/GenomicVisualCover";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";

export default function DatasetCatalogGrid({ onPurchase }) {
  const { account, setResearcherTab } = useWeb3();
  const {
    filteredDatasets,
    purchasedData,
    loadingChain,
    setSelectedAssetModal,
    getLocalizedTitle,
    getLocalizedSignificance
  } = useDatasets();
  const { t, lang } = useLanguage();

  return (
    <div className="opensea-nft-grid">
      {filteredDatasets.map((ds) => {
        const isPurchased = purchasedData.some((p) => p.dataId === ds.dataId);
        const isOwner = account && ds.owner.toLowerCase() === account.toLowerCase();
        const displayTitle = getLocalizedTitle ? getLocalizedTitle(ds, lang) : ds.disease;
        const displayCategory = getLocalizedSignificance
          ? getLocalizedSignificance(ds.clinicalSignificance, lang)
          : (ds.clinicalSignificance || "Physiological Traits");

        return (
          <div
            key={ds.dataId}
            className="opensea-nft-card"
            onClick={() => setSelectedAssetModal(ds)}
          >
            {/* 1. Media Artwork Wrapper with Aspect Ratio & Zoom Animation */}
            <div className="nft-card-media-wrap">
              <div className="nft-card-image-scaler">
                <GenomicVisualCover dataset={ds} height={190} showAvatar={false} showBadges={false} />
              </div>

              {/* Top Floating Badges */}
              <div className="nft-card-overlay-top">
                <div className="nft-gene-badge">
                  <span className="gene-name">{ds.geneSymbol?.split(" ")?.[0] || ds.gene}</span>
                  <span className="gene-chrom">{ds.chromosome || "chr12"}</span>
                </div>
                <div className="nft-format-badge">
                  <span>{ds.format || "VCF v4.2"}</span>
                </div>
              </div>

              {/* Hover Quick Action Eye Button */}
              <button
                type="button"
                className="nft-hover-inspect-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedAssetModal(ds);
                }}
                title={t("inspectProofs") || "View Details"}
              >
                <EyeInspectIcon size={16} />
              </button>
            </div>

            {/* 2. Card Content & Metadata Hierarchy */}
            <div className="nft-card-content">
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
                <VerifiedBadgeIcon size={12} color="var(--accent-cyan)" />
                <span className="nft-token-id">#{String(ds.dataId).padStart(2, "0")}</span>
              </div>

              {/* Dataset Title */}
              <h4 className="nft-card-title" title={displayTitle}>
                {displayTitle}
              </h4>

              {/* Trait & Biological Chips */}
              <div className="nft-traits-row">
                <span className="nft-trait-pill">
                  {displayCategory}
                </span>
                <span className="nft-trait-pill mono">
                  {ds.rsId || "rs671"}
                </span>
                <span className="nft-trait-pill subtle">
                  {ds.ancestry ? ds.ancestry.split(" ")?.[0] : "KHV"}
                </span>
              </div>
            </div>

            {/* 3. Card Footer: OpenSea High-Contrast Price & Quick Actions */}
            <div
              className="nft-card-footer"
              onClick={(e) => e.stopPropagation()}
            >
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
                    className="btn-terminal btn-terminal-success btn-card-action"
                    onClick={() => setResearcherTab("licensed")}
                    type="button"
                  >
                    <LockOpenIcon size={13} color="var(--accent-emerald)" />
                    <span>{t("btnPurchased")}</span>
                  </button>
                ) : (
                  <button
                    className="btn-terminal btn-terminal-primary btn-card-action"
                    onClick={() => onPurchase?.(ds)}
                    disabled={ds.status !== "Active"}
                    type="button"
                  >
                    <LockClosedIcon size={13} />
                    <span>{t("btnPurchase")}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Empty State (Only shown after chain sync completes) */}
      {!loadingChain && filteredDatasets.length === 0 && (
        <div className="opensea-empty-state">
          <DnaHelixIcon size={48} color="var(--text-muted)" />
          <h3 className="empty-title">
            {t("noDatasetsFound") || "No Genomic Datasets Found"}
          </h3>
          <p className="empty-desc">
            Không tìm thấy bộ dữ liệu di truyền phù hợp với bộ lọc hiện tại. Vui lòng thử lại với từ khóa khác hoặc xóa bộ lọc.
          </p>
        </div>
      )}
    </div>
  );
}
