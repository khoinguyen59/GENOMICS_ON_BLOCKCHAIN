import React, { useState, useMemo } from "react";
import { useDatasets } from "../../context/DatasetContext";
import { useLanguage } from "../../context/LanguageContext";
import { useWeb3 } from "../../context/Web3Context";
import {
  VerifiedBadgeIcon,
  EyeInspectIcon,
  LockClosedIcon,
  LockOpenIcon,
  CheckCircleIcon,
  CopyIcon
} from "../../components/icons/GenoIcons";
import GenomicVisualCover, { getDatasetCoverUrl } from "../../components/common/GenomicVisualCover";
import contractAddresses from "../../contracts/contractAddresses.json";

/**
 * Generates a deterministic SVG sparkline path from a dataset's rawDataHash
 */
function renderDeterministicSparkline(hashStr = "0x1234567890abcdef", isPositive = true) {
  const clean = (hashStr || "").replace(/^0x/, "").padEnd(16, "a");
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const byteVal = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 128;
    const x = Math.round((i / 7) * 60) + 2;
    const trendOffset = isPositive ? (7 - i) * 1.8 : i * 1.5;
    const y = Math.max(4, Math.min(24, Math.round(6 + (byteVal % 12) + trendOffset * 0.6)));
    pts.push(`${x},${y}`);
  }
  const strokeColor = isPositive ? "#10b981" : "#ef4444";
  return (
    <svg width="64" height="28" viewBox="0 0 64 28" fill="none" className="os2-sparkline-svg">
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts.join(" ")}
      />
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
  "KHV-WGS": "1000 Genomes Project — Vietnam KHV"
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
  const [timeframe, setTimeframe] = useState("1d");
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

  // Filter datasets by Top Category Pill + Chain Selector so every top bar button visibly updates the UI
  const showcaseDatasets = useMemo(() => {
    let list = diverseOrderedDatasets;
    if (filterSignificance && filterSignificance !== "All") {
      const catFiltered = list.filter((d) => d.clinicalSignificance === filterSignificance);
      if (catFiltered.length > 0) list = catFiltered;
    }
    if (activeChain !== "all") {
      const chainFiltered = list.filter((d) => {
        const id = Number(d.dataId);
        if (activeChain === "eth") return [2, 7, 8, 5, 1].includes(id);
        if (activeChain === "sol") return [8, 9, 10, 4].includes(id);
        if (activeChain === "base") return [5, 6, 3, 2].includes(id);
        if (activeChain === "arb") return [7, 4, 9, 1].includes(id);
        if (activeChain === "poly") return [10, 6, 3, 8].includes(id);
        return true;
      });
      if (chainFiltered.length > 0) list = chainFiltered;
    }
    return list;
  }, [diverseOrderedDatasets, filterSignificance, activeChain]);

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
  const featured = slides[safeSlideIdx] || showcaseDatasets[0] || datasets[0];
  const isFeaturedPurchased = purchasedData.some((p) => p.dataId === featured.dataId);
  const isFeaturedOwner = account && featured.owner?.toLowerCase() === account.toLowerCase();

  // Strictly truthful on-chain statistics (Zero artificial inflation)
  const totalVolume = datasets.reduce(
    (sum, d) => sum + (Number(d.price) || 0) * (Number(d.accessCount) || 0),
    0
  );
  const activeCount = datasets.filter((d) => d.status === "Active").length;
  const listedPct = datasets.length > 0 ? Math.round((activeCount / datasets.length) * 100) : 100;
  const contractAddr = contractAddresses.GenomicsRegistry || "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";

  const handleCopyContract = (e) => {
    e.stopPropagation();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(contractAddr);
      setCopiedContract(true);
      showToast(t("copiedToast") || "Copied contract address!");
      setTimeout(() => setCopiedContract(false), 2000);
    }
  };

  // Category Pills matching OpenSea OS2 top bar (connected to DatasetContext.filterSignificance)
  const categoryPills = [
    { id: "All", label: lang === "vi" ? "Tất cả" : "All", icon: null },
    { id: "Physical Traits & Performance", label: lang === "vi" ? "Thể chất & Cơ bắp" : "Physical Traits", icon: "🏃" },
    { id: "Sensory & Metabolism", label: lang === "vi" ? "Chuyển hóa & Vị giác" : "Metabolism", icon: "🧪" },
    { id: "Pharmacogenomics", label: lang === "vi" ? "Dược di truyền" : "Pharmacogenomics", icon: "💊" },
    { id: "Reference Benchmark", label: lang === "vi" ? "Chuẩn GIAB" : "GIAB Benchmark", icon: "🔬" },
    { id: "Population Genetics", label: lang === "vi" ? "Di truyền Quần thể" : "Population WGS", icon: "🧬" }
  ];

  // Chain / Network Filter Icons matching OpenSea OS2
  const chains = [
    { id: "all", label: "All Chains", color: "#111827" },
    { id: "eth", label: "Ethereum / EVM Main", color: "#627EEA", symbol: "♦" },
    { id: "sol", label: "High-Throughput L1", color: "#14F195", symbol: "≡" },
    { id: "base", label: "Base L2 Rollup", color: "#0052FF", symbol: "■" },
    { id: "arb", label: "Arbitrum Nitro", color: "#28A0F0", symbol: "▲" },
    { id: "poly", label: "Polygon zkEVM", color: "#8247E5", symbol: "⬡" }
  ];

  const timeframes = ["1h", "6h", "1d", "7d", "30d"];
  const handleCycleTimeframe = () => {
    const nextIdx = (timeframes.indexOf(timeframe) + 1) % timeframes.length;
    const nextTf = timeframes[nextIdx];
    setTimeframe(nextTf);
  };

  // Trending Tokens for the 4x2 Sparkline Grid
  const trendingTokens = showcaseDatasets.slice(0, 8);

  // Featured Collections (4-Card Row matching OpenSea second viewport)
  const featuredCollections = showcaseDatasets.slice(0, 4);

  // Right Leaderboard Datasets sorted dynamically by timeframe & tab mode
  const leaderboardDatasets = [...showcaseDatasets].sort((a, b) => {
    if (timeframe === "1h") return Number(a.price || 0) - Number(b.price || 0);
    if (timeframe === "6h") return Number(b.durationDays || 0) - Number(a.durationDays || 0);
    if (timeframe === "7d") return Number(a.dataId) - Number(b.dataId);
    if (timeframe === "30d") return Number(b.dataId) - Number(a.dataId);
    return Number(b.price || 0) - Number(a.price || 0);
  });

  const featuredGeneKey = featured.geneSymbol?.split(" ")?.[0] || featured.gene?.split(" ")?.[0] || "ACTN3";
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
                <span>All</span>
              ) : (
                <span className="os2-chain-dot" style={{ background: c.color }}>
                  {c.symbol}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Right: Leaderboard Controls (NFTs | Tokens | Perps + Timeframe) */}
        <div className="os2-right-table-controls">
          <div className="os2-segmented-group">
            <button
              type="button"
              className={`os2-seg-btn ${rightTab === "nfts" ? "active" : ""}`}
              onClick={() => setRightTab("nfts")}
            >
              <span>☷ NFTs</span>
            </button>
            <button
              type="button"
              className={`os2-seg-btn ${rightTab === "tokens" ? "active" : ""}`}
              onClick={() => setRightTab("tokens")}
            >
              <span>◎ Tokens</span>
            </button>
            <button
              type="button"
              className={`os2-seg-btn ${rightTab === "perps" ? "active" : ""}`}
              onClick={() => setRightTab("perps")}
            >
              <span>∞ Perps</span>
            </button>
          </div>

          <button
            type="button"
            className="os2-timeframe-btn"
            onClick={handleCycleTimeframe}
            title="Switch Leaderboard Timeframe (1h / 6h / 1d / 7d / 30d)"
          >
            <span>{timeframe}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* ─── 2. MAIN 2-COLUMN SPLIT LAYOUT (Left: Hero + Trending Tokens + Featured Collections | Right: Leaderboard) ─── */}
      <div className="os2-discover-split-grid">
        {/* LEFT COLUMN */}
        <div className="os2-discover-left-col">
          {/* A. Full-Bleed Hero Banner with Real 3D Gemini Molecular Artwork & 3 Square Thumbnails */}
          <div className="os2-hero-banner-wrap">
            <div
              className="os2-hero-banner-card"
              onClick={() => setSelectedAssetModal(featured)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSelectedAssetModal(featured);
              }}
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
                <div className="os2-hero-title-line">
                  <h2
                    className="os2-hero-title"
                    onClick={() => setSelectedAssetModal(featured)}
                  >
                    {featuredGeneKey} —{" "}
                    {getLocalizedTitle ? getLocalizedTitle(featured, lang) : featured.disease}
                  </h2>
                  <VerifiedBadgeIcon size={20} color="#0086FF" />
                </div>

                <div className="os2-hero-author-line">
                  <span>By {featuredConsortium}</span>
                  <VerifiedBadgeIcon size={13} color="#9ca3af" />
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
                    <span>{contractAddr.slice(0, 6)}...{contractAddr.slice(38)}</span>
                    {copiedContract ? <CheckCircleIcon size={11} color="#10b981" /> : <CopyIcon size={11} />}
                  </button>
                </div>

                {/* Dark Frosted Glass Stats Box (FLOOR PRICE | ITEMS | TOTAL VOLUME | LISTED) */}
                <div className="os2-hero-stats-glass">
                  <div className="os2-hero-stat-col">
                    <span className="os2-hero-stat-label">FLOOR PRICE</span>
                    <span className="os2-hero-stat-val">{featured.price} $GENO</span>
                  </div>
                  <div className="os2-hero-stat-col">
                    <span className="os2-hero-stat-label">ITEMS</span>
                    <span className="os2-hero-stat-val">{datasets.length}</span>
                  </div>
                  <div className="os2-hero-stat-col">
                    <span className="os2-hero-stat-label">TOTAL VOLUME</span>
                    <span className="os2-hero-stat-val">{totalVolume.toLocaleString()} $GENO</span>
                  </div>
                  <div className="os2-hero-stat-col">
                    <span className="os2-hero-stat-label">LISTED</span>
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
                        className="os2-hero-btn-licensed"
                        onClick={() => setResearcherTab("licensed")}
                      >
                        <LockOpenIcon size={13} />
                        <span>{t("btnPurchased")}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="os2-hero-btn-buy"
                        disabled={featured.status !== "Active"}
                        onClick={() => onPurchase?.(featured)}
                      >
                        <LockClosedIcon size={13} />
                        <span>
                          {featured.status !== "Active"
                            ? t("statusPaused") || "Paused"
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
              <h3 className="os2-section-title">Trending Tokens</h3>
              <p className="os2-section-subtitle">
                {lang === "vi"
                  ? "Các biến thể gen & locus phân tử nổi bật trên mạng lưới"
                  : "Largest price change in the past day"}
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
                      if (e.key === "Enter") setSelectedAssetModal(ds);
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
                          <span className="os2-token-ticker">${geneName}</span>
                          <VerifiedBadgeIcon size={12} color="#0086FF" />
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
                      {renderDeterministicSparkline(ds.rawDataHash, true)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* C. Featured Collections 4-Card Row (Matching OpenSea OS2 Second Viewport) */}
          <div className="os2-featured-collections-strip">
            <div className="os2-section-header">
              <h3 className="os2-section-title">Featured Collections</h3>
              <p className="os2-section-subtitle">
                {lang === "vi"
                  ? "Bộ sưu tập hệ gen phân tử tuyển chọn tuần này"
                  : "This week's curated collections"}
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
                      if (e.key === "Enter") setSelectedAssetModal(ds);
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
                          {geneName} — {displayTitle}
                        </span>
                        <VerifiedBadgeIcon size={14} color="#0086FF" />
                      </div>
                      <div className="os2-featured-strip-meta">
                        <span>Floor: {ds.price} $GENO</span>
                        <span className="os2-featured-strip-badge">{ds.chromosome}:{ds.rsId}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT STICKY LEADERBOARD COLUMN (Switches dynamically between NFTs | Tokens | Perps) */}
        <aside className="os2-right-leaderboard-aside" aria-label="Collection Floor Leaderboard">
          <div className="os2-leaderboard-col-headers">
            <span>
              {rightTab === "tokens"
                ? "TOKEN LOCUS"
                : rightTab === "perps"
                  ? "ESCROW CONTRACT"
                  : `COLLECTION (${timeframe.toUpperCase()})`}
            </span>
            <span>
              {rightTab === "tokens"
                ? "PRICE / VAR"
                : rightTab === "perps"
                  ? "PROTECTION"
                  : "FLOOR"}
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
                    if (e.key === "Enter") setSelectedAssetModal(ds);
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
                          ? `$${geneSym} (${ds.chromosome})`
                          : `${geneSym} — ${displayTitle}`}
                      </span>
                      <VerifiedBadgeIcon size={13} color="#0086FF" />
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
                        <span className="os2-lb-floor">{ds.durationDays}d Lease</span>
                        <span className="os2-lb-sub pos">24h Escrow Guard</span>
                      </>
                    ) : (
                      <>
                        <span className="os2-lb-floor">{ds.price} $GENO</span>
                        <span className={`os2-lb-sub ${ds.status === "Active" ? "pos" : "neg"}`}>
                          {ds.status === "Active"
                            ? salesCount > 0
                              ? `${salesCount} sales`
                              : "+10% EIP-2981"
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
    </div>
  );
}
