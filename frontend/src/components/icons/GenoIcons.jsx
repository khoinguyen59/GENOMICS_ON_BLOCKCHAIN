import React from "react";

/**
 * GenoIcons — Bespoke Handcrafted SVG Icon System
 * Designed specifically for GenoChain: Genomics & Blockchain Architecture.
 * Style: Crisp geometric vectors, 1.75px-2px stroke, subtle bio-informatics & crypto motifs.
 */

export function GenoLogoIcon({ size = 20, color = "#38bdf8", className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ color }}
    >
      {/* DNA double-helix interconnected with cryptographic block nodes */}
      <path d="M4 3c4 3 6 7 6 9s-2 6-6 9" stroke="url(#geno-grad-cyan)" />
      <path d="M20 3c-4 3-6 7-6 9s2 6 6 9" stroke="url(#geno-grad-emerald)" />
      <line x1="6.5" y1="6" x2="17.5" y2="6" stroke="rgba(56, 189, 248, 0.6)" strokeDasharray="1 2" />
      <circle cx="12" cy="12" r="3" fill="#0f172a" stroke="#38bdf8" strokeWidth="1.8" />
      <rect x="10.5" y="10.5" width="3" height="3" fill="#10b981" />
      <line x1="6.5" y1="18" x2="17.5" y2="18" stroke="rgba(16, 185, 129, 0.6)" strokeDasharray="1 2" />
      <defs>
        <linearGradient id="geno-grad-cyan" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#0284c7" />
        </linearGradient>
        <linearGradient id="geno-grad-emerald" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function DataOwnerShieldIcon({ size = 16, color = "currentColor", className = "" }) {
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
      {/* Sovereign Bio-Security Shield */}
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      {/* Internal DNA Helix fingerprint */}
      <path d="M9 9c1.5 1 4.5 1 6 0" strokeWidth="1.5" />
      <path d="M9 12c1.5-1 4.5-1 6 0" strokeWidth="1.5" />
      <path d="M9 15c1.5 1 4.5 1 6 0" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1.2" fill={color} />
    </svg>
  );
}

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

export function GenoTokenIcon({ size = 16, color = "#f59e0b", className = "" }) {
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
      {/* Hexagonal Cryptographic Token Coin */}
      <polygon points="12 2 21 7.2 21 16.8 12 22 3 16.8 3 7.2 12 2" fill="rgba(245, 158, 11, 0.12)" />
      {/* Stylized 'G' with nucleotide DNA link */}
      <path d="M15 8.5A4.5 4.5 0 1 0 15 15.5H12V12h3" strokeWidth="1.9" />
    </svg>
  );
}

export function SealedCipherIcon({ size = 16, color = "currentColor", className = "" }) {
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
      {/* Quantum-proof encrypted capsule */}
      <rect x="5" y="11" width="14" height="10" rx="3" fill="rgba(56, 189, 248, 0.08)" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      {/* Cipher hash keyhole */}
      <circle cx="12" cy="15" r="1.5" fill={color} />
      <line x1="12" y1="16.5" x2="12" y2="18.5" strokeWidth="2" />
    </svg>
  );
}

export function InMemoryDecryptIcon({ size = 16, color = "currentColor", className = "" }) {
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
      {/* Asymmetric key with DNA nucleotide teeth */}
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.8 12.2L20 3" />
      <path d="M16 7l2 2" />
      <path d="M18.5 4.5l2 2" />
      <circle cx="7.5" cy="15.5" r="1.5" fill={color} />
    </svg>
  );
}

export function IpfsMeshIcon({ size = 16, color = "currentColor", className = "" }) {
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
      {/* IPFS Decentralized Swarm Cluster */}
      <polygon points="12 2 20 7 20 17 12 22 4 17 4 7 12 2" fill="rgba(16, 185, 129, 0.08)" />
      <line x1="12" y1="2" x2="12" y2="12" />
      <line x1="12" y1="12" x2="20" y2="17" />
      <line x1="12" y1="12" x2="4" y2="17" />
      <circle cx="12" cy="12" r="2" fill="#10b981" />
    </svg>
  );
}

