import { useState, useMemo, useCallback } from "react";

export function useGenomicFilters({ datasets = [] } = {}) {
  const [filterKeyword, setFilterKeyword] = useState("");
  const [filterChromosome, setFilterChromosome] = useState("All");
  const [filterGene, setFilterGene] = useState("All");
  const [filterSignificance, setFilterSignificance] = useState("All");
  const [filterConsequence, setFilterConsequence] = useState("All");
  const [filterZygosity, setFilterZygosity] = useState("All");
  const [filterRegion, setFilterRegion] = useState("All");
  const [filterFormat, setFilterFormat] = useState("All");
  const [filterAssembly, setFilterAssembly] = useState("All");
  const [filterPlatform, setFilterPlatform] = useState("All");
  const [filterPriceTier, setFilterPriceTier] = useState("All");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterDuration, setFilterDuration] = useState("All");
  const [sortBy, setSortBy] = useState("newest");

  const resetFilters = useCallback(() => {
    setFilterKeyword(""); setFilterChromosome("All"); setFilterGene("All");
    setFilterSignificance("All"); setFilterConsequence("All"); setFilterZygosity("All");
    setFilterRegion("All"); setFilterFormat("All"); setFilterAssembly("All");
    setFilterPlatform("All"); setFilterPriceTier("All"); setMinPrice("");
    setMaxPrice(""); setFilterStatus("All"); setFilterDuration("All"); setSortBy("newest");
  }, []);

  const filteredDatasets = useMemo(() => {
    const list = datasets || [];
    const filtered = list.filter((d) => {
      const q = filterKeyword.toLowerCase().trim();
      const matchesKeyword = !q ||
        d.disease?.toLowerCase().includes(q) || d.gene?.toLowerCase().includes(q) ||
        d.geneSymbol?.toLowerCase().includes(q) || d.chromosome?.toLowerCase().includes(q) ||
        d.rsId?.toLowerCase().includes(q) || d.hpoTerm?.toLowerCase().includes(q) ||
        d.clinvarId?.toLowerCase().includes(q);

      const matchesChrom = filterChromosome === "All" || (d.chromosome && d.chromosome.toLowerCase() === filterChromosome.toLowerCase());
      const matchesGene = filterGene === "All" || (d.geneSymbol && d.geneSymbol.toLowerCase().includes(filterGene.toLowerCase())) || (d.gene && d.gene.toLowerCase().includes(filterGene.toLowerCase()));
      const matchesSig = filterSignificance === "All" || d.clinicalSignificance === filterSignificance;
      const matchesCons = filterConsequence === "All" || d.consequence === filterConsequence;
      const matchesZyg = filterZygosity === "All" || (d.zygosity && d.zygosity.includes(filterZygosity));
      const matchesRegion = filterRegion === "All" || d.region?.toLowerCase().includes(filterRegion.toLowerCase()) || d.ancestry?.toLowerCase().includes(filterRegion.toLowerCase());
      const matchesFormat = filterFormat === "All" || (d.format && d.format.includes(filterFormat));
      const matchesAssembly = filterAssembly === "All" || (d.assembly && d.assembly.toLowerCase().includes(filterAssembly.toLowerCase()));
      const matchesPlatform = filterPlatform === "All" || (d.platform && d.platform.toLowerCase().includes(filterPlatform.toLowerCase()));
      const matchesPriceTier = filterPriceTier === "All" ||
        (filterPriceTier === "Free" && d.price === 0) || (filterPriceTier === "Under100" && d.price <= 100) ||
        (filterPriceTier === "100To200" && d.price > 100 && d.price <= 200) || (filterPriceTier === "Over200" && d.price > 200);
      const matchesMinPrice = minPrice === "" || isNaN(Number(minPrice)) || Number(d.price) >= Number(minPrice);
      const matchesMaxPrice = maxPrice === "" || isNaN(Number(maxPrice)) || Number(d.price) <= Number(maxPrice);
      const matchesStatus = filterStatus === "All" || d.status === filterStatus;
      const matchesDuration = filterDuration === "All" || String(d.durationDays) === String(filterDuration);

      return (
        matchesKeyword && matchesChrom && matchesGene && matchesSig &&
        matchesCons && matchesZyg && matchesRegion && matchesFormat &&
        matchesAssembly && matchesPlatform && matchesPriceTier &&
        matchesMinPrice && matchesMaxPrice && matchesStatus && matchesDuration
      );
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === "price-asc") return Number(a.price) - Number(b.price);
      if (sortBy === "price-desc") return Number(b.price) - Number(a.price);
      if (sortBy === "popular") return Number(b.accessCount || 0) - Number(a.accessCount || 0);
      if (sortBy === "id-asc") return a.dataId - b.dataId;
      return b.dataId - a.dataId;
    });
  }, [
    datasets, filterKeyword, filterChromosome, filterGene, filterSignificance,
    filterConsequence, filterZygosity, filterRegion, filterFormat,
    filterAssembly, filterPlatform, filterPriceTier, minPrice, maxPrice,
    filterStatus, filterDuration, sortBy
  ]);

  const getActiveLang = (lang) => {
    if (lang === "en" || lang === "vi") return lang;
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem("geno_lang") || "vi";
    }
    return "vi";
  };

  const getLocalizedTitle = useCallback((item, lang) => {
    if (!item) return "";
    const activeLang = getActiveLang(lang);
    return activeLang === "en" ? (item.titleEn || item.disease) : (item.titleVi || item.disease);
  }, []);

  const getLocalizedTrait = useCallback((item, lang) => {
    if (!item) return "";
    const activeLang = getActiveLang(lang);
    return activeLang === "en" ? (item.traitEn || item.disease) : (item.traitVi || item.disease);
  }, []);

  const getLocalizedSignificance = useCallback((sig, lang) => {
    const activeLang = getActiveLang(lang);
    if (!sig) return activeLang === "en" ? "Physiological Traits" : "Tính Trạng Thể Chất";
    const mapVi = {
      "Physiological Traits": "Tính Trạng Thể Chất", "Reference Benchmark": "Chuẩn Đối Chứng",
      "Carrier Screening": "Sàng Lọc Người Mang Gen", "Pharmacogenomics": "Dược Lý Di Truyền",
      "Population Genetics": "Di Truyền Quần Thể", "Morphological Traits": "Hình Thái Học",
      "NGS Sequencing Reads": "Giải Trình Tự NGS", "Pathogenic Risk": "Biến Dị Chức Năng"
    };
    const mapEn = {
      "Physiological Traits": "Physiological Traits", "Reference Benchmark": "Reference Benchmark",
      "Carrier Screening": "Carrier Screening", "Pharmacogenomics": "Pharmacogenomics",
      "Population Genetics": "Population Genetics", "Morphological Traits": "Morphological Traits",
      "NGS Sequencing Reads": "NGS Sequencing Reads", "Pathogenic Risk": "Functional Variation"
    };
    return activeLang === "en" ? (mapEn[sig] || sig) : (mapVi[sig] || sig);
  }, []);

  const getLocalizedConsequence = useCallback((cons, lang) => {
    if (!cons) return cons;
    const activeLang = getActiveLang(lang);
    const mapVi = {
      "missense_variant": "Biến dị sai nghĩa", "regulatory_variant": "Biến dị điều hòa",
      "stop_gained": "Đột biến kết thúc", "synonymous_variant": "Biến dị đồng nghĩa",
      "intron_variant": "Biến dị intron"
    };
    const mapEn = {
      "missense_variant": "Missense Variant", "regulatory_variant": "Regulatory Variant",
      "stop_gained": "Stop Gained", "synonymous_variant": "Synonymous Variant",
      "intron_variant": "Intron Variant"
    };
    return activeLang === "en" ? (mapEn[cons] || cons) : (mapVi[cons] || cons);
  }, []);

  const getLocalizedZygosity = useCallback((zyg, lang) => {
    if (!zyg) return zyg;
    const activeLang = getActiveLang(lang);
    if (zyg.includes("0/1") || zyg.toLowerCase().includes("het")) {
      return activeLang === "en" ? "0/1 (Heterozygous)" : "Dị hợp tử (0/1)";
    }
    if (zyg.includes("1/1") || zyg.toLowerCase().includes("hom")) {
      return activeLang === "en" ? "1/1 (Homozygous Alt)" : "Đồng hợp tử (1/1)";
    }
    return zyg;
  }, []);

  return {
    filterKeyword, setFilterKeyword, filterChromosome, setFilterChromosome,
    filterGene, setFilterGene, filterSignificance, setFilterSignificance,
    filterConsequence, setFilterConsequence, filterZygosity, setFilterZygosity,
    filterRegion, setFilterRegion, filterFormat, setFilterFormat,
    filterAssembly, setFilterAssembly, filterPlatform, setFilterPlatform,
    filterPriceTier, setFilterPriceTier, minPrice, setMinPrice,
    maxPrice, setMaxPrice, filterStatus, setFilterStatus,
    filterDuration, setFilterDuration, sortBy, setSortBy,
    resetFilters, filteredDatasets, getLocalizedTitle, getLocalizedTrait,
    getLocalizedSignificance, getLocalizedConsequence, getLocalizedZygosity
  };
}
