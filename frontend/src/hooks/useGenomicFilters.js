import { useState, useMemo, useCallback } from "react";

export function matchesBloodTypeFilter(dataset, filterBloodType) {
  if (!filterBloodType || filterBloodType === "All") return true;
  const targetBlood = String(filterBloodType).trim().toUpperCase();
  const bg = String(dataset?.bloodGroup || "").trim().toUpperCase();
  const bt = String(dataset?.bloodType || "").trim().toUpperCase();
  return (bg.length > 0 && bg === targetBlood) || (bt.length > 0 && bt === targetBlood);
}

export function localizeZygosity(zyg, lang = "vi") {
  if (!zyg) return zyg;
  const activeLang = lang === "en" ? "en" : "vi";
  const str = String(zyg);
  const low = str.toLowerCase();
  if (str.includes("0/1") || str.includes("1/0") || str.includes("0|1") || str.includes("1|0") || low.includes("het")) {
    return activeLang === "en" ? "0/1 (Heterozygous)" : "Dị hợp tử (0/1)";
  }
  if (str.includes("0/0") || str.includes("0|0") || (low.includes("hom") && low.includes("ref"))) {
    return activeLang === "en" ? "0/0 (Homozygous Ref)" : "Đồng hợp tử tham chiếu (0/0)";
  }
  if (str.includes("1/1") || str.includes("1|1") || low.includes("hom")) {
    return activeLang === "en" ? "1/1 (Homozygous Alt)" : "Đồng hợp tử (1/1)";
  }
  return str;
}

