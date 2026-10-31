import React from "react";

/**
 * Bio-informatics & Molecular Genetics SVG Icons
 * Covers DNA, Genomes, Chromosomes, Sequencing, Traits, and Metabolic Enzymes.
 */

export function ResearcherLabIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Bio-informatics optical scope & chromosome targeting */}
      <path d="M6 18h8" />
      <path d="M10 22v-4" />
      <path d="M10 14a4 4 0 0 1 4-4h2" />
      <rect x="13" y="3" width="7" height="5" rx="1.5" transform="rotate(45 13 3)" />
      <circle cx="9" cy="9" r="2" fill="none" strokeWidth="1.4" strokeDasharray="2 1" />
      <line x1="9" y1="6" x2="9" y2="12" strokeWidth="1.2" />
      <line x1="6" y1="9" x2="12" y2="9" strokeWidth="1.2" />
    </svg>
  );
}

export function ChromosomeIcon({ size = 16, color = "#38bdf8", className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Authentic Human Chromosome Structure: P-Arm, Centromere & Q-Arm (DBCLS / Servier Reference) */}
      <path d="M7.5 3c1.3 0 2.2 1.3 2.2 3.2v3.1c0 .9-.7 1.4-1.3 2.2.6.8 1.3 1.3 1.3 2.2v3.6c0 1.9-.9 3.2-2.2 3.2s-2.2-1.3-2.2-3.2v-3.6c0-.9.7-1.4 1.3-2.2-.6-.8-1.3-1.3-1.3-2.2v-3.1c0-1.9.9-3.2 2.2-3.2z" fill="rgba(56, 189, 248, 0.15)" />
      <path d="M16.5 3c-1.3 0-2.2 1.3-2.2 3.2v3.1c0 .9.7 1.4 1.3 2.2-.6.8 1.3 1.3 1.3 2.2v3.6c0 1.9.9 3.2 2.2 3.2s2.2-1.3 2.2-3.2v-3.6c0-.9-.7-1.4-1.3-2.2.6-.8 1.3-1.3 1.3-2.2v-3.1c0-1.9-.9-3.2-2.2-3.2z" fill="rgba(56, 189, 248, 0.15)" />
      <circle cx="9.7" cy="11.5" r="1" fill={color} />
      <circle cx="14.3" cy="11.5" r="1" fill={color} />
    </svg>
  );
}

export function DnaHelixIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 3c4 3 6 7 6 9s-2 6-6 9" />
      <path d="M20 3c-4 3-6 7-6 9s2 6 6 9" />
      <line x1="6.5" y1="6" x2="17.5" y2="6" strokeDasharray="1.5 2" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="6.5" y1="18" x2="17.5" y2="18" strokeDasharray="1.5 2" />
    </svg>
  );
}

export function PopulationGlobeIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8" />
      <path d="M3.6 15h16.8" />
      <ellipse cx="12" cy="12" rx="4.5" ry="9" />
      <circle cx="12" cy="12" r="1.5" fill={color} />
    </svg>
  );
}

export function GeneticTraitIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="6" cy="6" r="3" fill="rgba(56, 189, 248, 0.2)" />
      <circle cx="18" cy="6" r="3" fill="rgba(56, 189, 248, 0.2)" />
      <circle cx="12" cy="18" r="3" fill="rgba(56, 189, 248, 0.2)" />
      <path d="M8.5 7.5l7 7" />
      <path d="M15.5 7.5l-7 7" />
    </svg>
  );
}

export function MetabolismIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="12 3 19 7 19 15 12 19 5 15 5 7" fill="rgba(251, 191, 36, 0.15)" />
      <line x1="12" y1="3" x2="12" y2="9" />
      <line x1="12" y1="9" x2="18" y2="12" />
      <circle cx="12" cy="9" r="1.5" fill={color} />
    </svg>
  );
}

export function SequencingIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="4" y1="20" x2="20" y2="20" />
      <path d="M4 16c2-4 3-8 5-8s3 8 5 8 3-12 6-12" />
      <circle cx="9" cy="8" r="1.2" fill={color} />
      <circle cx="14" cy="16" r="1.2" fill={color} />
      <circle cx="20" cy="4" r="1.2" fill={color} />
    </svg>
  );
}

export function BenchmarkIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="8" strokeDasharray="3 1.5" />
      <circle cx="12" cy="12" r="3" fill="rgba(52, 211, 153, 0.2)" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
    </svg>
  );
}

export function MuscleFiberIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {/* Sarcomere parallel myofibrils */}
      <rect x="3" y="6" width="18" height="4" rx="2" fill="rgba(56, 189, 248, 0.15)" />
      <rect x="3" y="14" width="18" height="4" rx="2" fill="rgba(56, 189, 248, 0.15)" />
      <line x1="8" y1="4" x2="8" y2="20" strokeDasharray="1.5 1.5" />
      <line x1="16" y1="4" x2="16" y2="20" strokeDasharray="1.5 1.5" />
      <polygon points="12 8 14 12 10 12" fill={color} />
    </svg>
  );
}