export function LanguageToggleIcon({ size = 16, color = "currentColor", className = "" }) {
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
      {/* Global Language / Bilingual Switcher */}
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8" />
      <path d="M3.6 15h16.8" />
      <path d="M11.5 3a17 17 0 0 0 0 18" />
      <path d="M12.5 3a17 17 0 0 1 0 18" />
    </svg>
  );
}

export function VerifiedBadgeIcon({ size = 14, color = "#10b981", className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polygon points="12 2 15 5 19 5 20 9 23 12 20 15 19 19 15 19 12 22 9 19 5 19 4 15 1 12 4 9 5 5 9 5 12 2" fill="rgba(16, 185, 129, 0.15)" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

export function WalletKeyIcon({ size = 16, color = "currentColor", className = "" }) {
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
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <circle cx="17" cy="14" r="1.5" fill={color} />
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
      <path d="M16.5 3c-1.3 0-2.2 1.3-2.2 3.2v3.1c0 .9.7 1.4 1.3 2.2-.6.8-1.3 1.3-1.3 2.2v3.6c0 1.9.9 3.2 2.2 3.2s2.2-1.3 2.2-3.2v-3.6c0-.9-.7-1.4-1.3-2.2.6-.8 1.3-1.3 1.3-2.2v-3.1c0-1.9-.9-3.2-2.2-3.2z" fill="rgba(56, 189, 248, 0.15)" />
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

export function PriceTagIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20.6 13.4l-7-7a2 2 0 0 0-1.4-.6H5a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l7 7a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill={color} />
    </svg>
  );
}

export function DurationCalendarIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <circle cx="12" cy="15" r="2.5" />
      <polyline points="12 14 12 15 13.5 15" />
    </svg>
  );
}

export function StatusIndicatorIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="8" fill="rgba(16, 185, 129, 0.15)" />
      <circle cx="12" cy="12" r="3" fill={color} />
      <circle cx="12" cy="12" r="6" strokeDasharray="2 2" />
    </svg>
  );
}

export function UploadCloudIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17.5 19H19a4 4 0 0 0 1.8-7.6 5 5 0 0 0-9.6-2.4 4 4 0 0 0-6.2 3.8A4 4 0 0 0 6.5 19H7" />
      <polyline points="12 12 12 21" />
      <polyline points="9 15 12 12 15 15" />
    </svg>
  );
}

export function LockClosedIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="5" y="11" width="14" height="10" rx="2" fill="rgba(56, 189, 248, 0.1)" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <circle cx="12" cy="15.5" r="1.5" fill={color} />
    </svg>
  );
}

export function LockOpenIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="5" y="11" width="14" height="10" rx="2" fill="rgba(16, 185, 129, 0.1)" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
      <circle cx="12" cy="15.5" r="1.5" fill={color} />
    </svg>
  );
}

export function DownloadArrowIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 4v12" />
      <polyline points="7 11 12 16 17 11" />
      <line x1="5" y1="20" x2="19" y2="20" />
    </svg>
  );
}

export function EyeInspectIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16" y2="16" />
      <line x1="11" y1="8" x2="11" y2="14" strokeDasharray="1 1" />
      <line x1="8" y1="11" x2="14" y2="11" strokeDasharray="1 1" />
    </svg>
  );
}

export function CheckCircleIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" fill="rgba(16, 185, 129, 0.15)" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  );
}

export function AlertTriangleIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="12 3 22 20 2 20" fill="rgba(245, 158, 11, 0.12)" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <circle cx="12" cy="16.5" r="0.8" fill={color} />
    </svg>
  );
}

