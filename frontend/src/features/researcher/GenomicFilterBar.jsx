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
  ChevronUpIcon
} from "../../components/icons/GenoIcons";
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
    sortBy,
    setSortBy,
    resetFilters,
    filteredDatasets,
    datasets
  } = useDatasets();

  const { viewMode, setViewMode } = useWeb3();
  const { t } = useLanguage();

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
    ancestry: false
  });

  // Local Min/Max inputs
  const [localMin, setLocalMin] = useState(minPrice || "");
  const [localMax, setLocalMax] = useState(maxPrice || "");

  const toggleSection = (sectionKey) => {
    setOpenSections((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  };

  // Keyboard shortcut listener: press '/' to focus search input, 'Escape' to blur
  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeTag = document.activeElement?.tagName;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(activeTag)) {
        e.preventDefault();
        const searchInput = document.getElementById("input-filter-search");
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      } else if (e.key === "Escape" && document.activeElement?.id === "input-filter-search") {
        document.activeElement.blur();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
    activeChips.push({
      id: "status",
      label: `${t("filterStatusLabel") || "Status"}: ${filterStatus}`,
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
      label: `${minPrice || 0} - ${maxPrice || "∞"} $GENO`,
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

  const isFiltersActive = activeChips.length > 0 || (sortBy && sortBy !== "newest");

  const categories = [
    { id: "All", label: t("catAll") || "All Cohorts", icon: DnaHelixIcon, color: "var(--accent-cyan)" },
    { id: "Population Genetics", label: t("cat1000G") || "1000 Genomes", icon: PopulationGlobeIcon, color: "#f472b6" },
    { id: "Physical Traits & Performance", label: t("catTraits") || "Traits & Physical", icon: GeneticTraitIcon, color: "var(--accent-cyan)" },
    { id: "Sensory & Metabolism", label: t("catSensory") || "Metabolism", icon: MetabolismIcon, color: "var(--accent-amber)" },
    { id: "Pharmacogenomics", label: t("catPharmaco") || "Pharmacogenomics", icon: SequencingIcon, color: "var(--accent-purple)" },
    { id: "Reference Benchmark", label: t("catBenchmarks") || "GIAB Benchmarks", icon: BenchmarkIcon, color: "var(--accent-emerald)" }
  ];

  return (
    <div className="opensea-filter-system">
      {/* ─── 1. Category Quick Pills Row ─── */}
      <div className="opensea-category-pills-row">
        {categories.map((cat) => {
          const Icon = cat.icon;
          const isActive =
            cat.id === "All"
              ? filterSignificance === "All"
              : filterSignificance === cat.id;

          return (
            <button
              key={cat.id}
              type="button"
              className={`opensea-filter-pill ${isActive ? "active" : ""}`}
              onClick={() => setFilterSignificance(cat.id === "All" ? "All" : cat.id)}
            >
              <Icon size={14} color={isActive ? "currentColor" : cat.color} />
              <span>{cat.label}</span>
            </button>
          );
        })}
      </div>

      {/* ─── 2. OpenSea Main Control Toolbar ─── */}
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
                title="Clear search"
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
              type="button"
              className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setViewMode("grid")}
              title={t("viewGrid") || "Grid view"}
            >
              <GridIcon size={15} />
            </button>
            <button
              type="button"
              className={`view-btn ${viewMode === "table" ? "active" : ""}`}
              onClick={() => setViewMode("table")}
              title={t("viewTable") || "Table view"}
            >
              <ListIcon size={15} />
            </button>
          </div>
        </div>
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
                  title={`Remove ${chip.label}`}
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
          <aside className="opensea-filter-sidebar">
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
                      {["All", "Active", "Paused"].map((st) => (
                        <button
                          key={st}
                          type="button"
                          className={`sidebar-chip ${filterStatus === st ? "active" : ""}`}
                          onClick={() => setFilterStatus(st)}
                        >
                          {st === "All" ? (t("filterAllStatus") || "All Status") : st === "Active" ? (t("filterActiveStatus") || "Buy Now / Active") : (t("statusPaused") || st)}
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
                          placeholder="Min"
                          value={localMin}
                          onChange={(e) => setLocalMin(e.target.value)}
                        />
                        <span className="price-to-sep">{t("filterTo") || "to"}</span>
                        <input
                          type="number"
                          className="price-num-input"
                          placeholder="Max"
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
                      {["All", "chr1", "chr2", "chr11", "chr12", "chr15", "chr16", "chr20", "MT"].map((ch) => (
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
                      {["All", "VCF", "FASTQ", "FASTA"].map((fmt) => (
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
                        { id: "1/1", label: "1/1 (Hom Alt)" }
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
            </div>
          </aside>
        )}

        {/* Right Main Catalog Content */}
        <main className={`opensea-catalog-main ${!showSidebar ? "full-width" : ""}`}>
          {children ? (
            children
          ) : viewMode === "table" ? (
            <DatasetCatalogTable onPurchase={onPurchase} />
          ) : (
            <DatasetCatalogGrid onPurchase={onPurchase} />
          )}
        </main>
      </div>
    </div>
  );
}
