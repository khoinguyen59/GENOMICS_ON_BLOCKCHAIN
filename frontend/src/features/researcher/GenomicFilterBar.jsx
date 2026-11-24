import React, { useState, useEffect } from "react";
import { useDatasets } from "../../context/DatasetContext";
import { useLanguage } from "../../context/LanguageContext";
import { useWeb3 } from "../../context/Web3Context";
import {
  FilterSlidersIcon,
  DnaHelixIcon,
  PopulationGlobeIcon,
  GeneticTraitIcon,
  MetabolismIcon,
  SequencingIcon,
  BenchmarkIcon,
  PriceTagIcon,
  StatusIndicatorIcon,
  RefreshSpinIcon,
  CheckCircleIcon,
  SearchGlassIcon,
  SortIcon,
  GridIcon,
  ListIcon,
  CloseCrossIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SealedCipherIcon
} from "../../components/icons/GenoIcons";
import { searchDatasetsByBlindTag } from "../../services/datasetService";
import DatasetCatalogGrid from "./DatasetCatalogGrid";
import DatasetCatalogTable from "./DatasetCatalogTable";

export default function GenomicFilterBar({ children, onPurchase }) {
  const {
    filterKeyword,
    setFilterKeyword,
    filterChromosome,
    setFilterChromosome,
    filterGene,
    setFilterGene,
    filterSignificance,
    setFilterSignificance,
    filterConsequence,
    setFilterConsequence,
    filterZygosity,
    setFilterZygosity,
    filterRegion,
    setFilterRegion,
    filterBloodType,
    setFilterBloodType,
    filterFormat,
    setFilterFormat,
    filterAssembly,
    setFilterAssembly,
    filterPlatform,
    setFilterPlatform,
    filterPriceTier,
    setFilterPriceTier,
    minPrice,
    setMinPrice,
    maxPrice,
    setMaxPrice,
    filterStatus,
    setFilterStatus,
    filterDuration,
    setFilterDuration,
    blindMatchIds,
    setBlindMatchIds,
    sortBy,
    setSortBy,
    resetFilters,
    filteredDatasets,
    datasets
  } = useDatasets();

  const { viewMode, setViewMode, contracts, showToast } = useWeb3();
  const { t, lang } = useLanguage();

  const [blindKey, setBlindKey] = useState("gene");
  const [blindVal, setBlindVal] = useState("");
  const [blindSalt, setBlindSalt] = useState("GENOCHAIN_COHORT_SALT_V1");
  const [blindTagHex, setBlindTagHex] = useState("");
  const [searchingBlind, setSearchingBlind] = useState(false);

  const handleBlindSearch = async () => {
    if (!blindVal.trim()) {
      setBlindMatchIds(null);
      setBlindTagHex("");
      return;
    }
    setSearchingBlind(true);
    try {
      const res = await searchDatasetsByBlindTag({
        traitKey: blindKey,
        traitValue: blindVal.trim(),
        datasetSalt: blindSalt.trim() || "GENOCHAIN_COHORT_SALT_V1",
        datasets,
        contracts
      });
      setBlindMatchIds(res.matchingIds);
      setBlindTagHex(res.blindTag);
      showToast(
        lang === "vi"
          ? `Tìm kiếm ẩn danh On-Chain: Khớp ${res.matchingIds.length} bộ dữ liệu (${res.blindTag.slice(0, 12)}...)`
          : `On-Chain Blind Search: ${res.matchingIds.length} dataset(s) matched (${res.blindTag.slice(0, 12)}...)`
      );
    } catch (err) {
      showToast((lang === "vi" ? "Truy vấn Blind Tag thất bại: " : "Blind tag query failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setSearchingBlind(false);
    }
  };

  const handleClearBlindSearch = () => {
    setBlindMatchIds(null);
    setBlindTagHex("");
    setBlindVal("");
  };

  // OpenSea Left Sidebar state (Default open on wide desktop)
  const [showSidebar, setShowSidebar] = useState(true);

  // Accordion section collapse states
  const [openSections, setOpenSections] = useState({
    status: true,
    price: true,
    gene: true,
    chromosome: true,
    format: false,
    zygosity: false,
    ancestry: false,
    bloodType: false
  });

  // Local Min/Max inputs
  const [localMin, setLocalMin] = useState(minPrice || "");
  const [localMax, setLocalMax] = useState(maxPrice || "");

  const toggleSection = (sectionKey) => {
    setOpenSections((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  };

  // Sync local min/max when context resets
  useEffect(() => {
    setLocalMin(minPrice || "");
    setLocalMax(maxPrice || "");
  }, [minPrice, maxPrice]);

  const handleApplyPrice = (e) => {
    e?.preventDefault();
    setMinPrice(localMin);
    setMaxPrice(localMax);
  };

  const handleClearPrice = () => {
    setLocalMin("");
    setLocalMax("");
    setMinPrice("");
    setMaxPrice("");
    setFilterPriceTier("All");
  };

  // Determine active filters
  const activeChips = [];
  if (filterKeyword) {
    activeChips.push({
      id: "keyword",
      label: `"${filterKeyword}"`,
      clear: () => setFilterKeyword("")
    });
  }
  if (filterStatus !== "All") {
    const localizedSt =
      filterStatus === "Active"
        ? t("filterActiveStatus")
        : filterStatus === "Paused"
          ? t("statusPaused")
          : t("statusRevoked");
    activeChips.push({
      id: "status",
      label: `${t("filterStatusLabel") || "Status"}: ${localizedSt}`,
      clear: () => setFilterStatus("All")
    });
  }
  if (filterGene && filterGene !== "All") {
    activeChips.push({
      id: "gene",
      label: `${t("filterGeneLabel") || "Gene"}: ${filterGene}`,
      clear: () => setFilterGene("All")
    });
  }
  if (filterChromosome !== "All") {
    activeChips.push({
      id: "chrom",
      label: `${t("filterChromLabel") || "Chr"}: ${filterChromosome}`,
      clear: () => setFilterChromosome("All")
    });
  }
  if (filterSignificance !== "All") {
    activeChips.push({
      id: "sig",
      label: `${t("filterCategoryLabel") || "Category"}: ${filterSignificance}`,
      clear: () => setFilterSignificance("All")
    });
  }
  if (filterPriceTier !== "All") {
    activeChips.push({
      id: "priceTier",
      label: `${t("filterTierLabel") || "Tier"}: ${filterPriceTier}`,
      clear: () => setFilterPriceTier("All")
    });
  }
  if (minPrice || maxPrice) {
    activeChips.push({
      id: "priceRange",
      label: `${minPrice || 0} - ${maxPrice || t("filterMaxPlaceholder")} $GENO`,
      clear: handleClearPrice
    });
  }
  if (filterFormat !== "All") {
    activeChips.push({
      id: "format",
      label: `${t("filterFormatLabel") || "Format"}: ${filterFormat}`,
      clear: () => setFilterFormat("All")
    });
  }
  if (filterZygosity !== "All") {
    activeChips.push({
      id: "zyg",
      label: `${t("filterZygosityLabel") || "Zygosity"}: ${filterZygosity}`,
      clear: () => setFilterZygosity("All")
    });
  }
  if (filterRegion !== "All") {
    activeChips.push({
      id: "region",
      label: `${t("filterCohortLabel") || "Cohort"}: ${filterRegion}`,
      clear: () => setFilterRegion("All")
    });
  }
  if (filterBloodType !== "All") {
    activeChips.push({
      id: "bloodType",
      label: `${t("filterBloodType") || "Blood Type"}: ${filterBloodType}`,
      clear: () => setFilterBloodType("All")
    });
  }

  const isFiltersActive = activeChips.length > 0 || (sortBy && sortBy !== "newest");

  return (
    <div className="opensea-filter-system">
      {/* ─── 1. GenoChain Main Control Toolbar ─── */}
      <div className="opensea-toolbar-row">
        {/* Left: Sidebar Toggle + Search */}
        <div className="toolbar-left">
          <button
            type="button"
            className={`btn-terminal ${showSidebar ? "btn-terminal-primary" : "btn-terminal-ghost"} filter-toggle-btn`}
            onClick={() => setShowSidebar(!showSidebar)}
            title={showSidebar ? t("filterSidebarClose") || "Hide Filters" : t("filterSidebarOpen") || "Show Filters"}
          >
            <FilterSlidersIcon size={15} />
            <span>{showSidebar ? (t("filterSidebarClose") || "Filters") : (t("filterSidebarOpen") || "Filters")}</span>
            {activeChips.length > 0 && (
              <span className="filter-count-badge">{activeChips.length}</span>
            )}
          </button>

          {/* Search Bar with Shortcut / */}
          <div className="opensea-search-inner-toolbar">
            <SearchGlassIcon size={16} color="var(--text-muted)" className="search-icon" />
            <input
              id="input-filter-search"
              type="text"
              className="opensea-search-field-toolbar"
              placeholder={t("filterSearchPlaceholder") || "Search cohorts, genes (ALDH2, ACTN3), chromosomes (chr12), rsID..."}
              value={filterKeyword}
              onChange={(e) => setFilterKeyword(e.target.value)}
              aria-label={t("filterSearchLabel") || "Search"}
            />
            {filterKeyword ? (
              <button
                type="button"
                className="opensea-search-clear-btn"
                onClick={() => setFilterKeyword("")}
                title={t("ariaClearSearch")}
                aria-label={t("ariaClearSearch")}
              >
                <CloseCrossIcon size={12} color="var(--text-muted)" />
              </button>
            ) : (
              <span className="search-kbd-shortcut">/</span>
            )}
          </div>
        </div>

        {/* Right: Results Count + Sort Dropdown + View Switcher */}
        <div className="toolbar-right">
          <div className="toolbar-results-chip">
            <CheckCircleIcon size={13} color="var(--accent-emerald)" />
            <span>
              {filteredDatasets.length} <span className="text-muted">/ {datasets.length} {t("statTotalDatasets") || "cohorts"}</span>
            </span>
          </div>

          <div className="opensea-sort-select-wrap">
            <SortIcon size={14} color="var(--text-muted)" className="sort-icon-prefix" />
            <select
              className="opensea-sort-select"
              value={sortBy || "newest"}
              onChange={(e) => setSortBy(e.target.value)}
              aria-label={t("sortLabel") || "Sort by"}
            >
              <option value="newest">{t("sortNewest") || "Recently Listed"}</option>
              <option value="id-asc">{t("sortOldest") || "Token ID: Low to High"}</option>
              <option value="price-asc">{t("sortPriceLowHigh") || "Price: Low to High"}</option>
              <option value="price-desc">{t("sortPriceHighLow") || "Price: High to Low"}</option>
              <option value="popular">{t("sortPopular") || "Most Popular"}</option>
            </select>
            <ChevronDownIcon size={12} color="var(--text-muted)" className="sort-chevron-down" />
          </div>

          <div className="opensea-view-switcher">
            <button
              id="btn-view-grid"
              type="button"
              className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setViewMode("grid")}
              title={t("viewGrid") || "Grid view"}
              aria-label={t("viewGrid") || "Grid view"}
            >
              <GridIcon size={15} />
            </button>
            <button
              id="btn-view-table"
              type="button"
              className={`view-btn ${viewMode === "table" ? "active" : ""}`}
              onClick={() => setViewMode("table")}
              title={t("viewTable") || "Table view"}
              aria-label={t("viewTable") || "Table view"}
            >
              <ListIcon size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* ─── 2b. Serverless On-Chain Blinded Keccak-256 Trait Search ─── */}
      <div
        id="blind-search-panel"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          marginBottom: "12px",
          borderRadius: "10px",
          border: "1px solid var(--border-subtle)",
          background: "var(--bg-surface)"
        }}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 700, color: "var(--accent-cyan)", whiteSpace: "nowrap" }}>
          <SealedCipherIcon size={14} color="var(--accent-cyan)" />
          <span>{t("blindSearchTitle")}:</span>
        </div>
        <select
          id="blind-search-key"
          className="field-select"
          style={{ width: "auto", minWidth: "155px", height: "34px", padding: "0 10px", fontSize: "12px" }}
          aria-label={t("blindSearchKey")}
          value={blindKey}
          onChange={(e) => setBlindKey(e.target.value)}
        >
          <option value="gene">{t("filterSearchKeyGene")}</option>
          <option value="disease">{t("filterSearchKeyDisease")}</option>
          <option value="trait">{t("filterSearchKeyTrait") || (lang === "vi" ? "Tính trạng (trait)" : "Trait (trait)")}</option>
          <option value="hpo">{t("filterSearchKeyHpo")}</option>
          <option value="ancestry">{t("filterSearchKeyAncestry")}</option>
          <option value="rsid">{t("filterSearchKeyRsid") || "dbSNP rsID (rsid)"}</option>
        </select>
        <input
          id="blind-search-val"
          type="text"
          className="field-input"
          style={{ flex: "1 1 180px", maxWidth: "240px", height: "34px" }}
          placeholder={t("blindSearchVal")}
          aria-label={t("blindSearchVal")}
          value={blindVal}
          onChange={(e) => setBlindVal(e.target.value)}
        />
        <input
          id="blind-search-salt"
          type="text"
          className="field-input"
          style={{ width: "210px", height: "34px", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
          placeholder="GENOCHAIN_COHORT_SALT_V1"
          aria-label={t("blindSaltLabel")}
          value={blindSalt}
          onChange={(e) => setBlindSalt(e.target.value)}
        />
        <button
          id="blind-search-submit-btn"
          type="button"
          className="btn-terminal btn-terminal-primary"
          style={{ height: "34px", padding: "0 12px", fontSize: "12px", whiteSpace: "nowrap" }}
          title={t("blindSearchBtn")}
          disabled={searchingBlind}
          onClick={handleBlindSearch}
        >
          <SearchGlassIcon size={13} />
          <span>{searchingBlind ? "..." : t("blindSearchBtn")}</span>
        </button>
        {Array.isArray(blindMatchIds) && (
          <>
            <span style={{ fontSize: "11.5px", fontFamily: "var(--font-mono)", color: "var(--accent-emerald-text)", whiteSpace: "nowrap" }}>
              {lang === "vi" ? "Khớp" : "Match"}: {blindMatchIds.length} ({blindTagHex.slice(0, 10)}...)
            </span>
            <button
              id="blind-search-clear-btn"
              type="button"
              className="btn-terminal btn-terminal-ghost"
              style={{ height: "34px", padding: "0 10px", fontSize: "12px", whiteSpace: "nowrap" }}
              title={t("blindSearchClear")}
              onClick={handleClearBlindSearch}
            >
              {t("blindSearchClear")}
            </button>
          </>
        )}
      </div>

      {/* ─── 3. OpenSea Active Removable Filter Chips Bar ─── */}
      {isFiltersActive && (
        <div className="opensea-active-chips-bar">
          <div className="active-chips-list">
            {activeChips.map((chip) => (
              <span key={chip.id} className="active-filter-tag">
                <span>{chip.label}</span>
                <button
                  type="button"
                  className="tag-remove-btn"
                  onClick={chip.clear}
                  title={`${t("ariaRemoveFilterPrefix")} ${chip.label}`}
                  aria-label={`${t("ariaRemoveFilterPrefix")} ${chip.label}`}
                >
                  <CloseCrossIcon size={11} />
                </button>
              </span>
            ))}
          </div>

          <button
            type="button"
            className="btn-clear-all-filters"
            onClick={resetFilters}
            title={t("clearAll") || "Clear all filters"}
          >
            <RefreshSpinIcon size={12} color="var(--accent-rose)" />
            <span>{t("clearAll") || "Clear all"}</span>
          </button>
        </div>
      )}

      {/* ─── 4. OpenSea Split Layout: Left Filter Sidebar & Right Catalog Main ─── */}
      <div className={`opensea-split-layout ${showSidebar ? "has-sidebar" : "no-sidebar"}`}>
        {/* Left Sidebar */}
        {showSidebar && (
          <div className="opensea-filter-sidebar" role="region" aria-label={t("ariaDatasetFilters")}>
            <div className="sidebar-sticky-scroll">
              {/* Group 1: Status */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("status")}
                >
                  <div className="accordion-header-left">
                    <StatusIndicatorIcon size={13} color="var(--accent-cyan)" />
                    <span>{t("filterStatus") || "STATUS"}</span>
                  </div>
                  {openSections.status ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.status && (
                  <div className="sidebar-accordion-body">
                    <div className="sidebar-chip-cluster">
                      {["All", "Active", "Paused", "Revoked"].map((st) => (
                        <button
                          key={st}
                          type="button"
                          className={`sidebar-chip ${filterStatus === st ? "active" : ""}`}
                          onClick={() => setFilterStatus(st)}
                        >
                          {st === "All"
                            ? (t("filterAllStatus") || "All Status")
                            : st === "Active"
                            ? (t("filterActiveStatus") || "Active")
                            : st === "Paused"
                            ? (t("statusPaused") || st)
                            : (t("statusRevoked") || st)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group 2: Price ($GENO) */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("price")}
                >
                  <div className="accordion-header-left">
                    <PriceTagIcon size={13} color="var(--accent-amber)" />
                    <span>{t("filterPrice") || "PRICE ($GENO)"}</span>
                  </div>
                  {openSections.price ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.price && (
                  <div className="sidebar-accordion-body">
                    {/* Custom Range Input */}
                    <form onSubmit={handleApplyPrice} className="price-range-form">
                      <div className="price-inputs-row">
                        <input
                          type="number"
                          className="price-num-input"
                          aria-label={t("filterMinPlaceholder")}
                          placeholder={t("filterMinPlaceholder")}
                          value={localMin}
                          onChange={(e) => setLocalMin(e.target.value)}
                        />
                        <span className="price-to-sep">{t("filterTo") || "to"}</span>
                        <input
                          type="number"
                          className="price-num-input"
                          aria-label={t("filterMaxPlaceholder")}
                          placeholder={t("filterMaxPlaceholder")}
                          value={localMax}
                          onChange={(e) => setLocalMax(e.target.value)}
                        />
                      </div>
                      <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                        <button type="submit" className="btn-apply-price">
                          {t("confirm") || "Apply"}
                        </button>
                        {(minPrice || maxPrice) && (
                          <button
                            type="button"
                            className="btn-clear-price"
                            onClick={handleClearPrice}
                          >
                            {t("reset") || "Reset"}
                          </button>
                        )}
                      </div>
                    </form>

                    {/* Quick Presets */}
                    <div className="sidebar-chip-cluster" style={{ marginTop: "10px" }}>
                      {[
                        { id: "All", label: t("filterAllPrices") || "All Prices" },
                        { id: "Under100", label: t("filterUnder100") || "≤ 100 $GENO" },
                        { id: "100To200", label: t("filter100To200") || "100 - 200 $GENO" },
                        { id: "Over200", label: t("filterOver200") || "> 200 $GENO" }
                      ].map((pt) => (
                        <button
                          key={pt.id}
                          type="button"
                          className={`sidebar-chip ${filterPriceTier === pt.id ? "active" : ""}`}
                          onClick={() => setFilterPriceTier(pt.id)}
                        >
                          {pt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group 3: Target Gene */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("gene")}
                >
                  <div className="accordion-header-left">
                    <DnaHelixIcon size={13} color="var(--accent-cyan)" />
                    <span>{t("filterTargetGene") || "TARGET GENE"}</span>
                  </div>
                  {openSections.gene ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.gene && (
                  <div className="sidebar-accordion-body">
                    <div className="sidebar-chip-cluster">
                      {[
                        "All",
                        "ALDH2",
                        "ACTN3",
                        "HERC2",
                        "TAS2R38",
                        "EDAR",
                        "LCT",
                        "CYP1A2",
                        "ABCC11",
                        "NA12878"
                      ].map((gn) => (
                        <button
                          key={gn}
                          type="button"
                          className={`sidebar-chip ${filterGene === gn ? "active" : ""}`}
                          onClick={() => setFilterGene(gn)}
                        >
                          {gn === "All" ? (t("catAll") || "All") : gn}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group 4: Chromosome */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("chromosome")}
                >
                  <div className="accordion-header-left">
                    <DnaHelixIcon size={13} color="var(--accent-purple)" />
                    <span>{t("filterChromosome") || "CHROMOSOME"}</span>
                  </div>
                  {openSections.chromosome ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.chromosome && (
                  <div className="sidebar-accordion-body">
                    <div className="sidebar-chip-cluster">
                      {["All", "chr1", "chr2", "chr7", "chr11", "chr12", "chr15", "chr16", "chr20", "chrM"].map((ch) => (
                        <button
                          key={ch}
                          type="button"
                          className={`sidebar-chip ${filterChromosome === ch ? "active" : ""}`}
                          onClick={() => setFilterChromosome(ch)}
                        >
                          {ch === "All" ? (t("filterChromAll") || "All") : ch}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group 5: File Format */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("format")}
                >
                  <div className="accordion-header-left">
                    <SequencingIcon size={13} color="var(--accent-emerald)" />
                    <span>{t("filterFileFormat") || "FILE FORMAT"}</span>
                  </div>
                  {openSections.format ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.format && (
                  <div className="sidebar-accordion-body">
                    <div className="sidebar-chip-cluster">
                      {["All", "VCF", "VCF.GZ", "FASTQ", "FASTA", "BAM", "Crypt4GH"].map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          className={`sidebar-chip ${filterFormat === fmt ? "active" : ""}`}
                          onClick={() => setFilterFormat(fmt)}
                        >
                          {fmt === "All" ? (t("filterAllFormats") || "All Formats") : fmt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group 6: Zygosity */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("zygosity")}
                >
                  <div className="accordion-header-left">
                    <GeneticTraitIcon size={13} color="var(--accent-cyan)" />
                    <span>{t("filterZygosity") || "ZYGOSITY"}</span>
                  </div>
                  {openSections.zygosity ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.zygosity && (
                  <div className="sidebar-accordion-body">
                    <div className="sidebar-chip-cluster">
                      {[
                        { id: "All", label: t("filterAllCalls") || "All Calls" },
                        { id: "0/1", label: "0/1 (Het)" },
                        { id: "1/1", label: "1/1 (Hom Alt)" },
                        { id: "0/0", label: "0/0 (Hom Ref)" }
                      ].map((zg) => (
                        <button
                          key={zg.id}
                          type="button"
                          className={`sidebar-chip ${filterZygosity === zg.id ? "active" : ""}`}
                          onClick={() => setFilterZygosity(zg.id)}
                        >
                          {zg.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group 7: Ancestry Cohort */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("ancestry")}
                >
                  <div className="accordion-header-left">
                    <PopulationGlobeIcon size={13} color="#f472b6" />
                    <span>{t("filterAncestry") || "ANCESTRY COHORT"}</span>
                  </div>
                  {openSections.ancestry ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.ancestry && (
                  <div className="sidebar-accordion-body">
                    <div className="sidebar-chip-cluster">
                      {[
                        { id: "All", label: t("filterAllPopulations") || "All Populations" },
                        { id: "Vietnamese", label: "Vietnamese (KHV)" },
                        { id: "Asian", label: "East Asian" },
                        { id: "European", label: "European (CEU)" },
                        { id: "Global", label: "Global / Reference" }
                      ].map((reg) => (
                        <button
                          key={reg.id}
                          type="button"
                          className={`sidebar-chip ${filterRegion === reg.id ? "active" : ""}`}
                          onClick={() => setFilterRegion(reg.id)}
                        >
                          {reg.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group 8: Blood Type (ABO-Rh) */}
              <div className="sidebar-accordion-item">
                <button
                  type="button"
                  className="sidebar-accordion-header"
                  onClick={() => toggleSection("bloodType")}
                >
                  <div className="accordion-header-left">
                    <MetabolismIcon size={13} color="var(--accent-rose)" />
                    <span>{t("filterBloodType") || "BLOOD TYPE (ABO-Rh)"}</span>
                  </div>
                  {openSections.bloodType ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                </button>
                {openSections.bloodType && (
                  <div className="sidebar-accordion-body">
                    <div className="sidebar-chip-cluster">
                      {["All", "O+", "A+", "B+", "AB+", "O-", "A-", "B-", "AB-"].map((bt) => (
                        <button
                          key={bt}
                          type="button"
                          className={`sidebar-chip ${filterBloodType === bt ? "active" : ""}`}
                          onClick={() => setFilterBloodType(bt)}
                        >
                          {bt === "All" ? (t("filterAllBloodTypes") || "All Types") : bt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Right Main Catalog Content */}
        <div className={`opensea-catalog-main ${!showSidebar ? "full-width" : ""}`}>
          {children ? (
            children
          ) : viewMode === "table" ? (
            <DatasetCatalogTable onPurchase={onPurchase} />
          ) : (
            <DatasetCatalogGrid onPurchase={onPurchase} />
          )}
        </div>
      </div>
    </div>
  );
}