export function RefreshSpinIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12a9 9 0 0 1-15.5 6.4L3 16" />
      <path d="M3 12a9 9 0 0 1 15.5-6.4L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <polyline points="3 21 3 16 8 16" />
    </svg>
  );
}

export function TrashBinIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

export function EditPencilIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

export function CloseCrossIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function FilterSlidersIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2.5" fill={color} />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2.5" fill={color} />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="7" cy="18" r="2.5" fill={color} />
    </svg>
  );
}

export function PlayIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="6 4 19 12 6 20" fill="rgba(16, 185, 129, 0.25)" />
    </svg>
  );
}

export function PauseIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="6" y="4" width="4" height="16" rx="1" fill={color} />
      <rect x="14" y="4" width="4" height="16" rx="1" fill={color} />
    </svg>
  );
}

export function UserPlusIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="16" y1="11" x2="22" y2="11" />
    </svg>
  );
}

export function SendPaperIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9" fill="rgba(56, 189, 248, 0.2)" />
    </svg>
  );
}

export function DollarCoinIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" fill="rgba(245, 158, 11, 0.15)" />
      <line x1="12" y1="6" x2="12" y2="18" />
      <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-1.5 2-2.5 2.5s-2.5 1-2.5 2.5a2.5 2.5 0 0 0 5 0" />
    </svg>
  );
}

export function ServerDriveIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="7" rx="2" fill="rgba(56, 189, 248, 0.1)" />
      <rect x="3" y="13" width="18" height="7" rx="2" fill="rgba(56, 189, 248, 0.1)" />
      <line x1="6" y1="7.5" x2="8" y2="7.5" />
      <line x1="6" y1="16.5" x2="8" y2="16.5" />
      <circle cx="17" cy="7.5" r="1" fill={color} />
      <circle cx="17" cy="16.5" r="1" fill={color} />
    </svg>
  );
}

export function CpuChipIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="5" y="5" width="14" height="14" rx="2" fill="rgba(56, 189, 248, 0.15)" />
      <circle cx="12" cy="12" r="2.5" fill={color} />
      <line x1="9" y1="1" x2="9" y2="5" />
      <line x1="15" y1="1" x2="15" y2="5" />
      <line x1="9" y1="19" x2="9" y2="23" />
      <line x1="15" y1="19" x2="15" y2="23" />
      <line x1="1" y1="9" x2="5" y2="9" />
      <line x1="1" y1="15" x2="5" y2="15" />
      <line x1="19" y1="9" x2="23" y2="9" />
      <line x1="19" y1="15" x2="23" y2="15" />
    </svg>
  );
}

export function DatabaseNodesIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <ellipse cx="12" cy="5" rx="9" ry="3" fill="rgba(16, 185, 129, 0.15)" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

export function NetworkMeshIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="5" r="2.5" fill={color} />
      <circle cx="5" cy="18" r="2.5" fill={color} />
      <circle cx="19" cy="18" r="2.5" fill={color} />
      <line x1="12" y1="7.5" x2="5" y2="15.5" />
      <line x1="12" y1="7.5" x2="19" y2="15.5" />
      <line x1="7.5" y1="18" x2="16.5" y2="18" />
    </svg>
  );
}

export function SunThemeIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

export function MoonThemeIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function SearchGlassIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function SortIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M11 5h10" />
      <path d="M11 9h7" />
      <path d="M11 13h4" />
      <path d="M3 17l3 3 3-3" />
      <path d="M6 18V4" />
    </svg>
  );
}

export function GridIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function ListIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1.5" fill={color} />
      <circle cx="4" cy="12" r="1.5" fill={color} />
      <circle cx="4" cy="18" r="1.5" fill={color} />
    </svg>
  );
}

export function ChevronDownIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 14, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function CopyIcon({ size = 14, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function SparklesIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" />
    </svg>
  );
}

export function LayersIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

export function ClockHistoryIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function ShieldCheckIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

export function FlameHotIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

export function ChevronUpIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="18 15 12 9 6 15" />
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

