import React, { useState, useMemo } from "react";
import { useDatasets } from "../../context/DatasetContext";
import { useLanguage } from "../../context/LanguageContext";
import { useWeb3, CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME } from "../../context/Web3Context";
import {
  VerifiedBadgeIcon,
  EyeInspectIcon,
  LockClosedIcon,
  LockOpenIcon,
  CheckCircleIcon,
  CopyIcon,
  DnaHelixIcon,
  PopulationGlobeIcon,
  GeneticTraitIcon,
  MetabolismIcon,
  SequencingIcon,
  BenchmarkIcon,
  LayersIcon,
  ShieldCheckIcon,
  AlertTriangleIcon,
  RefreshSpinIcon
} from "../../components/icons/GenoIcons";
import GenomicVisualCover, { getDatasetCoverUrl } from "../../components/common/GenomicVisualCover";
import contractAddresses from "../../contracts/contractAddresses.json";

/**
 * Renders truthful on-chain dataset telemetry bars (Access Grants, Verified Artifacts, Blind Tags)
 */
function renderOnChainMetricBars(ds) {
  const accessBar = Math.min(22, 5 + (Number(ds?.accessCount || 0) * 4));
  const hashBar = Math.min(22, 6 + (Number(ds?.artifactHashCount || 1) * 5));
  const tagBar = Math.min(22, 5 + Math.round((Number(ds?.blindTagCount || 0) / 16) * 17));
  const activeColor = ds?.status === "Active" ? "#10b981" : "#94a3b8";
  return (
    <svg width="64" height="28" viewBox="0 0 64 28" fill="none" className="os2-sparkline-svg" aria-hidden="true">
      <rect x="10" y={25 - accessBar} width="10" height={accessBar} rx="2" fill={activeColor} opacity="0.85" />
      <rect x="27" y={25 - hashBar} width="10" height={hashBar} rx="2" fill="#38bdf8" opacity="0.85" />
      <rect x="44" y={25 - tagBar} width="10" height={tagBar} rx="2" fill="#818cf8" opacity="0.85" />
    </svg>
  );
}

const CONSORTIUM_BY_GENE = {
  ACTN3: "Sports Genomics & Muscle Performance Lab",
  HERC2: "Human Pigmentation & Melanin Atlas",
  NA12878: "NIST Genome in a Bottle (GIAB) Consortium",
  CYP1A2: "PharmGKB Hepatic Cytochrome P450 Panel",
  TAS2R38: "Sensory GPCR Receptor Genomics Group",
  EDAR: "East Asian Craniofacial & Ectoderm Atlas",
  MCM6: "Regulatory Enhancer & Metabolic Consortium",
  LCT: "Regulatory Enhancer & Metabolic Consortium",
  ABCC11: "Transmembrane ABC Transporter Project",
  ALDH2: "Acetaldehyde Metabolic Kinetics Group",
  "KHV-WGS": "1000 Genomes Project - Vietnam KHV"
};

const PREFERRED_HERO_ORDER = [2, 8, 7, 5, 9, 10, 4, 6, 3, 1];

