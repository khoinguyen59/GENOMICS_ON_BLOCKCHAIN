import React, { useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import {
  DnaHelixIcon,
  PopulationGlobeIcon,
  GeneticTraitIcon,
  MetabolismIcon,
  SequencingIcon,
  BenchmarkIcon,
  VietnameseCohortBadge,
  MuscleFiberIcon,
  EyeMelaninIcon,
  HairFollicleIcon,
  TasteBudIcon,
  EnzymeLactaseIcon,
  AlcoholDehydrogenaseIcon,
  ApocrineGlandIcon,
  CaffeineMetabolismIcon,
  FastqReadIcon,
  MitochondrialCircularIcon
} from "../../components/icons/GenoIcons";

export default function ClinvarSampleBar({ onSelectPreset }) {
  const { t, lang } = useLanguage();
  const [activeCategory, setActiveCategory] = useState("all");

  const categories = [
    { id: "all", label: t("catAll"), Icon: DnaHelixIcon, color: "var(--accent-cyan)" },
    { id: "pop1000g", label: t("cat1000G"), Icon: PopulationGlobeIcon, color: "#f472b6" },
    { id: "traits", label: t("catTraits"), Icon: GeneticTraitIcon, color: "var(--accent-cyan)" },
    { id: "sensory", label: t("catSensory"), Icon: MetabolismIcon, color: "var(--accent-amber)" },
    { id: "sequencing", label: t("catSequencing"), Icon: SequencingIcon, color: "var(--accent-purple)" },
    { id: "benchmarks", label: t("catBenchmarks"), Icon: BenchmarkIcon, color: "var(--accent-emerald)" }
  ];

  const samples = [
    // 1000 Genomes
    {
      id: "KHV_1000G",
      category: "pop1000g",
      label: lang === "vi" ? "1000G Kinh VN (KHV WGS)" : "1000G Kinh VN (KHV WGS)",
      tooltip: "1000 Genomes Project Phase 3: KHV chr12 WGS",
      Icon: VietnameseCohortBadge,
      color: "#f472b6",
      featured: true
    },

    // Physical Traits & Performance
    {
      id: "ACTN3_PERFORMANCE",
      category: "traits",
      label: lang === "vi" ? "ACTN3 Sức Bền Cơ Bắp (rs1815739)" : "ACTN3 Muscle Fiber (rs1815739)",
      tooltip: "dbSNP:rs1815739 ACTN3 alpha-actinin-3",
      Icon: MuscleFiberIcon,
      color: "var(--accent-cyan)",
      featured: true
    },
    {
      id: "HERC2_PIGMENTATION",
      category: "traits",
      label: lang === "vi" ? "HERC2 Màu Mắt & Da (rs12913832)" : "HERC2 Eye & Skin (rs12913832)",
      tooltip: "dbSNP:rs12913832 HERC2/OCA2",
      Icon: EyeMelaninIcon,
      color: "var(--accent-cyan)",
      featured: false
    },
    {
      id: "EDAR_MORPHOLOGY",
      category: "traits",
      label: lang === "vi" ? "EDAR Sợi Tóc Đông Á (rs3827760)" : "EDAR Hair Morphology (rs3827760)",
      tooltip: "dbSNP:rs3827760 EDAR",
      Icon: HairFollicleIcon,
      color: "var(--accent-cyan)",
      featured: false
    },

    // Sensory & Metabolism
    {
      id: "TAS2R38_TASTE",
      category: "sensory",
      label: lang === "vi" ? "TAS2R38 Vị Giác Đắng (rs713598)" : "TAS2R38 Bitter Taste (rs713598)",
      tooltip: "dbSNP:rs713598 TAS2R38",
      Icon: TasteBudIcon,
      color: "var(--accent-amber)",
      featured: false
    },
    {
      id: "LCT_LACTASE",
      category: "sensory",
      label: lang === "vi" ? "MCM6/LCT Dung Nạp Sữa (rs4988235)" : "MCM6/LCT Lactase (rs4988235)",
      tooltip: "dbSNP:rs4988235 MCM6/LCT",
      Icon: EnzymeLactaseIcon,
      color: "var(--accent-amber)",
      featured: false
    },
    {
      id: "ALDH2_METABOLISM",
      category: "sensory",
      label: lang === "vi" ? "ALDH2 Chuyển Hóa Cồn (rs671)" : "ALDH2 Alcohol Metabolism (rs671)",
      tooltip: "dbSNP:rs671 ALDH2 Acetaldehyde dehydrogenase",
      Icon: AlcoholDehydrogenaseIcon,
      color: "var(--accent-amber)",
      featured: true
    },
    {
      id: "ABCC11_EARWAX",
      category: "sensory",
      label: lang === "vi" ? "ABCC11 Tuyến Mồ Hôi (rs17822931)" : "ABCC11 Apocrine Secretion (rs17822931)",
      tooltip: "dbSNP:rs17822931 ABCC11",
      Icon: ApocrineGlandIcon,
      color: "var(--accent-amber)",
      featured: false
    },
    {
      id: "CYP1A2_CAFFEINE",
      category: "sensory",
      label: lang === "vi" ? "CYP1A2 Chuyển Hóa Cafein (rs762551)" : "CYP1A2 Caffeine Clearance (rs762551)",
      tooltip: "dbSNP:rs762551 CYP1A2",
      Icon: CaffeineMetabolismIcon,
      color: "var(--accent-amber)",
      featured: false
    },

    // Sequencing & Reference Genomes
    {
      id: "WGS_FASTQ_READS",
      category: "sequencing",
      label: lang === "vi" ? "NovaSeq WGS Đọc Thô (FASTQ)" : "NovaSeq WGS Raw Reads (FASTQ)",
      tooltip: "Illumina NovaSeq 30x WGS raw reads",
      Icon: FastqReadIcon,
      color: "var(--accent-purple)",
      featured: true
    },
    {
      id: "CHRM_MITOCHONDRIAL",
      category: "sequencing",
      label: lang === "vi" ? "Hệ Gen Ty Thể chrM (FASTA)" : "Mitochondrial Genome (FASTA)",
      tooltip: "Human Mitochondrial Genome complete circular sequence (16,569 bp)",
      Icon: MitochondrialCircularIcon,
      color: "var(--accent-purple)",
      featured: false
    },

    // Benchmarks
    {
      id: "NA12878_GIAB",
      category: "benchmarks",
      label: "NIST GIAB NA12878 (13.5 KB)",
      tooltip: "GIAB Gold Standard Reference Genome chr20 callset",
      Icon: BenchmarkIcon,
      color: "var(--accent-emerald)",
      featured: false
    },
    {
      id: "SAMTOOLS_REF_PANEL",
      category: "benchmarks",
      label: "SAMtools Multi-locus (5.5 KB)",
      tooltip: "SAMtools / BCFtools Official Reference Multi-sample Benchmark Panel",
      Icon: BenchmarkIcon,
      color: "var(--accent-emerald)",
      featured: false
    }
  ];

  // Show either filtered by category, or the top 4 featured presets when 'all' is active
  const filteredSamples = activeCategory === "all"
    ? samples.filter((s) => s.featured)
    : samples.filter((s) => s.category === activeCategory);

  return (
    <div
      className="sample-download-bar"
      style={{
        padding: "14px 16px",
        gap: "12px",
        background: "var(--bg-surface-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md)"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <DnaHelixIcon size={16} color="var(--accent-cyan)" />
          <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
            {t("presetBarLabel")}
          </span>
        </div>

        {/* Category Filter Pills */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {categories.map((cat) => {
            const CatIcon = cat.Icon;
            const isSelected = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCategory(cat.id)}
                style={{
                  fontSize: "11.5px",
                  fontWeight: isSelected ? 700 : 500,
                  padding: "4px 10px",
                  borderRadius: "var(--radius-full)",
                  border: "1px solid",
                  borderColor: isSelected ? cat.color : "var(--border-subtle)",
                  background: isSelected ? "var(--bg-surface)" : "transparent",
                  color: isSelected ? "var(--text-primary)" : "var(--text-muted)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  transition: "all var(--transition-fast)"
                }}
              >
                <CatIcon size={12} color={isSelected ? cat.color : "var(--text-muted)"} />
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Actionable Sample Dataset Buttons */}
      <div className="sample-buttons-row" style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {filteredSamples.map((s) => {
          const SampleIcon = s.Icon;
          return (
            <button
              key={s.id}
              id={`btn-sample-${s.id.toLowerCase()}`}
              type="button"
              className="sample-download-btn"
              onClick={() => onSelectPreset(s.id)}
              title={s.tooltip}
              style={{
                borderColor: "var(--border-subtle)",
                color: "var(--text-primary)",
                background: "var(--bg-surface)",
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 600,
                borderRadius: "var(--radius-sm)",
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
                cursor: "pointer",
                transition: "all var(--transition-fast)"
              }}
            >
              <SampleIcon size={14} color={s.color} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