export function EyeMelaninIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="3.5" fill="rgba(56, 189, 248, 0.25)" />
      <circle cx="12" cy="12" r="1.5" fill={color} />
    </svg>
  );
}

export function HairFollicleIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 21a4 4 0 0 1-4-4c0-3 4-8 4-14 0 6 4 11 4 14a4 4 0 0 1-4 4z" fill="rgba(56, 189, 248, 0.15)" />
      <line x1="12" y1="3" x2="12" y2="17" />
    </svg>
  );
}

export function TasteBudIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M6 19a6 6 0 0 1 12 0" />
      <path d="M12 10v9" />
      <circle cx="12" cy="7" r="3" fill="rgba(251, 191, 36, 0.25)" />
      <circle cx="7" cy="11" r="1.5" />
      <circle cx="17" cy="11" r="1.5" />
    </svg>
  );
}

export function EnzymeLactaseIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="8" cy="12" r="4.5" fill="rgba(251, 191, 36, 0.2)" />
      <circle cx="16" cy="12" r="4.5" fill="rgba(251, 191, 36, 0.2)" />
      <path d="M12 10.5c.5.8.5 2.2 0 3" strokeWidth="2" />
    </svg>
  );
}

export function AlcoholDehydrogenaseIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M6 4h12l-4 7v6h2v3H8v-3h2v-6L6 4z" />
      <circle cx="12" cy="8" r="1.5" fill={color} />
    </svg>
  );
}

export function ApocrineGlandIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 4v7" />
      <circle cx="12" cy="15" r="5" fill="rgba(251, 191, 36, 0.2)" />
      <circle cx="10" cy="14" r="1" fill={color} />
      <circle cx="14" cy="15" r="1" fill={color} />
      <circle cx="12" cy="17" r="1" fill={color} />
    </svg>
  );
}

export function CaffeineMetabolismIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="6 6 12 3 17 6 17 14 12 17 6 14" fill="rgba(251, 191, 36, 0.15)" />
      <path d="M17 9h4a2 2 0 0 1 0 4h-4" />
      <circle cx="12" cy="10" r="1.5" fill={color} />
    </svg>
  );
}

export function MitochondrialCircularIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="8" fill="rgba(216, 180, 254, 0.15)" />
      <circle cx="12" cy="12" r="4.5" />
      <rect x="11" y="2.5" width="2" height="3" fill={color} />
      <circle cx="16.5" cy="8" r="1" fill={color} />
      <circle cx="7.5" cy="15" r="1" fill={color} />
    </svg>
  );
}

export function FastqReadIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="5" rx="1.5" fill="rgba(216, 180, 254, 0.15)" />
      <rect x="3" y="11" width="18" height="5" rx="1.5" fill="rgba(216, 180, 254, 0.15)" />
      <line x1="5" y1="19" x2="8" y2="19" strokeWidth="2.5" />
      <line x1="10" y1="19" x2="14" y2="19" strokeWidth="2.5" />
      <line x1="16" y1="19" x2="19" y2="19" strokeWidth="2.5" />
    </svg>
  );
}

export function VietnameseCohortBadge({ size = 16, color = "#f472b6", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" fill="rgba(244, 114, 182, 0.15)" />
      <polygon points="12 6 13.8 10.2 18.2 10.5 14.8 13.3 16 17.6 12 15.2 8 17.6 9.2 13.3 5.8 10.5 10.2 10.2" fill={color} stroke="none" />
    </svg>
  );
}

export function AssemblyBuildIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="4" width="16" height="5" rx="1" fill="rgba(56, 189, 248, 0.15)" />
      <rect x="4" y="11" width="16" height="5" rx="1" fill="rgba(56, 189, 248, 0.15)" />
      <rect x="4" y="18" width="10" height="3" rx="1" />
      <line x1="9" y1="4" x2="9" y2="9" />
      <line x1="15" y1="11" x2="15" y2="16" />
    </svg>
  );
}

export function TechnologyPlatformIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" fill={color} />
      <circle cx="15.5" cy="8.5" r="1.5" fill={color} />
      <circle cx="8.5" cy="15.5" r="1.5" fill={color} />
      <circle cx="15.5" cy="15.5" r="1.5" fill={color} />
      <line x1="8.5" y1="10" x2="8.5" y2="14" />
      <line x1="15.5" y1="10" x2="15.5" y2="14" />
      <line x1="10" y1="8.5" x2="14" y2="8.5" />
      <line x1="10" y1="15.5" x2="14" y2="15.5" />
    </svg>
  );
}

export function ActivityPulseIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
