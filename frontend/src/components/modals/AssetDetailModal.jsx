import React, { useState, useEffect } from "react";
import { useWeb3, CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME } from "../../context/Web3Context";
import { useDatasets } from "../../context/DatasetContext";
import { useLanguage } from "../../context/LanguageContext";
import { verifyDatasetTraitZkStatus } from "../../services/datasetService";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
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
  RefreshSpinIcon,
  AlertTriangleIcon
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
  const [zkStatus, setZkStatus] = useState({
    linked: false,
    verifierAddress: "",
    bountyCount: 0,
    verified: false,
    datasetBound: false,
    verificationScope: "none"
  });

  const modalRef = useModalFocusTrap(Boolean(selectedAssetModal), () => setSelectedAssetModal(null));

  useEffect(() => {
    let active = true;
    if (!selectedAssetModal?.dataId || !contracts?.registry) {
      setZkStatus({
        linked: false,
        verifierAddress: "",
        bountyCount: 0,
        verified: false,
        datasetBound: false,
        verificationScope: "none"
      });
      return () => {
        active = false;
      };
    }
    verifyDatasetTraitZkStatus({
      dataId: selectedAssetModal.dataId,
      contracts,
      rawDataHash: selectedAssetModal.rawDataHash || null,
      variantCommitment: selectedAssetModal.variantCommitment || null,
      targetTraitId: selectedAssetModal.bountyTargetTraitId || null,
      bountyTargetTraitId: selectedAssetModal.bountyTargetTraitId || null,
      geneSymbol: selectedAssetModal.geneSymbol || selectedAssetModal.gene || "",
      rsId: selectedAssetModal.rsId || "",
      clinvarId: selectedAssetModal.clinvarId || "",
      owner: selectedAssetModal.owner,
      originalCreator: selectedAssetModal.originalCreator,
    }).then((res) => {
      if (active) setZkStatus(res);
    });
    return () => {
      active = false;
    };
  }, [
    selectedAssetModal?.dataId,
    selectedAssetModal?.rawDataHash,
    selectedAssetModal?.variantCommitment,
    selectedAssetModal?.bountyTargetTraitId,
    selectedAssetModal?.geneSymbol,
    selectedAssetModal?.gene,
    selectedAssetModal?.rsId,
    selectedAssetModal?.clinvarId,
    selectedAssetModal?.owner,
    selectedAssetModal?.originalCreator,
    contracts,
  ]);

  if (!selectedAssetModal) return null;

  const isOwner = Boolean(
    account && selectedAssetModal.owner && account.toLowerCase() === selectedAssetModal.owner.toLowerCase()
  );
  const purchasedRecord = purchasedData?.find((p) => p.dataId === selectedAssetModal.dataId);
  const isPurchased = Boolean(purchasedRecord);
  const isEscrowDisputed = Boolean(purchasedRecord?.escrowInfo?.isDisputed);
  const isEscrowPending = Boolean(
    (purchasedRecord?.isEscrowPending || purchasedRecord?.escrowInfo?.isPending) &&
    !(purchasedRecord?.capsuleDelivered ?? purchasedRecord?.escrowInfo?.capsuleDelivered)
  );
  const displayTokenId = selectedAssetModal.tokenId ?? selectedAssetModal.dataId;
  const royaltyPct = Number((((selectedAssetModal.royaltyBps ?? 1000)) / 100).toFixed(2));

  const displayTitle = getLocalizedTitle ? getLocalizedTitle(selectedAssetModal, lang) : selectedAssetModal.disease;
  const displayCategory = getLocalizedSignificance
    ? getLocalizedSignificance(selectedAssetModal.clinicalSignificance, lang)
    : (selectedAssetModal.clinicalSignificance || "Physiological Traits");

  const copyText = (text, key) => {
    if (navigator.clipboard?.writeText) {
      Promise.resolve(navigator.clipboard.writeText(text))
        .then(() => {
          setCopiedKey(key);
          showToast(t("copiedToast") || "Đã sao chép vào bộ nhớ tạm!");
          setTimeout(() => setCopiedKey(null), 2500);
        })
        .catch(() => {
          showToast(lang === "vi" ? "Không có quyền ghi bộ nhớ tạm." : "Clipboard permission denied.", "error");
        });
    }
  };

  const is1000G = String(selectedAssetModal.platform || "").includes("1000") || String(selectedAssetModal.ancestry || "").includes("1000");
  const isCrypt4gh = String(selectedAssetModal.format || "").toLowerCase().includes("c4gh") || String(selectedAssetModal.format || "").toLowerCase().includes("crypt4gh");
  const traitList = [
    {
      type: t("propertyGene") || "TARGET GENE",
      value: selectedAssetModal.geneSymbol?.split(" ")?.[0] || selectedAssetModal.gene,
      rarity: selectedAssetModal.chromosome || "HGNC Locus"
    },
    {
      type: t("propertyChrom") || "CHROMOSOME",
      value: selectedAssetModal.chromosome || "UNSPECIFIED",
      rarity: selectedAssetModal.assembly || "GRCh38"
    },
    {
      type: t("propertyRsid") || "dbSNP rsID",
      value: selectedAssetModal.rsId || selectedAssetModal.clinvarId || "N/A",
      rarity: selectedAssetModal.clinvarId || "dbSNP v156"
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
      value: selectedAssetModal.ancestry || selectedAssetModal.region || "On-Chain Cohort",
      rarity: is1000G ? t("traitSubProject") : (selectedAssetModal.platform || "On-Chain Verified")
    },
    {
      type: t("propertyFormat") || "FORMAT",
      value: selectedAssetModal.format || "VCF v4.2",
      rarity: isCrypt4gh ? t("traitSubContainer") : "AES-256-GCM"
    }
  ];

  const registryAddress = contractAddresses.GenomicsRegistry || "";
  const formattedRegistryAddr =
    registryAddress.length >= 42
      ? `${registryAddress.substring(0, 6)}...${registryAddress.substring(38)}`
      : registryAddress || "N/A";
  const resolvedChainDisplay =
    CONFIGURED_CHAIN_ID === 31337 ? (t("chainVal") || CONFIGURED_CHAIN_NAME) : CONFIGURED_CHAIN_NAME;
  const verificationStatus =
    selectedAssetModal.metadataVerificationStatus ||
    (selectedAssetModal.metadataTampered ? "tampered" : "unverified");
  const isMetadataTampered = verificationStatus === "tampered" || Boolean(selectedAssetModal.metadataTampered);

  return (
    <div className="terminal-modal-backdrop" onClick={() => setSelectedAssetModal(null)}>
      <div
        ref={modalRef}
        tabIndex={-1}
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
            <CloseCrossIcon size={16} color="currentColor" />
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
                {verificationStatus === "verified" && <VerifiedBadgeIcon size={13} color="var(--accent-emerald)" />}
              </div>

              <div className="opensea-accordion-body">
                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("contractAddressLabel") || "Contract Address"}</span>
                  <div className="opensea-spec-val-copyable">
                    <span className="mono-hash">{formattedRegistryAddr}</span>
                    <button
                      type="button"
                      className="icon-copy-btn"
                      onClick={() => registryAddress && copyText(registryAddress, "contract")}
                      title={t("copyContractAddress") || (lang === "vi" ? "Sao chép địa chỉ hợp đồng" : "Copy contract address")}
                      aria-label={t("copyContractAddress") || (lang === "vi" ? "Sao chép địa chỉ hợp đồng" : "Copy contract address")}
                    >
                      {copiedKey === "contract" ? <CheckCircleIcon size={12} color="var(--accent-emerald-text)" /> : <CopyIcon size={12} />}
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
                  <span className="opensea-spec-val">{resolvedChainDisplay}</span>
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
                        {copiedKey === "metaCid" ? <CheckCircleIcon size={12} color="var(--accent-emerald-text)" /> : <CopyIcon size={12} />}
                      </button>
                    )}
                  </div>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("rawCiphertextIpfsLabel") || "Raw Ciphertext CID"}</span>
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
                        {copiedKey === "rawCid" ? <CheckCircleIcon size={12} color="var(--accent-emerald-text)" /> : <CopyIcon size={12} />}
                      </button>
                    )}
                  </div>
                </div>

                <div className="opensea-spec-row">
                  <span className="opensea-spec-key">{t("modalSummaryCidLabel") || "Summary Report CID"}</span>
                  <div className="opensea-spec-val-copyable">
                    <span className="mono-hash">{selectedAssetModal.summaryCid ? `${selectedAssetModal.summaryCid.substring(0, 10)}...` : "N/A"}</span>
                    {selectedAssetModal.summaryCid && (
                      <button
                        type="button"
                        className="icon-copy-btn"
                        onClick={() => copyText(selectedAssetModal.summaryCid, "summaryCid")}
                        title={t("modalSummaryCidLabel") || "Copy Summary CID"}
                        aria-label={t("modalSummaryCidLabel") || "Copy Summary CID"}
                      >
                        {copiedKey === "summaryCid" ? <CheckCircleIcon size={12} color="var(--accent-emerald-text)" /> : <CopyIcon size={12} />}
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
                {lang === "vi"
                  ? (selectedAssetModal.categoryVi ||
                      (getLocalizedSignificance
                        ? getLocalizedSignificance(selectedAssetModal.category || selectedAssetModal.clinicalSignificance, "vi")
                        : selectedAssetModal.category) ||
                      "Ngân hàng Dữ liệu 1000 Genomes")
                  : (selectedAssetModal.categoryEn ||
                      (getLocalizedSignificance
                        ? getLocalizedSignificance(selectedAssetModal.category || selectedAssetModal.clinicalSignificance, "en")
                        : selectedAssetModal.category) ||
                      "1000 Genomes Project Bio-Bank")}
              </span>
              {verificationStatus === "verified" ? (
                <span data-verification-badge="verified" title={t("evmSha256Match") || "EVM SHA-256 MATCH"} style={{ display: "inline-flex", alignItems: "center" }}>
                  <VerifiedBadgeIcon size={13} color="var(--accent-cyan)" />
                </span>
              ) : verificationStatus === "tampered" ? (
                <span data-verification-badge="tampered" title={t("evmMetadataTamperWarn")} style={{ display: "inline-flex", alignItems: "center" }}>
                  <AlertTriangleIcon size={13} color="var(--accent-rose)" />
                </span>
              ) : (
                <span
                  data-verification-badge={verificationStatus}
                  title={verificationStatus === "unanchored" ? t("evmMetadataUnanchoredBadge") : t("evmMetadataUnverifiedBadge")}
                  style={{ display: "inline-flex", alignItems: "center" }}
                >
                  <AlertTriangleIcon size={13} color="var(--accent-amber)" />
                </span>
              )}
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
                    {`${t("modalEscrowPriceLabel") || "ACCESS LICENSE FEE ($GENO)"} · ${royaltyPct}% EIP-2981`}
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
                <label
                  htmlFor="escrow-protection-toggle-modal"
                  className="buybox-escrow-toggle-row"
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <input
                      type="checkbox"
                      id="escrow-protection-toggle-modal"
                      checked={useEscrow}
                      onChange={(e) => setUseEscrow(e.target.checked)}
                      style={{ accentColor: "var(--accent-emerald)", cursor: "pointer", width: "16px", height: "16px" }}
                    />
                    <span style={{ display: "block" }}>
                      <span
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
                      </span>
                      <span style={{ display: "block", fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                        {t("escrowGuaranteeDesc") || "Funds held in smart contract until capsule dispatch. 100% refund guarantee."}
                      </span>
                    </span>
                  </span>

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
                </label>
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
                    className={`btn-terminal ${isEscrowDisputed || isEscrowPending ? "" : "btn-terminal-success"} btn-opensea-large`}
                    style={
                      isEscrowDisputed
                        ? {
                            color: "var(--accent-rose-text)",
                            borderColor: "var(--accent-rose)",
                            background: "rgba(239, 68, 68, 0.14)"
                          }
                        : isEscrowPending
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
                    {isEscrowDisputed ? (
                      <>
                        <AlertTriangleIcon size={14} color="var(--accent-rose-text)" />
                        <span>{t("escrowStatusDisputed")} • {t("viewLicensedTab")}</span>
                      </>
                    ) : isEscrowPending ? (
                      <>
                        <RefreshSpinIcon size={14} />
                        <span>{t("escrowPendingDelivery")} • {t("viewLicensedTab")}</span>
                      </>
                    ) : (
                      <>
                        <VerifiedBadgeIcon size={16} color="currentColor" />
                        <span>{t("btnPurchased")} • {t("viewLicensedTab") || "Xem & Giải Mã"}</span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    className="btn-terminal btn-terminal-primary btn-opensea-large"
                    onClick={() => onPurchase?.(selectedAssetModal, { useEscrow, disputeWindowDays: 1 })}
                    disabled={selectedAssetModal.status !== "Active" || isMetadataTampered}
                    title={isMetadataTampered ? t("evmMetadataTamperWarn") : undefined}
                    type="button"
                  >
                    <SealedCipherIcon size={16} />
                    <span>{isMetadataTampered ? t("btnMetadataTampered") : t("btnExecutePurchase")}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Cryptographic Proof Anchor & Zero-Plaintext Audit Box */}
            <div className="opensea-crypto-proof-box">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "6px" }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--accent-cyan)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  {t("modalHashLabel")}
                </span>
                <span
                  id="asset-modal-hash-status"
                  data-verification-status={verificationStatus}
                  data-tampered={String(isMetadataTampered)}
                  style={
                    verificationStatus === "tampered"
                      ? {
                          fontSize: "10.5px",
                          color: "var(--accent-rose-text)",
                          background: "var(--accent-rose-subtle)",
                          border: "1px solid var(--accent-rose)",
                          borderRadius: "4px",
                          padding: "2px 6px",
                          fontFamily: "var(--font-mono)",
                          fontWeight: 700
                        }
                      : verificationStatus === "unverified" || verificationStatus === "unanchored"
                        ? {
                            fontSize: "10.5px",
                            color: "var(--accent-amber-text)",
                            background: "var(--accent-amber-subtle)",
                            border: "1px solid var(--accent-amber)",
                            borderRadius: "4px",
                            padding: "2px 6px",
                            fontFamily: "var(--font-mono)",
                            fontWeight: 700
                          }
                        : {
                            fontSize: "10.5px",
                            color: "var(--accent-emerald-text)",
                            fontFamily: "var(--font-mono)",
                            fontWeight: 700
                          }
                  }
                >
                  {verificationStatus === "tampered"
                    ? t("evmMetadataTamperWarn")
                    : verificationStatus === "unanchored"
                      ? t("evmMetadataUnanchoredBadge")
                      : verificationStatus === "unverified"
                        ? t("evmMetadataUnverifiedBadge")
                        : (t("evmSha256Match") || "✓ EVM SHA-256 MATCH")}
                </span>
              </div>
              <div className="opensea-hash-row">
                <span className="mono-hash opensea-full-hash" title="rawDataHash (SHA-256)">Raw: {selectedAssetModal.rawDataHash}</span>
                <button
                  type="button"
                  className="icon-copy-btn"
                  onClick={() => copyText(selectedAssetModal.rawDataHash, "hash")}
                  title={t("copyRawHash") || (lang === "vi" ? "Sao chép mã băm SHA-256" : "Copy SHA-256 hash")}
                  aria-label={t("copyRawHash") || (lang === "vi" ? "Sao chép mã băm SHA-256" : "Copy SHA-256 hash")}
                >
                  {copiedKey === "hash" ? <CheckCircleIcon size={12} color="var(--accent-emerald-text)" /> : <CopyIcon size={12} />}
                </button>
              </div>
              {selectedAssetModal.summaryDataHash && (
                <div className="opensea-hash-row" style={{ marginTop: "4px" }}>
                  <span className="mono-hash opensea-full-hash" title="summaryDataHash (SHA-256)">PDF: {selectedAssetModal.summaryDataHash}</span>
                  <button
                    type="button"
                    className="icon-copy-btn"
                    onClick={() => copyText(selectedAssetModal.summaryDataHash, "sumHash")}
                    title={t("copySummaryHash")}
                    aria-label={t("copySummaryHash")}
                  >
                    {copiedKey === "sumHash" ? <CheckCircleIcon size={12} color="var(--accent-emerald-text)" /> : <CopyIcon size={12} />}
                  </button>
                </div>
              )}
              {selectedAssetModal.metadataHash && (
                <div className="opensea-hash-row" style={{ marginTop: "4px" }}>
                  <span className="mono-hash opensea-full-hash" title="metadataHash (SHA-256)">Meta: {selectedAssetModal.metadataHash}</span>
                  <button
                    type="button"
                    className="icon-copy-btn"
                    onClick={() => copyText(selectedAssetModal.metadataHash, "metaHash")}
                    title={t("copyMetadataHash")}
                    aria-label={t("copyMetadataHash")}
                  >
                    {copiedKey === "metaHash" ? <CheckCircleIcon size={12} color="var(--accent-emerald-text)" /> : <CopyIcon size={12} />}
                  </button>
                </div>
              )}
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
                <span
                  id="asset-modal-zk-badge"
                  data-zk-scope={zkStatus.verificationScope || "none"}
                  style={{
                    color: zkStatus.datasetBound
                      ? "var(--accent-emerald-text)"
                      : zkStatus.verified
                        ? "var(--accent-amber-text)"
                        : "var(--accent-cyan)",
                    fontWeight: 700
                  }}
                >
                  {zkStatus.datasetBound
                    ? t("zkDatasetBoundVerifiedBadge")
                    : zkStatus.verified
                      ? t("zkDonorLevelVerifiedBadge")
                      : t("zkAnchoredBadge")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}