export function useGenomicFilters({ datasets = [] } = {}) {
  const [filterKeyword, setFilterKeyword] = useState("");
  const [filterChromosome, setFilterChromosome] = useState("All");
  const [filterGene, setFilterGene] = useState("All");
  const [filterSignificance, setFilterSignificance] = useState("All");
  const [filterConsequence, setFilterConsequence] = useState("All");
  const [filterZygosity, setFilterZygosity] = useState("All");
  const [filterRegion, setFilterRegion] = useState("All");
  const [filterBloodType, setFilterBloodType] = useState("All");
  const [filterFormat, setFilterFormat] = useState("All");
  const [filterAssembly, setFilterAssembly] = useState("All");
  const [filterPlatform, setFilterPlatform] = useState("All");
  const [filterPriceTier, setFilterPriceTier] = useState("All");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterDuration, setFilterDuration] = useState("All");
  const [blindMatchIds, setBlindMatchIds] = useState(null);
  const [sortBy, setSortBy] = useState("newest");

  const resetFilters = useCallback(() => {
    setFilterKeyword(""); setFilterChromosome("All"); setFilterGene("All");
    setFilterSignificance("All"); setFilterConsequence("All"); setFilterZygosity("All");
    setFilterRegion("All"); setFilterBloodType("All"); setFilterFormat("All"); setFilterAssembly("All");
    setFilterPlatform("All"); setFilterPriceTier("All"); setMinPrice("");
    setMaxPrice(""); setFilterStatus("All"); setFilterDuration("All");
    setBlindMatchIds(null);
    setSortBy("newest");
  }, []);

  const filteredDatasets = useMemo(() => {
    const normChrom = (c) => {
      const s = String(c || "").trim().toLowerCase().replace(/^chr/, "");
      return s === "mt" ? "m" : s;
    };
    const list = datasets || [];
    const filtered = list.filter((d) => {
      const q = filterKeyword.toLowerCase().trim();
      const matchesKeyword = !q ||
        d.disease?.toLowerCase().includes(q) || d.gene?.toLowerCase().includes(q) ||
        d.geneSymbol?.toLowerCase().includes(q) || d.chromosome?.toLowerCase().includes(q) ||
        d.rsId?.toLowerCase().includes(q) || d.hpoTerm?.toLowerCase().includes(q) ||
        d.clinvarId?.toLowerCase().includes(q) ||
        d.region?.toLowerCase().includes(q) ||
        d.ancestry?.toLowerCase().includes(q) ||
        d.titleVi?.toLowerCase().includes(q) ||
        d.titleEn?.toLowerCase().includes(q) ||
        d.categoryVi?.toLowerCase().includes(q) ||
        d.categoryEn?.toLowerCase().includes(q) ||
        d.format?.toLowerCase().includes(q) ||
        d.assembly?.toLowerCase().includes(q) ||
        d.platform?.toLowerCase().includes(q) ||
        String(d.dataId) === q ||
        String(d.dataId).includes(q) ||
        d.bloodGroup?.toLowerCase().includes(q) ||
        d.bloodType?.toLowerCase().includes(q);

      const matchesChrom = filterChromosome === "All" || (d.chromosome && normChrom(d.chromosome) === normChrom(filterChromosome));
      const matchesGene = filterGene === "All" || (d.geneSymbol && d.geneSymbol.toLowerCase().includes(filterGene.toLowerCase())) || (d.gene && d.gene.toLowerCase().includes(filterGene.toLowerCase()));
      const matchesSig = filterSignificance === "All" || d.clinicalSignificance === filterSignificance;
      const matchesCons = filterConsequence === "All" || d.consequence === filterConsequence;
      const matchesZyg = filterZygosity === "All" || (d.zygosity && d.zygosity.includes(filterZygosity));
      const matchesRegion = filterRegion === "All" || d.region?.toLowerCase().includes(filterRegion.toLowerCase()) || d.ancestry?.toLowerCase().includes(filterRegion.toLowerCase());
      const matchesBlood = matchesBloodTypeFilter(d, filterBloodType);
      const matchesFormat = filterFormat === "All" || (d.format && d.format.toUpperCase().includes(filterFormat.toUpperCase()));
      const matchesAssembly = filterAssembly === "All" || (d.assembly && d.assembly.toLowerCase().includes(filterAssembly.toLowerCase()));
      const matchesPlatform = filterPlatform === "All" || (d.platform && d.platform.toLowerCase().includes(filterPlatform.toLowerCase()));
      const matchesPriceTier = filterPriceTier === "All" ||
        (filterPriceTier === "Free" && d.price === 0) || (filterPriceTier === "Under100" && d.price <= 100) ||
        (filterPriceTier === "100To200" && d.price > 100 && d.price <= 200) || (filterPriceTier === "Over200" && d.price > 200);
      const matchesMinPrice = minPrice === "" || isNaN(Number(minPrice)) || Number(d.price) >= Number(minPrice);
      const matchesMaxPrice = maxPrice === "" || isNaN(Number(maxPrice)) || Number(d.price) <= Number(maxPrice);
      const matchesStatus = filterStatus === "All" || d.status === filterStatus;
      const matchesDuration = filterDuration === "All" || String(d.durationDays) === String(filterDuration);
      const matchesBlind = !Array.isArray(blindMatchIds) || blindMatchIds.includes(d.dataId);

      return (
        matchesKeyword && matchesChrom && matchesGene && matchesSig &&
        matchesCons && matchesZyg && matchesRegion && matchesBlood && matchesFormat &&
        matchesAssembly && matchesPlatform && matchesPriceTier &&
        matchesMinPrice && matchesMaxPrice && matchesStatus && matchesDuration && matchesBlind
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
    filterConsequence, filterZygosity, filterRegion, filterBloodType, filterFormat,
    filterAssembly, filterPlatform, filterPriceTier, minPrice, maxPrice,
    filterStatus, filterDuration, blindMatchIds, sortBy
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
      "Physiological Traits": "Tính Trạng Thể Chất",
      "Physical Traits & Performance": "Tính Trạng Thể Chất & Hiệu Suất",
      "Sensory & Metabolism": "Chuyển Hóa & Vị Giác",
      "Reference Benchmark": "Chuẩn Đối Chứng",
      "Reference Genomes": "Hệ Gen Tham Chiếu",
      "1000 Genomes Project": "Dự Án 1000 Genomes",
      "On-Chain Cohort": "Mẫu Di Truyền On-Chain",
      "Carrier Screening": "Sàng Lọc Người Mang Gen", "Pharmacogenomics": "Dược Lý Di Truyền",
      "Population Genetics": "Di Truyền Quần Thể", "Morphological Traits": "Hình Thái Học",
      "NGS Sequencing Reads": "Giải Trình Tự NGS", "Pathogenic Risk": "Biến Dị Chức Năng"
    };
    const mapEn = {
      "Physiological Traits": "Physiological Traits",
      "Physical Traits & Performance": "Physical Traits & Performance",
      "Sensory & Metabolism": "Sensory & Metabolism",
      "Reference Benchmark": "Reference Benchmark",
      "Reference Genomes": "Reference Genomes",
      "1000 Genomes Project": "1000 Genomes Project",
      "On-Chain Cohort": "On-Chain Cohort",
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
    return localizeZygosity(zyg, getActiveLang(lang));
  }, []);

  return {
    filterKeyword, setFilterKeyword, filterChromosome, setFilterChromosome,
    filterGene, setFilterGene, filterSignificance, setFilterSignificance,
    filterConsequence, setFilterConsequence, filterZygosity, setFilterZygosity,
    filterRegion, setFilterRegion, filterBloodType, setFilterBloodType, filterFormat, setFilterFormat,
    filterAssembly, setFilterAssembly, filterPlatform, setFilterPlatform,
    filterPriceTier, setFilterPriceTier, minPrice, setMinPrice,
    maxPrice, setMaxPrice, filterStatus, setFilterStatus,
    filterDuration, setFilterDuration, blindMatchIds, setBlindMatchIds, sortBy, setSortBy,
    resetFilters, filteredDatasets, getLocalizedTitle, getLocalizedTrait,
    getLocalizedSignificance, getLocalizedConsequence, getLocalizedZygosity
  };
}