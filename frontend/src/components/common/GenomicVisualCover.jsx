import React, { useState } from "react";
import { VerifiedBadgeIcon, DnaHelixIcon } from "../icons/GenoIcons";

// Pre-generated High-Resolution 3D Molecular Biotech NFT Artworks (100% Coverage)
export const PRESET_COVERS = {
  1: "/assets/covers/cover_1_khv.jpg",
  2: "/assets/covers/cover_2_actn3.jpg",
  3: "/assets/covers/cover_3_aldh2.jpg",
  4: "/assets/covers/cover_4_lct.jpg",
  5: "/assets/covers/cover_5_cyp1a2.jpg",
  6: "/assets/covers/cover_6_abcc11.jpg",
  7: "/assets/covers/cover_7_na12878.jpg",
  8: "/assets/covers/cover_8_herc2.jpg",
  9: "/assets/covers/cover_9_tas2r38.jpg",
  10: "/assets/covers/cover_10_edar.jpg",
  11: "/assets/covers/cover_11_giab.jpg",
  12: "/assets/covers/cover_8_herc2.jpg",
  13: "/assets/covers/cover_9_tas2r38.jpg"
};

const GENE_COVER_LOOKUP = {
  KHV: "/assets/covers/cover_1_khv.jpg",
  ACTN3: "/assets/covers/cover_2_actn3.jpg",
  ALDH2: "/assets/covers/cover_3_aldh2.jpg",
  MCM6: "/assets/covers/cover_4_lct.jpg",
  LCT: "/assets/covers/cover_4_lct.jpg",
  CYP1A2: "/assets/covers/cover_5_cyp1a2.jpg",
  ABCC11: "/assets/covers/cover_6_abcc11.jpg",
  NA12878: "/assets/covers/cover_7_na12878.jpg",
  HERC2: "/assets/covers/cover_8_herc2.jpg",
  OCA2: "/assets/covers/cover_8_herc2.jpg",
  TAS2R38: "/assets/covers/cover_9_tas2r38.jpg",
  EDAR: "/assets/covers/cover_10_edar.jpg",
  "MT-DNA": "/assets/covers/cover_11_giab.jpg"
};

export function getDatasetCoverUrl(dataset) {
  const gene = String(dataset?.geneSymbol || dataset?.gene || "").toUpperCase();
  for (const [key, url] of Object.entries(GENE_COVER_LOOKUP)) {
    if (gene.includes(key)) return url;
  }
  const dataId = Number(dataset?.dataId || 1);
  if (PRESET_COVERS[dataId]) return PRESET_COVERS[dataId];
  const fallbackIndex = ((Math.max(1, dataId) - 1) % 11) + 1;
  return PRESET_COVERS[fallbackIndex] || "/assets/covers/cover_2_actn3.jpg";
}

// Gene-specific procedural themes for procedural SVG covers
const PROCEDURAL_THEMES = {
  HERC2: {
    bg1: "#091428",
    bg2: "#022b42",
    accent: "#38bdf8",
    secondary: "#f59e0b",
    name: "Iris Pigmentation",
    type: "iris"
  },
  OCA2: {
    bg1: "#091428",
    bg2: "#022b42",
    accent: "#38bdf8",
    secondary: "#f59e0b",
    name: "Iris Pigmentation",
    type: "iris"
  },
  TAS2R38: {
    bg1: "#1e1035",
    bg2: "#3b0764",
    accent: "#c084fc",
    secondary: "#f43f5e",
    name: "Bitter Taste Receptor",
    type: "receptor"
  },
  EDAR: {
    bg1: "#1c1917",
    bg2: "#451a03",
    accent: "#fbbf24",
    secondary: "#38bdf8",
    name: "Hair & Tooth Morphology",
    type: "morphology"
  },
  LCT: {
    bg1: "#022c22",
    bg2: "#064e3b",
    accent: "#34d399",
    secondary: "#38bdf8",
    name: "Lactase Persistence",
    type: "metabolic"
  },
  CYP1A2: {
    bg1: "#1e1b4b",
    bg2: "#312e81",
    accent: "#818cf8",
    secondary: "#ec4899",
    name: "Caffeine & Drug Metabolism",
    type: "enzyme"
  },
  ABCC11: {
    bg1: "#0f172a",
    bg2: "#1e293b",
    accent: "#38bdf8",
    secondary: "#10b981",
    name: "Apocrine Gland Trait",
    type: "transport"
  },
  "MT-DNA": {
    bg1: "#050814",
    bg2: "#111827",
    accent: "#38bdf8",
    secondary: "#a855f7",
    name: "Mitochondrial Loop Genome",
    type: "circular"
  }
};