export default function OpenSeaSpotlightShowcase({ onPurchase }) {
  const {
    datasets,
    loadingChain,
    setSelectedAssetModal,
    getLocalizedTitle,
    purchasedData,
    filterSignificance,
    setFilterSignificance
  } = useDatasets();
  const { account, setResearcherTab, showToast } = useWeb3();
  const { t, lang } = useLanguage();

  const [slideIdx, setSlideIdx] = useState(0);
  const [rightTab, setRightTab] = useState("nfts");
  const [sortMode, setSortMode] = useState("access");
  const [activeChain, setActiveChain] = useState("all");
  const [copiedContract, setCopiedContract] = useState(false);

  // Order datasets with diverse traits first so "1000 Genomes" never dominates the screen
  const diverseOrderedDatasets = useMemo(() => {
    if (!datasets || datasets.length === 0) return [];
    const byId = new Map(datasets.map((d) => [Number(d.dataId), d]));
    const ordered = [];
    for (const id of PREFERRED_HERO_ORDER) {
      if (byId.has(id)) {
        ordered.push(byId.get(id));
        byId.delete(id);
      }
    }
    for (const remaining of byId.values()) {
      ordered.push(remaining);
    }
    return ordered;
  }, [datasets]);

  const targetChainKey = `evm${CONFIGURED_CHAIN_ID}`;

  // Filter datasets by Top Category Pill + Chain Selector + Sort Mode so every top bar button visibly updates the UI
  const showcaseDatasets = useMemo(() => {
    let list = [...diverseOrderedDatasets];
    if (filterSignificance && filterSignificance !== "All") {
      list = list.filter((d) => d.clinicalSignificance === filterSignificance);
    }
    if (activeChain !== "all") {
      list = list.filter((d) => {
        if (activeChain === targetChainKey) {
          return (
            !d.chainId ||
            Number(d.chainId) === CONFIGURED_CHAIN_ID ||
            (CONFIGURED_CHAIN_ID === 31337 && (d.network === "Hardhat" || d.network === "Localhost"))
          );
        }
        return String(d.chainId) === String(activeChain);
      });
    }
    if (sortMode === "access") {
      list.sort((a, b) => (Number(b.accessCount || 0) - Number(a.accessCount || 0)) || (Number(b.dataId) - Number(a.dataId)));
    } else if (sortMode === "price") {
      list.sort((a, b) => (Number(b.price || 0) - Number(a.price || 0)) || (Number(b.dataId) - Number(a.dataId)));
    } else if (sortMode === "royalty") {
      list.sort(
        (a, b) =>
          (Number(b.accumulatedRoyalty || 0) - Number(a.accumulatedRoyalty || 0)) ||
          (Number(b.royaltyBps || 0) - Number(a.royaltyBps || 0)) ||
          (Number(b.dataId) - Number(a.dataId))
      );
    } else if (sortMode === "newest") {
      list.sort((a, b) => Number(b.dataId) - Number(a.dataId));
    }
    return list;
  }, [diverseOrderedDatasets, filterSignificance, activeChain, sortMode]);

  if (!datasets || datasets.length === 0) {
    if (!loadingChain) return null;
    return (
      <div className="os2-discover-wrapper" aria-busy="true">
        <div className="os2-subnav-row" style={{ height: "46px" }} />
        <div className="os2-discover-split-grid">
          <div className="os2-discover-left-col">
            <div
              className="os2-hero-banner-card"
              style={{
                background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
                border: "1px solid var(--border-subtle)"
              }}
            />
            <div className="os2-trending-tokens-grid" style={{ minHeight: "140px" }} />
          </div>
          <aside className="os2-right-leaderboard-aside" style={{ minHeight: "520px" }} />
        </div>
      </div>
    );
  }

  const slides = showcaseDatasets.slice(0, Math.min(8, showcaseDatasets.length));
  const safeSlideIdx = slides.length > 0 ? slideIdx % slides.length : 0;
  const featured = slides[safeSlideIdx] || showcaseDatasets[0] || null;
  const featuredPurchasedItem = featured ? purchasedData.find((p) => p.dataId === featured.dataId) : null;
  const isFeaturedPurchased = Boolean(featuredPurchasedItem);
  const isFeaturedEscrowDisputed = Boolean(featuredPurchasedItem?.escrowInfo?.isDisputed);
  const isFeaturedEscrowPendingDelivery = Boolean(
    featuredPurchasedItem?.isEscrowPending &&
    !(featuredPurchasedItem?.capsuleDelivered ?? featuredPurchasedItem?.escrowInfo?.capsuleDelivered)
  );
  const isFeaturedOwner = Boolean(featured && account && featured.owner?.toLowerCase() === account.toLowerCase());

  // Strictly truthful on-chain statistics (Zero artificial inflation)
  const totalVolume = datasets.reduce(
    (sum, d) => sum + (Number(d.price) || 0) * (Number(d.accessCount) || 0),
    0
  );
  const activeCount = datasets.filter((d) => d.status === "Active").length;
  const listedPct = datasets.length > 0 ? Math.round((activeCount / datasets.length) * 100) : 100;
  const contractAddr = contractAddresses.GenomicsRegistry || "";

  const handleCopyContract = (e) => {
    e.stopPropagation();
    if (navigator.clipboard?.writeText) {
      Promise.resolve(navigator.clipboard.writeText(contractAddr))
        .then(() => {
          setCopiedContract(true);
          showToast(t("copiedToast") || "Copied contract address!");
          setTimeout(() => setCopiedContract(false), 2000);
        })
        .catch(() => {
          showToast(lang === "vi" ? "Không có quyền ghi bộ nhớ tạm." : "Clipboard permission denied.", "error");
        });
    }
  };

  // Category Pills connected to DatasetContext.filterSignificance
  const categoryPills = [
    { id: "All", label: lang === "vi" ? "Tất cả" : "All", icon: null },
    { id: "Physical Traits & Performance", label: lang === "vi" ? "Thể chất & Cơ bắp" : "Physical Traits", icon: <GeneticTraitIcon size={14} /> },
    { id: "Sensory & Metabolism", label: lang === "vi" ? "Chuyển hóa & Vị giác" : "Metabolism", icon: <MetabolismIcon size={14} /> },
    { id: "Pharmacogenomics", label: lang === "vi" ? "Dược di truyền" : "Pharmacogenomics", icon: <SequencingIcon size={14} /> },
    { id: "Reference Benchmark", label: lang === "vi" ? "Chuẩn GIAB" : "GIAB Benchmark", icon: <BenchmarkIcon size={14} /> },
    { id: "Population Genetics", label: lang === "vi" ? "Di truyền Quần thể" : "Population WGS", icon: <PopulationGlobeIcon size={14} /> }
  ];

  // Truthful Network Filter (Single Deployed EVM Chain)
  const chains = [
    { id: "all", label: lang === "vi" ? "Tất cả" : "All", color: "#111827" },
    {
      id: targetChainKey,
      label: CONFIGURED_CHAIN_ID === 31337 ? `Local EVM (${CONFIGURED_CHAIN_ID})` : CONFIGURED_CHAIN_NAME,
      color: "#627EEA",
      symbol: <DnaHelixIcon size={12} color="#ffffff" />
    }
  ];

  const sortModes = ["access", "price", "royalty", "newest"];
  const sortModeLabels = {
    access: t("spotlightSortTopAccess") || "Top Access",
    price: t("spotlightSortTopPrice") || "Top Price",
    royalty: t("spotlightSortTopRoyalty") || "Top Royalty",
    newest: t("spotlightSortNewest") || "Newest"
  };
  const currentSortLabel = sortModeLabels[sortMode] || sortModeLabels.access;
  const handleCycleSortMode = () => {
    const nextIdx = (sortModes.indexOf(sortMode) + 1) % sortModes.length;
    setSortMode(sortModes[nextIdx]);
  };

  const renderVerificationBadge = (ds, size = 13, verifiedColor = "#0086FF") => {
    if (ds?.metadataVerificationStatus === "verified" && !ds?.metadataTampered) {
      return (
        <span data-verification-badge="verified" title={t("evmSha256Match") || "EVM SHA-256 MATCH"} style={{ display: "inline-flex", alignItems: "center" }}>
          <VerifiedBadgeIcon size={size} color={verifiedColor} />
        </span>
      );
    }
    if (ds?.metadataTampered || ds?.metadataVerificationStatus === "tampered") {
      return (
        <span data-verification-badge="tampered" title={t("evmMetadataTamperWarn")} style={{ display: "inline-flex", alignItems: "center" }}>
          <AlertTriangleIcon size={size} color="var(--accent-rose)" />
        </span>
      );
    }
    return (
      <span
        data-verification-badge={ds?.metadataVerificationStatus || "unverified"}
        title={ds?.metadataVerificationStatus === "unanchored" ? t("evmMetadataUnanchoredBadge") : t("evmMetadataUnverifiedBadge")}
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <AlertTriangleIcon size={size} color="var(--accent-amber)" />
      </span>
    );
  };

  // Trending Tokens for the 4x2 Sparkline Grid
  const trendingTokens = showcaseDatasets.slice(0, 8);

  // Featured Collections (4-Card Row matching OpenSea second viewport)
  const featuredCollections = showcaseDatasets.slice(0, 4);

  // Right Leaderboard Datasets sorted dynamically by static catalog sort mode
  const leaderboardDatasets = [...showcaseDatasets];

  const featuredGeneKey = featured
    ? (featured.geneSymbol?.split(" ")?.[0] || featured.gene?.split(" ")?.[0] || "ACTN3")
    : "";
  const featuredConsortium = CONSORTIUM_BY_GENE[featuredGeneKey] || "OpenGenomics DeSci Consortium";

  // 3 Square Thumbnails on the bottom-right of the Hero Banner
  const heroThumbIndices = slides.length <= 3
    ? slides.map((_, idx) => idx)
    : [
        safeSlideIdx,
        (safeSlideIdx + 1) % slides.length,
        (safeSlideIdx + 2) % slides.length
      ];

  return (
    <div className="os2-discover-wrapper">
      {/* ─── 1. TOP SUB-NAVIGATION ROW: Category Pills + Chain Selector + Right Table Controls ─── */}
      <div className="os2-subnav-row">
        {/* Left: Category Filter Pills */}
        <div className="os2-category-pills">
          {categoryPills.map((cat) => {
            const isActive = (filterSignificance || "All") === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                className={`os2-cat-pill ${isActive ? "active" : ""}`}
                onClick={() => {
                  setFilterSignificance(cat.id);
                  setSlideIdx(0);
                }}
              >
                {cat.icon && <span className="os2-cat-icon">{cat.icon}</span>}
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* Middle: Chain Selector Icons */}
        <div className="os2-chain-selector">
          {chains.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`os2-chain-btn ${activeChain === c.id ? "active" : ""}`}
              onClick={() => {
                setActiveChain(c.id);
                setSlideIdx(0);
              }}
              title={c.label}
            >
              {c.id === "all" ? (
                <span>{lang === "vi" ? "Tất cả" : "All"}</span>
              ) : (
                <span className="os2-chain-dot" style={{ background: c.color }}>
                  {c.symbol}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Right: Leaderboard Controls (Datasets | Variants | Escrow + Timeframe) */}
        <div className="os2-right-table-controls">
          <div className="os2-segmented-group">
            <button
              type="button"
              className={`os2-seg-btn ${rightTab === "nfts" ? "active" : ""}`}
              onClick={() => setRightTab("nfts")}
              title={t("showcaseTabDatasets")}
            >
              <LayersIcon size={13} />
              <span>{t("showcaseTabDatasets")}</span>
            </button>
            <button
              type="button"
              className={`os2-seg-btn ${rightTab === "tokens" ? "active" : ""}`}
              onClick={() => setRightTab("tokens")}
              title={t("showcaseTabVariants")}
            >
              <DnaHelixIcon size={13} />
              <span>{t("showcaseTabVariants")}</span>
            </button>
            <button
              type="button"
              className={`os2-seg-btn ${rightTab === "perps" ? "active" : ""}`}
              onClick={() => setRightTab("perps")}
              title={t("showcaseTabEscrow")}
            >
              <ShieldCheckIcon size={13} />
              <span>{t("showcaseTabEscrow")}</span>
            </button>
          </div>

          <button
            type="button"
            className="os2-timeframe-btn"
            data-sort-mode={sortMode}
            onClick={handleCycleSortMode}
            title={t("spotlightSortCycleHint")}
            aria-label={`${t("spotlightSortCycleHint")}: ${currentSortLabel}`}
          >
            <span>{currentSortLabel}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* ─── 2. MAIN 2-COLUMN SPLIT LAYOUT (Left: Hero + Trending Tokens + Featured Collections | Right: Leaderboard) ─── */}
      {showcaseDatasets.length === 0 || !featured ? (
        <div
          data-spotlight-empty="true"
          style={{
            padding: "40px 24px",
            marginTop: "12px",
            borderRadius: "var(--radius-lg, 14px)",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-surface-elevated)",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px"
          }}
        >
          <DnaHelixIcon size={28} color="var(--accent-cyan)" />
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
            {t("spotlightEmptyTitle")}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", maxWidth: "460px" }}>
            {t("spotlightEmptyDesc")}
          </div>
          <button
            type="button"
            className="btn-terminal btn-terminal-primary"
            style={{ marginTop: "6px", height: "34px", padding: "0 16px", fontSize: "12.5px", fontWeight: 700 }}
            onClick={() => {
              setFilterSignificance("All");
              setActiveChain("all");
              setSlideIdx(0);
            }}
          >
            {t("spotlightResetFilterBtn")}
          </button>
        </div>
      ) : (
      <div className="os2-discover-split-grid">
        {/* LEFT COLUMN */}
        <div className="os2-discover-left-col">
          {/* A. Full-Bleed Hero Banner with 3D Molecular Artwork & 3 Square Thumbnails */}
          <div className="os2-hero-banner-wrap">
            <div
              className="os2-hero-banner-card"
              onClick={() => setSelectedAssetModal(featured)}
            >
              {/* Full-Bleed High-Resolution 3D Molecular Cover Image */}
              <div className="os2-hero-mosaic-bg">
                <img
                  src={getDatasetCoverUrl(featured)}
                  alt={featured.disease}
                  className="os2-hero-cover-img"
                />
                <div className="os2-hero-gradient-scrim" />
              </div>

              {/* Left / Right Slide Navigation Arrows */}
              <button
                type="button"
                className="os2-hero-nav-arrow prev"
                onClick={(e) => {
                  e.stopPropagation();
                  setSlideIdx((prev) => (prev - 1 + slides.length) % slides.length);
                }}
                aria-label="Previous spotlight cohort"
              >
                ‹
              </button>
              <button
                type="button"
                className="os2-hero-nav-arrow next"
                onClick={(e) => {
                  e.stopPropagation();
                  setSlideIdx((prev) => (prev + 1) % slides.length);
                }}
                aria-label="Next spotlight cohort"
              >
                ›
              </button>

              {/* Bottom-Left Overlay: Title + Author + Dark Frosted Glass Stats Box */}
              <div className="os2-hero-overlay-left" onClick={(e) => e.stopPropagation()}>
                <div
                  className="os2-hero-title-line"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedAssetModal(featured)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedAssetModal(featured);
                    }
                  }}
                >
                  <h2 className="os2-hero-title">
                    {featuredGeneKey} -{" "}
                    {getLocalizedTitle ? getLocalizedTitle(featured, lang) : featured.disease}
                  </h2>
                  {renderVerificationBadge(featured, 20, "#0086FF")}
                </div>

                <div className="os2-hero-author-line">
                  <span>{lang === "vi" ? "Đơn vị:" : "By"} {featuredConsortium}</span>
                  {featured.metadataVerificationStatus === "verified" && !featured.metadataTampered && (
                    <VerifiedBadgeIcon size={13} color="#9ca3af" />
                  )}
                  <span className="os2-hero-dot">•</span>
                  <span className="os2-hero-locus-pill">
                    {featured.chromosome}:{featured.rsId}
                  </span>
                  <span className="os2-hero-dot">•</span>
                  <button
                    type="button"
                    className="os2-hero-contract-chip"
                    onClick={handleCopyContract}
                    title="Copy GenomicsRegistry Contract Address"
                  >
                    <span>{contractAddr.length >= 42 ? `${contractAddr.slice(0, 6)}...${contractAddr.slice(38)}` : (contractAddr || "N/A")}</span>
                    {copiedContract ? <CheckCircleIcon size={11} color="#10b981" /> : <CopyIcon size={11} />}
                  </button>
                </div>

                {/* Dark Frosted Glass Stats Box (FLOOR PRICE | ITEMS | TOTAL VOLUME | LISTED) */}
                <div className="os2-hero-stats-glass">
                  <div className="os2-hero-stat-col">
                    <span className="os2-hero-stat-label">{t("statFloorPrice").toUpperCase()}</span>
                    <span className="os2-hero-stat-val">{featured.price} $GENO</span>
                  </div>
                  <div className="os2-hero-stat-col">
                    <span className="os2-hero-stat-label">{t("statItemsCount").toUpperCase()}</span>
                    <span className="os2-hero-stat-val">{datasets.length}</span>
                  </div>
                  <div className="os2-hero-stat-col" title={t("spotlightEstVolumeTooltip")}>
                    <span className="os2-hero-stat-label">{(t("spotlightEstVolume") || "Est. License Value").toUpperCase()}</span>
                    <span className="os2-hero-stat-val">{totalVolume.toLocaleString()} $GENO</span>
                  </div>
                  <div className="os2-hero-stat-col">
                    <span className="os2-hero-stat-label">{t("heroListedLabel")}</span>
                    <span className="os2-hero-stat-val">
                      {activeCount} ({listedPct}%)
                    </span>
                  </div>

                  {/* Action Buttons inside Glass Bar */}
                  <div className="os2-hero-actions">
                    <button
                      type="button"
                      className="os2-hero-btn-ghost"
                      onClick={() => setSelectedAssetModal(featured)}
                    >
                      <EyeInspectIcon size={13} />
                      <span>{t("inspectProofs") || "Inspect"}</span>
                    </button>

                    {isFeaturedOwner ? (
                      <span className="os2-hero-owner-tag">{t("btnYourDataset")}</span>
                    ) : isFeaturedPurchased ? (
                      <button
                        type="button"
                        className={
                          isFeaturedEscrowDisputed
                            ? "os2-hero-btn-disputed"
                            : isFeaturedEscrowPendingDelivery
                              ? "os2-hero-btn-pending"
                              : "os2-hero-btn-licensed"
                        }
                        onClick={() => setResearcherTab("licensed")}
                      >
                        {isFeaturedEscrowDisputed ? (
                          <>
                            <AlertTriangleIcon size={13} />
                            <span>{t("escrowStatusDisputed")}</span>
                          </>
                        ) : isFeaturedEscrowPendingDelivery ? (
                          <>
                            <RefreshSpinIcon size={13} />
                            <span>{t("escrowPendingDelivery")}</span>
                          </>
                        ) : (
                          <>
                            <LockOpenIcon size={13} />
                            <span>{t("btnPurchased")}</span>
                          </>
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="os2-hero-btn-buy"
                        disabled={featured.status !== "Active" || Boolean(featured.metadataTampered)}
                        title={featured.metadataTampered ? t("evmMetadataTamperWarn") : undefined}
                        onClick={() => onPurchase?.(featured)}
                      >
                        <LockClosedIcon size={13} />
                        <span>
                          {featured.metadataTampered
                            ? t("btnMetadataTampered")
                            : featured.status !== "Active"
                              ? (featured.status === "Revoked" ? t("statusRevoked") : t("statusPaused"))
                              : t("btnPurchase")}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Bottom-Right Overlay: 3 Square White-Framed High-Res 3D Thumbnails */}
              <div className="os2-hero-thumbnails-right" onClick={(e) => e.stopPropagation()}>
                {heroThumbIndices.map((sIdx) => {
                  const item = slides[sIdx];
                  if (!item) return null;
                  const isCurrent = featured.dataId === item.dataId;
                  return (
                    <button
                      key={item.dataId}
                      type="button"
                      className={`os2-hero-thumb-card ${isCurrent ? "active" : ""}`}
                      onClick={() => setSlideIdx(sIdx)}
                      title={getLocalizedTitle ? getLocalizedTitle(item, lang) : item.disease}
                    >
                      <img
                        src={getDatasetCoverUrl(item)}
                        alt={item.geneSymbol}
                        className="os2-hero-thumb-img"
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Carousel Pagination Dash Indicators */}
            <div className="os2-hero-pagination">
              {slides.map((s, idx) => (
                <button
                  key={s.dataId}
                  type="button"
                  className={`os2-page-dash ${idx === safeSlideIdx ? "active" : ""}`}
                  onClick={() => setSlideIdx(idx)}
                  aria-label={`Slide ${idx + 1}`}
                />
              ))}
            </div>
          </div>

          {/* B. Trending Tokens Section (4x2 Grid with Real 3D Avatars & Sparklines) */}
          <div id="os2-trending-tokens-section" className="os2-trending-section">
            <div className="os2-section-header">
              <h2 className="os2-section-title">{t("trendingTokens")}</h2>
              <p className="os2-section-subtitle">
                {t("trendingTokensSub")}
              </p>
            </div>

            <div className="os2-trending-tokens-grid">
              {trendingTokens.map((ds) => {
                const geneName = ds.geneSymbol?.split(" ")?.[0] || ds.gene?.split(" ")?.[0] || `GENO-${ds.dataId}`;
                return (
                  <div
                    key={ds.dataId}
                    className="os2-token-card"
                    onClick={() => setSelectedAssetModal(ds)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedAssetModal(ds);
                      }
                    }}
                  >
                    <div className="os2-token-card-left">
                      <div className="os2-token-circle-icon">
                        <img
                          src={getDatasetCoverUrl(ds)}
                          alt={geneName}
                          className="os2-token-avatar-img"
                        />
                      </div>
                      <div className="os2-token-info">
                        <div className="os2-token-name-row">
                          <span className="os2-token-name">{geneName}</span>
                          {renderVerificationBadge(ds, 12, "#0086FF")}
                        </div>
                        <div className="os2-token-price-row">
                          <span className="os2-token-price">{ds.price} $GENO</span>
                          <span className="os2-token-change positive">
                            {ds.rsId || `chr${ds.dataId}`}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="os2-token-card-right">
                      {renderOnChainMetricBars(ds)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* C. Featured Collections 4-Card Row (Matching OpenSea OS2 Second Viewport) */}
          <div className="os2-featured-collections-strip">
            <div className="os2-section-header">
              <h2 className="os2-section-title">{t("featuredCollectionsTitle")}</h2>
              <p className="os2-section-subtitle">
                {t("featuredCollectionsSub")}
              </p>
            </div>

            <div className="os2-featured-strip-grid">
              {featuredCollections.map((ds) => {
                const geneName = ds.geneSymbol?.split(" ")?.[0] || ds.gene;
                const displayTitle = getLocalizedTitle ? getLocalizedTitle(ds, lang) : ds.disease;
                return (
                  <div
                    key={ds.dataId}
                    className="os2-featured-strip-card"
                    onClick={() => setSelectedAssetModal(ds)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedAssetModal(ds);
                      }
                    }}
                  >
                    <img
                      src={getDatasetCoverUrl(ds)}
                      alt={displayTitle}
                      className="os2-featured-strip-img"
                    />
                    <div className="os2-featured-strip-scrim" />
                    <div className="os2-featured-strip-overlay">
                      <div className="os2-featured-strip-title-row">
                        <span className="os2-featured-strip-title">
                          {geneName} - {displayTitle}
                        </span>
                        {renderVerificationBadge(ds, 14, "#0086FF")}
                      </div>
                      <div className="os2-featured-strip-meta">
                        <span>{t("showcaseColFloor")}: {ds.price} $GENO</span>
                        <span className="os2-featured-strip-badge">{ds.chromosome}:{ds.rsId}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT STICKY LEADERBOARD COLUMN */}
        <aside className="os2-right-leaderboard-aside" aria-label={t("showcaseColCohort")}>
          <div className="os2-leaderboard-col-headers">
            <span>
              {rightTab === "tokens"
                ? (lang === "vi" ? "LOCUS BIẾN THỂ" : "VARIANT LOCUS")
                : rightTab === "perps"
                  ? (lang === "vi" ? "KÝ QUỸ ESCROW" : "ESCROW LEASE")
                  : `${t("showcaseColCohort").toUpperCase()} (${currentSortLabel.toUpperCase()})`}
            </span>
            <span>
              {rightTab === "tokens"
                ? (lang === "vi" ? "GIÁ / rsID" : "PRICE / VAR")
                : rightTab === "perps"
                  ? (lang === "vi" ? "BẢO VỆ" : "PROTECTION")
                  : t("showcaseColFloor").toUpperCase()}
            </span>
          </div>

          <div className="os2-leaderboard-rows">
            {leaderboardDatasets.map((ds) => {
              const displayTitle = getLocalizedTitle ? getLocalizedTitle(ds, lang) : ds.disease;
              const geneSym = ds.geneSymbol?.split(" ")?.[0] || ds.gene;
              const salesCount = Number(ds.accessCount) || 0;
              return (
                <div
                  key={ds.dataId}
                  className="os2-leaderboard-row"
                  onClick={() => setSelectedAssetModal(ds)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedAssetModal(ds);
                    }
                  }}
                >
                  <div className="os2-lb-left">
                    <div className="os2-lb-thumb">
                      <img
                        src={getDatasetCoverUrl(ds)}
                        alt={geneSym}
                        className="os2-lb-thumb-img"
                      />
                    </div>
                    <div className="os2-lb-name-wrap">
                      <span className="os2-lb-name" title={displayTitle}>
                        {rightTab === "tokens"
                          ? `${geneSym} (${ds.chromosome})`
                          : `${geneSym} - ${displayTitle}`}
                      </span>
                      {renderVerificationBadge(ds, 13, "#0086FF")}
                    </div>
                  </div>

                  <div className="os2-lb-right">
                    {rightTab === "tokens" ? (
                      <>
                        <span className="os2-lb-floor">{ds.price} $GENO</span>
                        <span className="os2-lb-sub pos">{ds.rsId}</span>
                      </>
                    ) : rightTab === "perps" ? (
                      <>
                        <span className="os2-lb-floor">{ds.durationDays} {t("durationDays")}</span>
                        <span className="os2-lb-sub pos">{t("escrow24hBadge")}</span>
                      </>
                    ) : (
                      <>
                        <span className="os2-lb-floor">{ds.price} $GENO</span>
                        <span className={`os2-lb-sub ${ds.status === "Active" ? "pos" : "neg"}`}>
                          {ds.status === "Active"
                            ? salesCount > 0
                              ? `${salesCount} ${lang === "vi" ? "lượt" : "sales"}`
                              : `+${Number(((ds.royaltyBps ?? 1000) / 100).toFixed(2))}% EIP-2981`
                            : ds.status}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
      )}
    </div>
  );
}
