import React from "react";

/**
 * Cryptographic, Security, Blockchain & Decentralized Infrastructure SVG Icons
 * Covers Shield, Key, Lock, Token, Cipher Capsules, IPFS Mesh, and zk-SNARK motifs.
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

export function ShieldCheckIcon({ size = 16, color = "currentColor", className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}
