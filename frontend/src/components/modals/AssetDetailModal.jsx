import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { useWeb3 } from "../../context/Web3Context";
import { useDatasets } from "../../context/DatasetContext";
import { useLanguage } from "../../context/LanguageContext";
import { verifyDatasetTraitZkStatus } from "../../services/datasetService";
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
  LockClosedIcon,
  RefreshSpinIcon
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
  const { account, contracts, showToast, setResearcherTab } = useWeb3();
  const { t, lang } = useLanguage();
  const [useEscrow, setUseEscrow] = useState(true);
  const [copiedKey, setCopiedKey] = useState(null);
  const [zkStatus, setZkStatus] = useState({ linked: false, verifierAddress: "", bountyCount: 0, verified: false });

  useEffect(() => {
    let active = true;
    if (!selectedAssetModal?.dataId || !contracts?.registry) {
      setZkStatus({ linked: false, verifierAddress: "", bountyCount: 0, verified: false });
      return () => {
        active = false;
      };
    }
    const canonicalCommitment =
      selectedAssetModal.variantCommitment ||
      (selectedAssetModal.geneSymbol && selectedAssetModal.owner
        ? ethers.keccak256(
            ethers.toUtf8Bytes(
              `${selectedAssetModal.geneSymbol}:${selectedAssetModal.rsId || selectedAssetModal.clinvarId || "TRAIT"}:${selectedAssetModal.owner}`
            )
          )
        : null);
    const canonicalTraitId = selectedAssetModal.geneSymbol
      ? ethers.keccak256(
          ethers.toUtf8Bytes(
            `${selectedAssetModal.geneSymbol}_${selectedAssetModal.rsId || "TRAIT"}`
          )
        )
      : null;
    verifyDatasetTraitZkStatus({
      dataId: selectedAssetModal.dataId,
      contracts,
      variantCommitment: canonicalCommitment,
      targetTraitId: canonicalTraitId,
      owner: selectedAssetModal.owner,
    }).then((res) => {
      if (active) setZkStatus(res);
    });
    return () => {
      active = false;
    };
  }, [
    selectedAssetModal?.dataId,
    selectedAssetModal?.variantCommitment,
    selectedAssetModal?.geneSymbol,
    selectedAssetModal?.rsId,
    selectedAssetModal?.clinvarId,
    selectedAssetModal?.owner,
    contracts,
  ]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setSelectedAssetModal(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSelectedAssetModal]);

  if (!selectedAssetModal) return null;

  const isOwner = Boolean(
    account && selectedAssetModal.owner && account.toLowerCase() === selectedAssetModal.owner.toLowerCase()
  );
  const purchasedRecord = purchasedData?.find((p) => p.dataId === selectedAssetModal.dataId);
  const isPurchased = Boolean(purchasedRecord);
  const isEscrowPending = Boolean(purchasedRecord?.isEscrowPending || purchasedRecord?.escrowInfo?.isPending);
  const displayTokenId = selectedAssetModal.tokenId ?? selectedAssetModal.dataId;
  const royaltyPct = Number((((selectedAssetModal.royaltyBps ?? 1000)) / 100).toFixed(2));

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
      rarity: t("traitSubGeneFreq")
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
      type: t("propertyConsequence") || "CONSEQUENCE",
      value: getLocalizedConsequence ? getLocalizedConsequence(selectedAssetModal.consequence, lang) : (selectedAssetModal.consequence || "missense_variant"),
      rarity: t("traitSubImpact")
    },
    {
      type: t("propertyZygosity") || "ZYGOSITY",
      value: getLocalizedZygosity ? getLocalizedZygosity(selectedAssetModal.zygosity, lang) : (selectedAssetModal.zygosity || "0/1 (Het)"),
      rarity: t("traitSubCall")
    },
    {
      type: t("propertyAncestry") || "COHORT",
      value: selectedAssetModal.ancestry || selectedAssetModal.region || "Vietnamese Kinh (KHV)",
      rarity: t("traitSubProject")
    },
    {
      type: t("propertyFormat") || "FORMAT",
      value: selectedAssetModal.format || "VCF v4.2",
      rarity: t("traitSubContainer")
    }
  ];

  const registryAddress = contractAddresses.GenomicsRegistry || "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
  const nftContractAddress = contractAddresses.GenomicNFT || "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

  return (
    <div className="terminal-modal-backdrop" onClick={() => setSelectedAssetModal(null)}>
      <div
        className="terminal-modal-window opensea-modal-container"
        role="dialog"
        aria-modal="true"
        aria-label={t("modalSpecTitle") || "Dataset Specifications"}
        onClick={(e) => e.stopPropagation()}
      >
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
                Token #{displayTokenId}
              </span>
            </div>
          </div>
          <button
            className="modal-close-btn"
            onClick={() => setSelectedAssetModal(null)}
            type="button"
            title={t("close")}
            aria-label={t("close") || "Close modal"}
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
              <GenomicVisualCover dataset={selectedAssetModal} height={215} showAvatar={false} />
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
                      title={t("copyContractAddress") || (lang === "vi" ? "Sao chép địa chỉ hợp đồng" : "Copy contract address")}
                      aria-label={t("copyContractAddress") || (lang === "vi" ? "Sao chép địa chỉ hợp đồng" : "Copy contract address")}
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
                  <span className="opensea-spec-val mono-hash">#{displayTokenId}</span>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("chainLabel") || "Blockchain Network"}</span>
                  <span className="opensea-spec-val">{t("chainVal") || "Local Hardhat EVM (31337)"}</span>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("creatorRoyaltyLabel") || "Creator Earnings"}</span>
                  <span className="opensea-spec-val" style={{ color: "var(--accent-amber-text)", fontWeight: 700 }}>
                    {`${royaltyPct}% (${t("eip2981EnforcedSuffix")})`}
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
                        title={t("copyMetadataCid") || (lang === "vi" ? "Sao chép CID Metadata" : "Copy Metadata CID")}
                        aria-label={t("copyMetadataCid") || (lang === "vi" ? "Sao chép CID Metadata" : "Copy Metadata CID")}
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
                        title={t("copyRawCid") || (lang === "vi" ? "Sao chép CID Dữ liệu thô" : "Copy Raw CID")}
                        aria-label={t("copyRawCid") || (lang === "vi" ? "Sao chép CID Dữ liệu thô" : "Copy Raw CID")}
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
                      {`${royaltyPct}% ${t("eip2981RoyaltyTag")}`}
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
                          color: useEscrow ? "var(--accent-emerald-text)" : "var(--text-secondary)",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px"
                        }}
                      >
                        <ShieldCheckIcon size={14} color={useEscrow ? "var(--accent-emerald-text)" : "var(--text-secondary)"} />
                        <span>{t("escrowProtectionToggle")}</span>
                      </label>
                      <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
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
                      background: useEscrow ? "#065f46" : "var(--bg-elevated)",
                      color: useEscrow ? "#ffffff" : "var(--text-secondary)",
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
                    className={`btn-terminal ${isEscrowPending ? "" : "btn-terminal-success"} btn-opensea-large`}
                    style={
                      isEscrowPending
                        ? {
                            color: "var(--accent-amber-text)",
                            borderColor: "var(--accent-amber)",
                            background: "rgba(245, 158, 11, 0.14)"
                          }
                        : undefined
                    }
                    type="button"
                    onClick={() => {
                      setSelectedAssetModal(null);
                      setResearcherTab("licensed");
                    }}
                  >
                    {isEscrowPending ? (
                      <>
                        <RefreshSpinIcon size={14} />
                        <span>{t("escrowPendingDelivery")} • {t("viewLicensedTab")}</span>
                      </>
                    ) : (
                      <>
                        <VerifiedBadgeIcon size={16} color="var(--accent-emerald)" />
                        <span>{t("btnPurchased")} • {t("viewLicensedTab") || "Xem & Giải Mã"}</span>
                      </>
                    )}
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
                <span style={{ fontSize: "10.5px", color: "var(--accent-emerald-text)", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                  {t("evmSha256Match") || "✓ EVM SHA-256 MATCH"}
                </span>
              </div>
              <div className="opensea-hash-row">
                <span className="mono-hash opensea-full-hash">{selectedAssetModal.rawDataHash}</span>
                <button
                  type="button"
                  className="icon-copy-btn"
                  onClick={() => copyText(selectedAssetModal.rawDataHash, "hash")}
                  title={t("copyRawHash") || (lang === "vi" ? "Sao chép mã băm SHA-256" : "Copy SHA-256 hash")}
                  aria-label={t("copyRawHash") || (lang === "vi" ? "Sao chép mã băm SHA-256" : "Copy SHA-256 hash")}
                >
                  {copiedKey === "hash" ? <CheckCircleIcon size={12} color="var(--accent-emerald)" /> : <CopyIcon size={12} />}
                </button>
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px", lineHeight: "1.4" }}>
                {t("provenanceZeroPlaintext")}
              </div>
              <div
                style={{
                  marginTop: "8px",
                  paddingTop: "8px",
                  borderTop: "1px dashed rgba(148, 163, 184, 0.25)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)"
                }}
              >
                <span style={{ color: "var(--text-secondary)" }}>
                  {zkStatus.linked
                    ? `${t("zkVerifierLinkedLabel")}: ${zkStatus.verifierAddress.slice(0, 8)}... (${zkStatus.bountyCount} ${t("zkBountiesUnit")})`
                    : t("zkVerifierNotLinked")}
                </span>
                <span style={{ color: zkStatus.verified ? "var(--accent-emerald-text)" : "var(--accent-cyan)", fontWeight: 700 }}>
                  {zkStatus.verified ? t("zkTraitVerifiedBadge") : t("zkAnchoredBadge")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