/**
 * Procedural Biotech SVG Illustration Generator
 * Creates beautiful, bioluminescent molecular/DNA backgrounds for any dataset.
 */
function ProceduralGenomicArtwork({ dataset, dataId }) {
  const gene = (dataset?.geneSymbol || dataset?.gene || "").toUpperCase();
  let themeKey = Object.keys(PROCEDURAL_THEMES).find((k) => gene.includes(k));
  const theme = themeKey
    ? PROCEDURAL_THEMES[themeKey]
    : {
        bg1: "#0a0f1d",
        bg2: "#0f172a",
        accent: dataId % 2 === 0 ? "#38bdf8" : "#34d399",
        secondary: dataId % 3 === 0 ? "#a855f7" : "#fbbf24",
        type: "dna"
      };

  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 360 180"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={`bgGrad-${dataId}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={theme.bg1} />
          <stop offset="50%" stopColor={theme.bg2} />
          <stop offset="100%" stopColor="#050811" />
        </linearGradient>

        <linearGradient id={`helixGrad1-${dataId}`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={theme.accent} stopOpacity="0.9" />
          <stop offset="100%" stopColor={theme.secondary} stopOpacity="0.8" />
        </linearGradient>

        <linearGradient id={`helixGrad2-${dataId}`} x1="100%" y1="0%" x2="0%" y2="0%">
          <stop offset="0%" stopColor={theme.secondary} stopOpacity="0.8" />
          <stop offset="100%" stopColor={theme.accent} stopOpacity="0.9" />
        </linearGradient>

        <radialGradient id={`glowCenter-${dataId}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={theme.accent} stopOpacity="0.35" />
          <stop offset="60%" stopColor={theme.secondary} stopOpacity="0.1" />
          <stop offset="100%" stopColor="transparent" stopOpacity="0" />
        </radialGradient>

        <pattern id={`gridPattern-${dataId}`} width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="0.8" fill={theme.accent} fillOpacity="0.2" />
        </pattern>
      </defs>

      {/* Deep Space Background */}
      <rect width="100%" height="100%" fill={`url(#bgGrad-${dataId})`} />
      <rect width="100%" height="100%" fill={`url(#gridPattern-${dataId})`} />

      {/* Bioluminescent Radiant Glow */}
      <ellipse cx="180" cy="90" rx="140" ry="70" fill={`url(#glowCenter-${dataId})`} />

      {/* Molecular & Genomic Vector Motifs */}
      {theme.type === "iris" ? (
        <g transform="translate(180, 90)">
          {/* Concentric Iris Melanin Aperture */}
          <circle r="65" fill="none" stroke={theme.accent} strokeWidth="1" strokeDasharray="3 6" opacity="0.4" />
          <circle r="48" fill="none" stroke={theme.secondary} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
          <circle r="32" fill="none" stroke={theme.accent} strokeWidth="2" opacity="0.8" />
          <circle r="16" fill={theme.secondary} fillOpacity="0.2" stroke={theme.secondary} strokeWidth="2" />
          <circle r="8" fill="#000" />
          {/* Chromatic Radiation Spokes */}
          {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg, i) => (
            <line
              key={i}
              x1="0"
              y1="0"
              x2={Math.cos((deg * Math.PI) / 180) * 72}
              y2={Math.sin((deg * Math.PI) / 180) * 72}
              stroke={i % 2 === 0 ? theme.accent : theme.secondary}
              strokeWidth="1"
              strokeDasharray="2 4"
              opacity="0.5"
            />
          ))}
        </g>
      ) : theme.type === "circular" ? (
        <g transform="translate(180, 90)">
          {/* Mitochondrial Circular Ring */}
          <circle r="55" fill="none" stroke={theme.accent} strokeWidth="2.5" strokeDasharray="6 3" />
          <circle r="45" fill="none" stroke={theme.secondary} strokeWidth="1" opacity="0.5" />
          <circle r="62" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" strokeDasharray="1 4" />
          {/* D-Loop Control Region Marker */}
          <path d="M-20,-52 A55,55 0 0,1 20,-52" fill="none" stroke="#f43f5e" strokeWidth="5" strokeLinecap="round" />
          <circle cx="0" cy="0" r="14" fill={theme.accent} fillOpacity="0.15" stroke={theme.accent} strokeWidth="1" />
        </g>
      ) : (
        /* Wavy DNA Double Helix with Base Pair Rungs */
        <g>
          {/* Base Pair Rungs */}
          {[20, 45, 70, 95, 120, 145, 170, 195, 220, 245, 270, 295, 320, 340].map((x, i) => {
            const phase = (x / 360) * Math.PI * 3;
            const y1 = 90 + Math.sin(phase) * 38;
            const y2 = 90 - Math.sin(phase) * 38;
            return (
              <g key={i}>
                <line
                  x1={x}
                  y1={y1}
                  x2={x}
                  y2={y2}
                  stroke={i % 2 === 0 ? theme.accent : theme.secondary}
                  strokeWidth="1.2"
                  strokeDasharray="1 3"
                  opacity="0.6"
                />
                <circle cx={x} cy={y1} r="2.5" fill={theme.accent} />
                <circle cx={x} cy={y2} r="2.5" fill={theme.secondary} />
              </g>
            );
          })}

          {/* Strand 1 */}
          <path
            d="M 10 90 Q 60 145, 110 90 T 210 90 T 310 90 T 360 90"
            fill="none"
            stroke={`url(#helixGrad1-${dataId})`}
            strokeWidth="3.2"
            strokeLinecap="round"
          />

          {/* Strand 2 */}
          <path
            d="M 10 90 Q 60 35, 110 90 T 210 90 T 310 90 T 360 90"
            fill="none"
            stroke={`url(#helixGrad2-${dataId})`}
            strokeWidth="3.2"
            strokeLinecap="round"
          />
        </g>
      )}

      {/* Floating Molecular Coordinates Overlay */}
      <text
        x="16"
        y="162"
        fill={theme.accent}
        fontSize="9"
        fontFamily="var(--font-mono, monospace)"
        fontWeight="700"
        letterSpacing="1px"
        opacity="0.8"
      >
        {dataset?.geneSymbol || dataset?.gene || "LOCUS.GENO"}
      </text>

      <text
        x="344"
        y="162"
        textAnchor="end"
        fill={theme.secondary}
        fontSize="9"
        fontFamily="var(--font-mono, monospace)"
        fontWeight="700"
        letterSpacing="0.5px"
        opacity="0.8"
      >
        {dataset?.chromosome || "chr12"}:{dataset?.rsId || "rs671"}
      </text>
    </svg>
  );
}

