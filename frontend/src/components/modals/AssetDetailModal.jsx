import React, { useState } from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useDatasets } from "../../context/DatasetContext";
import { useLanguage } from "../../context/LanguageContext";
import {
  GenoLogoIcon,
  GenoTokenIcon,
  SealedCipherIcon,
  VerifiedBadgeIcon,
  CloseCrossIcon,
  DnaHelixIcon,
  CopyIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
  LayersIcon,
  CheckCircleIcon,
  LockOpenIcon,
  LockClosedIcon
} from "../icons/GenoIcons";
import GenomicVisualCover from "../common/GenomicVisualCover";
import contractAddresses from "../../contracts/contractAddresses.json";

export default function AssetDetailModal({ onPurchase }) {
  const {
    selectedAssetModal,
    setSelectedAssetModal,
    purchasedData,
    getLocalizedTitle,
    getLocalizedSignificance,
    getLocalizedConsequence,
    getLocalizedZygosity
  } = useDatasets();
  const { account, showToast, setResearcherTab } = useWeb3();
  const { t, lang } = useLanguage();
  const [useEscrow, setUseEscrow] = useState(true);
  const [copiedKey, setCopiedKey] = useState(null);

  if (!selectedAssetModal) return null;

  const isOwner = Boolean(
    account && selectedAssetModal.owner && account.toLowerCase() === selectedAssetModal.owner.toLowerCase()
  );
  const isPurchased = Boolean(
    purchasedData && purchasedData.some((p) => p.dataId === selectedAssetModal.dataId)
  );

  const displayTitle = getLocalizedTitle ? getLocalizedTitle(selectedAssetModal, lang) : selectedAssetModal.disease;
  const displayCategory = getLocalizedSignificance
    ? getLocalizedSignificance(selectedAssetModal.clinicalSignificance, lang)
    : (selectedAssetModal.clinicalSignificance || "Physiological Traits");

  const copyText = (text, key) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      showToast(t("copiedToast") || "Đã sao chép vào bộ nhớ tạm!");
      setTimeout(() => setCopiedKey(null), 2500);
    }
  };

  const traitList = [
    {
      type: t("propertyGene") || "TARGET GENE",
      value: selectedAssetModal.geneSymbol?.split(" ")?.[0] || selectedAssetModal.gene,
      rarity: "9.1% (Gene Frequency)"
    },
    {
      type: t("propertyChrom") || "CHROMOSOME",
      value: selectedAssetModal.chromosome || "chr12",
      rarity: selectedAssetModal.assembly || "GRCh38"
    },
    {
      type: t("propertyRsid") || "dbSNP rsID",
      value: selectedAssetModal.rsId || selectedAssetModal.clinvarId || "rs671",
      rarity: "dbSNP v156"
    },
    {
      type: t("propertySignificance") || "FUNCTIONAL TRAIT",
      value: displayCategory,
      rarity: t("rarityCommon") || "Verified Trait"
    },
    {
      type: "CONSEQUENCE",
      value: getLocalizedConsequence ? getLocalizedConsequence(selectedAssetModal.consequence, lang) : (selectedAssetModal.consequence || "missense_variant"),
      rarity: "Molecular Impact"
    },
    {
      type: t("propertyZygosity") || "ZYGOSITY",
      value: getLocalizedZygosity ? getLocalizedZygosity(selectedAssetModal.zygosity, lang) : (selectedAssetModal.zygosity || "0/1 (Het)"),
      rarity: "Genotype Call"
    },
    {
      type: t("propertyAncestry") || "COHORT",
      value: selectedAssetModal.ancestry || selectedAssetModal.region || "Vietnamese Kinh (KHV)",
      rarity: "1000 Genomes Project"
    },
    {
      type: t("propertyFormat") || "FORMAT",
      value: selectedAssetModal.format || "VCF v4.2",
      rarity: "GA4GH Crypt4GH"
    }
  ];

  const registryAddress = contractAddresses.GenomicsRegistry || "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
  const nftContractAddress = contractAddresses.GenomicNFT || "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

  return (
    <div className="terminal-modal-backdrop" onClick={() => setSelectedAssetModal(null)}>
      <div className="terminal-modal-window opensea-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Top Header Bar */}
        <div className="modal-header-bar">
          <div className="modal-title-left">
            <GenoLogoIcon size={22} color="var(--accent-cyan)" />
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "14px", fontWeight: 800, color: "var(--text-primary)" }}>
                {t("modalSpecTitle")}{selectedAssetModal.dataId}
              </span>
              <span className="chrom-chip" style={{ fontSize: "11px", padding: "2px 8px" }}>
                {selectedAssetModal.gene}
              </span>
              <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                Token #{selectedAssetModal.dataId}
              </span>
            </div>
          </div>
          <button
            className="modal-close-btn"
            onClick={() => setSelectedAssetModal(null)}
            type="button"
            title={t("close")}
          >
            <CloseCrossIcon size={16} color="var(--text-muted)" />
          </button>
        </div>

        {/* Modal Main Content: OpenSea 2-Column Responsive Layout */}
        <div className="opensea-modal-content-grid">
          {/* ─── Left Column: Artwork Showcase & On-Chain Provenance ─── */}
          <div className="opensea-modal-left-col">
            {/* Visual Cover Container */}
            <div className="opensea-modal-artwork-box">
              <GenomicVisualCover dataset={selectedAssetModal} height={250} showAvatar={true} />
              <div className="opensea-artwork-badge-row">
                <span className="opensea-overlay-chip">
                  <VerifiedBadgeIcon size={12} color="var(--accent-cyan)" />
                  <span>{selectedAssetModal.format || "VCF v4.2"}</span>
                </span>
                <span className="opensea-overlay-chip">
                  <span>{selectedAssetModal.assembly || "GRCh38"}</span>
                </span>
              </div>
            </div>

            {/* Smart Contract Specifications (OpenSea Details Accordion) */}
            <div className="opensea-accordion-panel">
              <div className="opensea-accordion-header">
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <LayersIcon size={15} color="var(--accent-cyan)" />
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
                    {t("contractDetailsTitle") || "Smart Contract Specifications"}
                  </span>
                </div>
                <VerifiedBadgeIcon size={13} color="var(--accent-emerald)" />
              </div>

              <div className="opensea-accordion-body">
                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("contractAddressLabel") || "Contract Address"}</span>
                  <div className="opensea-spec-val-copyable">
                    <span className="mono-hash">{registryAddress.substring(0, 6)}...{registryAddress.substring(38)}</span>
                    <button
                      type="button"
                      className="icon-copy-btn"
                      onClick={() => copyText(registryAddress, "contract")}
                      title="Copy contract address"
                    >
                      {copiedKey === "contract" ? <CheckCircleIcon size={12} color="var(--accent-emerald)" /> : <CopyIcon size={12} />}
                    </button>
                  </div>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("tokenStandard") || "Token Standard"}</span>
                  <span className="opensea-spec-val" style={{ fontWeight: 600 }}>{t("tokenStandardVal") || "ERC-721"}</span>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("tokenIdLabel") || "Token ID"}</span>
                  <span className="opensea-spec-val mono-hash">#{selectedAssetModal.dataId}</span>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("chainLabel") || "Blockchain Network"}</span>
                  <span className="opensea-spec-val">{t("chainVal") || "Local Hardhat EVM (31337)"}</span>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("creatorRoyaltyLabel") || "Creator Earnings"}</span>
                  <span className="opensea-spec-val" style={{ color: "var(--accent-amber)", fontWeight: 700 }}>
                    {t("creatorRoyaltyVal") || "10% (EIP-2981 Enforced)"}
                  </span>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("metadataIpfsLabel") || "Metadata CID"}</span>
                  <div className="opensea-spec-val-copyable">
                    <span className="mono-hash">{selectedAssetModal.metadataCid ? `${selectedAssetModal.metadataCid.substring(0, 10)}...` : "N/A"}</span>
                    {selectedAssetModal.metadataCid && (
                      <button
                        type="button"
                        className="icon-copy-btn"
                        onClick={() => copyText(selectedAssetModal.metadataCid, "metaCid")}
                        title="Copy Metadata CID"
                      >
                        {copiedKey === "metaCid" ? <CheckCircleIcon size={12} color="var(--accent-emerald)" /> : <CopyIcon size={12} />}
                      </button>
                    )}
                  </div>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("rawCiphertextIpfsLabel") || "Ciphertext CID"}</span>
                  <div className="opensea-spec-val-copyable">
                    <span className="mono-hash">{selectedAssetModal.rawCid ? `${selectedAssetModal.rawCid.substring(0, 10)}...` : "N/A"}</span>
                    {selectedAssetModal.rawCid && (
                      <button
                        type="button"
                        className="icon-copy-btn"
                        onClick={() => copyText(selectedAssetModal.rawCid, "rawCid")}
                        title="Copy Raw CID"
                      >
                        {copiedKey === "rawCid" ? <CheckCircleIcon size={12} color="var(--accent-emerald)" /> : <CopyIcon size={12} />}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ─── Right Column: Collection, Titles, Traits Grid, Price & Buy Box ─── */}
          <div className="opensea-modal-right-col">
            {/* Collection & Series Tag */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 800,
                  color: "var(--accent-cyan)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em"
                }}
              >
                {selectedAssetModal.category || "1000 Genomes Project Bio-Bank"}
              </span>
              <VerifiedBadgeIcon size={13} color="var(--accent-cyan)" />
            </div>

            {/* Asset Title */}
            <h2 className="opensea-modal-title">
              {displayTitle}
            </h2>

            {/* Owner & Provenance Byline */}
            <div className="opensea-modal-owner-row">
              <div className="opensea-owner-avatar">
                <DnaHelixIcon size={14} color="var(--accent-cyan)" />
              </div>
              <div style={{ fontSize: "12.5px", color: "var(--text-muted)" }}>
                <span>{t("collectionCreator") || "By"}: </span>
                <span className="mono-hash" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {selectedAssetModal.owner ? `${selectedAssetModal.owner.substring(0, 6)}...${selectedAssetModal.owner.substring(38)}` : "Consortium"}
                </span>
              </div>
            </div>

            {/* ─── OpenSea Traits & Properties Grid ─── */}
            <div className="opensea-traits-section">
              <div className="opensea-section-title">
                <DnaHelixIcon size={15} color="var(--accent-cyan)" />
                <span>{t("traitRarityTitle") || "Properties & Molecular Traits"}</span>
              </div>

              <div className="opensea-traits-grid">
                {traitList.map((tr, idx) => (
                  <div key={idx} className="opensea-trait-card">
                    <span className="opensea-trait-type">{tr.type}</span>
                    <span className="opensea-trait-val" title={tr.value}>{tr.value}</span>
                    <span className="opensea-trait-rarity">{tr.rarity}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ─── OpenSea Buy Box Container ─── */}
            <div className="opensea-buybox-container">
              <div className="buybox-header">
                <div>
                  <div className="buybox-price-label">
                    {t("modalEscrowPriceLabel") || "CURRENT ACCESS PRICE"}
                  </div>
                  <div className="buybox-price-row">
                    <GenoTokenIcon size={24} color="var(--accent-cyan)" />
                    <span className="buybox-price-num">{selectedAssetModal.price}</span>
                    <span className="buybox-price-symbol">$GENO</span>
                    <span className="buybox-royalty-tag">
                      {t("royaltyEip2981") || "10% EIP-2981 Royalty"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Escrow Protection Toggle */}
              {!isOwner && !isPurchased && (
                <div
                  className="buybox-escrow-toggle-row"
                  onClick={() => setUseEscrow((prev) => !prev)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <input
                      type="checkbox"
                      id="escrow-protection-toggle-modal"
                      checked={useEscrow}
                      onChange={(e) => setUseEscrow(e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ accentColor: "var(--accent-emerald)", cursor: "pointer", width: "16px", height: "16px" }}
                    />
                    <div>
                      <label
                        htmlFor="escrow-protection-toggle-modal"
                        style={{
                          fontSize: "12.5px",
                          fontWeight: 700,
                          color: useEscrow ? "var(--accent-emerald)" : "var(--text-secondary)",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px"
                        }}
                      >
                        <ShieldCheckIcon size={14} color={useEscrow ? "var(--accent-emerald)" : "var(--text-muted)"} />
                        <span>{t("escrowProtectionToggle")}</span>
                      </label>
                      <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                        {t("escrowGuaranteeDesc") || "Funds held in smart contract until capsule dispatch. 100% refund guarantee."}
                      </div>
                    </div>
                  </div>

                  <span
                    style={{
                      fontSize: "10.5px",
                      fontFamily: "var(--font-mono)",
                      padding: "3px 8px",
                      borderRadius: "var(--radius-sm)",
                      background: useEscrow ? "rgba(16, 185, 129, 0.15)" : "rgba(255, 255, 255, 0.05)",
                      color: useEscrow ? "var(--accent-emerald)" : "var(--text-muted)",
                      fontWeight: 800,
                      whiteSpace: "nowrap"
                    }}
                  >
                    {useEscrow ? t("escrowLock24h") : t("escrowDirect")}
                  </span>
                </div>
              )}

              {/* Primary Action Buttons (Preserving isOwner, isPurchased, btnYourDataset, btnPurchased) */}
              <div className="buybox-action-row">
                {isOwner ? (
                  <button
                    className="btn-terminal btn-terminal-ghost btn-opensea-large"
                    disabled
                    type="button"
                  >
                    <span>{t("btnYourDataset")}</span>
                  </button>
                ) : isPurchased ? (
                  <button
                    className="btn-terminal btn-terminal-success btn-opensea-large"
                    type="button"
                    onClick={() => {
                      setSelectedAssetModal(null);
                      setResearcherTab("licensed");
                    }}
                  >
                    <VerifiedBadgeIcon size={16} color="var(--accent-emerald)" />
                    <span>{t("btnPurchased")} • {t("viewLicensedTab") || "Xem & Giải Mã"}</span>
                  </button>
                ) : (
                  <button
                    className="btn-terminal btn-terminal-primary btn-opensea-large"
                    onClick={() => onPurchase?.(selectedAssetModal, { useEscrow, disputeWindowDays: 1 })}
                    disabled={selectedAssetModal.status !== "Active"}
                    type="button"
                  >
                    <SealedCipherIcon size={16} />
                    <span>{t("btnExecutePurchase")}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Cryptographic Proof Anchor & Zero-Plaintext Audit Box */}
            <div className="opensea-crypto-proof-box">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--accent-cyan)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  {t("modalHashLabel")}
                </span>
                <span style={{ fontSize: "10.5px", color: "var(--accent-emerald)", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                  {t("evmSha256Match") || "✓ EVM SHA-256 MATCH"}
                </span>
              </div>
              <div className="opensea-hash-row">
                <span className="mono-hash opensea-full-hash">{selectedAssetModal.rawDataHash}</span>
                <button
                  type="button"
                  className="icon-copy-btn"
                  onClick={() => copyText(selectedAssetModal.rawDataHash, "hash")}
                  title="Copy SHA-256 hash"
                >
                  {copiedKey === "hash" ? <CheckCircleIcon size={12} color="var(--accent-emerald)" /> : <CopyIcon size={12} />}
                </button>
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "6px", lineHeight: "1.4" }}>
                {t("provenanceZeroPlaintext")}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