/**
 * GenomicVisualCover — OpenSea / DeSci Collection Card Cover Header
 * Features full-bleed visual cover, zoom on card hover, overlapping avatar with verified badge.
 */
export default function GenomicVisualCover({
  dataset,
  height = 165,
  showAvatar = true,
  showBadges = true,
  className = "",
  style = {}
}) {
  const [imgError, setImgError] = useState(false);
  const dataId = Number(dataset?.dataId || 1);
  const rawCoverUrl = getDatasetCoverUrl(dataset);
  const hasRealImage = Boolean(rawCoverUrl && !imgError);

  // Avatar initials / Symbol
  const geneRaw = dataset?.geneSymbol || dataset?.gene || "GENO";
  const avatarText = geneRaw.split(" ")[0].slice(0, 5);

  return (
    <div
      className={`genomic-visual-cover-container ${className}`}
      style={{
        position: "relative",
        height: `${height}px`,
        width: "100%",
        overflow: "visible",
        background: "#090d16",
        borderTopLeftRadius: "inherit",
        borderTopRightRadius: "inherit",
        ...style
      }}
    >
      {/* 1. Artwork Viewport (Clipped for hover zoom) */}
      <div
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          position: "relative",
          borderTopLeftRadius: "inherit",
          borderTopRightRadius: "inherit",
          borderBottom: "1px solid var(--border-subtle)"
        }}
      >
        {hasRealImage ? (
          <img
            src={rawCoverUrl}
            alt={dataset?.disease || "Genomic Dataset Cover"}
            onError={() => setImgError(true)}
            className="visual-cover-media"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center",
              display: "block",
              transition: "transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)"
            }}
          />
        ) : (
          <div
            className="visual-cover-media"
            style={{
              width: "100%",
              height: "100%",
              transition: "transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)"
            }}
          >
            <ProceduralGenomicArtwork dataset={dataset} dataId={dataId} />
          </div>
        )}

        {/* Ambient Vignette & Gradient Overlay for readability */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.65) 100%)",
            pointerEvents: "none"
          }}
        />

        {/* Top Floating Pills (Format & Token ID) */}
        {showBadges && (
        <div
          style={{
            position: "absolute",
            top: "10px",
            left: "12px",
            right: "12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            zIndex: 2,
            pointerEvents: "none"
          }}
        >
          {/* Format & Assembly Pill */}
          <div style={{ display: "flex", gap: "6px" }}>
            <span
              style={{
                fontSize: "10.5px",
                fontWeight: 700,
                fontFamily: "var(--font-mono, monospace)",
                padding: "3px 8px",
                borderRadius: "var(--radius-xs, 4px)",
                background: "rgba(10, 15, 28, 0.82)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                color: "#38bdf8",
                border: "1px solid rgba(56, 189, 248, 0.35)",
                boxShadow: "0 2px 6px rgba(0,0,0,0.3)"
              }}
            >
              {dataset?.format || "VCF v4.2"}
            </span>

            <span
              style={{
                fontSize: "10px",
                fontWeight: 600,
                fontFamily: "var(--font-mono, monospace)",
                padding: "3px 7px",
                borderRadius: "var(--radius-xs, 4px)",
                background: "rgba(10, 15, 28, 0.82)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                color: "rgba(255, 255, 255, 0.75)",
                border: "1px solid rgba(255, 255, 255, 0.15)"
              }}
            >
              {dataset?.assembly || "GRCh38"}
            </span>
          </div>

          {/* Token ID Pill */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 8px",
              borderRadius: "var(--radius-full, 9999px)",
              background: "rgba(10, 15, 28, 0.85)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(52, 211, 153, 0.4)",
              color: "#fff",
              fontSize: "11px",
              fontWeight: 800,
              fontFamily: "var(--font-mono, monospace)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.3)"
            }}
          >
            <span style={{ color: "#34d399", fontSize: "10px" }}>●</span>
            <span>#{String(dataId).padStart(2, "0")}</span>
          </div>
        </div>
        )}
      </div>

      {/* 2. OpenSea Overlapping Circular Avatar with Verified Badge */}
      {showAvatar && (
        <div
          className="opensea-avatar-badge-wrap"
          style={{
            position: "absolute",
            bottom: "-18px",
            left: "14px",
            zIndex: 4,
            display: "flex",
            alignItems: "center"
          }}
        >
          <div
            style={{
              width: "42px",
              height: "42px",
              borderRadius: "50%",
              background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
              border: "2.5px solid var(--bg-surface-solid, #0f172a)",
              boxShadow: "0 4px 14px rgba(0, 0, 0, 0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              overflow: "hidden"
            }}
          >
            {/* Ambient Avatar Glow */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  dataId % 2 === 0
                    ? "radial-gradient(circle, rgba(56,189,248,0.4) 0%, transparent 70%)"
                    : "radial-gradient(circle, rgba(52,211,153,0.4) 0%, transparent 70%)"
              }}
            />
            <DnaHelixIcon size={20} color={dataId % 2 === 0 ? "#38bdf8" : "#34d399"} />
          </div>

          {/* On-Chain Verified Badge (Small check circle) */}
          <div
            style={{
              position: "absolute",
              bottom: "-2px",
              right: "-2px",
              background: "var(--bg-surface-solid, #0f172a)",
              borderRadius: "50%",
              padding: "1px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            <VerifiedBadgeIcon size={14} color="#38bdf8" />
          </div>
        </div>
      )}
    </div>
  );
}
