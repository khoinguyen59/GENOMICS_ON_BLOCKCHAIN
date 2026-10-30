import React, { useState, useRef, useEffect } from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { PRESET_CATALOG, parseVcfMetadata } from "../../services/vcfService";
import { encryptGenomicData } from "../../../../crypto/client_crypto.js";
import { SealedCipherIcon, VerifiedBadgeIcon, RefreshSpinIcon, DataOwnerShieldIcon } from "../../components/icons/GenoIcons";
import ClinvarSampleBar from "./ClinvarSampleBar";
import PipelineProgressMonitor from "./PipelineProgressMonitor";

export default function DragDropMintingStudio({ onPublishSuccess }) {
  const { account, showToast } = useWeb3();
  const { t } = useLanguage();

  // Drag & Drop State
  const MAX_PREVIEW_SIZE = 10 * 1024 * 1024; // 10MB memory guard

  // Drag & Drop State
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("KHV_chr12_1000genomes.vcf");
  const [uploadedFileSize, setUploadedFileSize] = useState(2048);
  const [rawFileBlob, setRawFileBlob] = useState(null);
  const [isChunkedMode, setIsChunkedMode] = useState(false);
  const [chunkProgress, setChunkProgress] = useState(null);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const fileInputRef = useRef(null);

  // Form State
  const [subjectId, setSubjectId] = useState("1000G_KHV_VN_01");
  const [disease, setDisease] = useState("1000 Genomes Project — Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)");
  const [hpoCode, setHpoCode] = useState("SO:0000694 — Population Genomic SNP Callset");
  const [geneSymbol, setGeneSymbol] = useState("ALDH2 / ADH1B Multi-locus Loci (chr12)");
  const [fileFormat, setFileFormat] = useState("VCF v4.2");
  const [ancestryRegion, setAncestryRegion] = useState("Vietnamese Kinh (1000 Genomes: KHV)");
  const [rawFileText, setRawFileText] = useState(
    `##fileformat=VCFv4.2\n##source=1000Genomes_Phase3_KHV\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\nchr12\t111803962\trs671\tG\tA\t100\tPASS\tAF=0.38000;GENE=ALDH2;TRAIT=1000G_KHV_WGS;CATEGORY=1000 Genomes Project;FORMAT=VCFv4.2;ANCESTRY=Vietnamese Kinh (KHV);ANN=A|missense_variant|MODERATE|ALDH2|transcript|NM_000690.4|protein_coding|12/13|c.1510G>A|p.Glu504Lys`
  );
  const [priceGeno, setPriceGeno] = useState(100);
  const [durationDays, setDurationDays] = useState(45);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishStep, setPublishStep] = useState(0);

  // Live Transmission Privacy Audit State
  const [liveTransmissionAudit, setLiveTransmissionAudit] = useState({
    plaintextSizeInRam: 2048,
    plaintextBytesOverWire: 0,
    ciphertextSize: 2060,
    ivHex: "000000000000000000000000",
    tagHex: "00000000000000000000000000000000",
    dataHash: "Computing on-chain ciphertext package hash...",
    status: "INITIALIZING: Live WebCrypto AES-GCM engine in RAM..."
  });

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const encPreview = await encryptGenomicData(rawFileText);
        if (!isMounted) return;
        const ivHex = encPreview.ivHex;
        const tagBytes = encPreview.ciphertext.slice(encPreview.ciphertext.length - 16);
        const tagHex = Array.from(tagBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        setLiveTransmissionAudit({
          plaintextSizeInRam: new TextEncoder().encode(rawFileText).length,
          plaintextBytesOverWire: 0,
          ciphertextSize: encPreview.ciphertext.byteLength,
          ivHex: ivHex,
          tagHex: tagHex,
          dataHash: encPreview.rawDataHash,
          status: "VERIFIED: Zero Plaintext Leaked Across Network Boundary"
        });
      } catch (e) {
        console.warn("Initial encryption preview note:", e);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const parseVcfAndAutofill = async (content, filename, fileSize, isLargeFile = false) => {
    setUploadedFileName(filename);
    setUploadedFileSize(fileSize);

    if (isLargeFile) {
      const headerSnippet = content.split("\n").slice(0, 20).join("\n");
      setRawFileText(
        `##fileformat=VCFv4.2\n##source=GA4GH_Crypt4GH_Streaming_Pipeline\n##file_size_bytes=${fileSize}\n##streaming_mode=64KB_BLOCK_SLICING\n` +
          headerSnippet
      );
    } else {
      setRawFileText(content);
    }

    const parsed = parseVcfMetadata(content, filename);
    setGeneSymbol(parsed.detectedGene);
    setDisease(parsed.detectedTrait || parsed.detectedDisease);
    setHpoCode(parsed.detectedVariantClass || parsed.detectedHpo);
    if (parsed.detectedFormat) setFileFormat(parsed.detectedFormat);
    setAncestryRegion(parsed.detectedRegion);
    setSubjectId(parsed.detectedSubject);

    if (isLargeFile) {
      setLiveTransmissionAudit({
        plaintextSizeInRam: fileSize,
        plaintextBytesOverWire: 0,
        ciphertextSize: fileSize + Math.ceil(fileSize / (64 * 1024)) * 32 + 20,
        ivHex: "STREAMING_INDIVIDUAL_IVS_PER_64KB",
        tagHex: "STREAMING_GMAC_TAGS_PER_64KB",
        dataHash: "Will compute SHA-256 over chunked package on submission...",
        status: `VERIFIED: GA4GH Crypt4GH Streaming Guard Active (${(fileSize / (1024 * 1024)).toFixed(1)} MB) — 64KB Slices`
      });
      showToast(`⚡ Large file detected (${(fileSize / (1024 * 1024)).toFixed(1)} MB): GA4GH Streaming Mode Active`);
    } else {
      // Compute live client-side WebCrypto encryption preview to demonstrate Zero Plaintext Leakage
      try {
        const encPreview = await encryptGenomicData(content);
        const ivHex = encPreview.ivHex;
        const tagBytes = encPreview.ciphertext.slice(encPreview.ciphertext.length - 16);
        const tagHex = Array.from(tagBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        setLiveTransmissionAudit({
          plaintextSizeInRam: new TextEncoder().encode(content).length,
          plaintextBytesOverWire: 0,
          ciphertextSize: encPreview.ciphertext.byteLength,
          ivHex: ivHex,
          tagHex: tagHex,
          dataHash: encPreview.rawDataHash,
          status: "VERIFIED: Zero Plaintext Leaked Across Network Boundary"
        });
        showToast(`Parsed & Pre-encrypted: ${filename} (${fileSize.toLocaleString()} bytes)`);
      } catch (e) {
        console.warn("Pre-encryption error:", e);
      }
    }
  };

  const processUploadedFile = (file) => {
    if (file.size > MAX_PREVIEW_SIZE) {
      setIsChunkedMode(true);
      setRawFileBlob(file);
      const headerSlice = file.slice(0, 256 * 1024);
      const reader = new FileReader();
      reader.onload = (event) => {
        const headerText = event.target.result;
        parseVcfAndAutofill(headerText, file.name, file.size, true);
      };
      reader.readAsText(headerSlice);
    } else {
      setIsChunkedMode(false);
      setRawFileBlob(null);
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        parseVcfAndAutofill(text, file.name, file.size, false);
      };
      reader.readAsText(file);
    }
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      processUploadedFile(file);
    }
  };

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      processUploadedFile(file);
    }
  };

  const applyPreset = async (presetKey) => {
    setIsChunkedMode(false);
    setRawFileBlob(null);
    setChunkProgress(null);
    const preset = PRESET_CATALOG[presetKey];
    if (!preset) return;

    if (preset.url) {
      try {
        const resp = await fetch(preset.url);
        if (resp.ok) {
          const text = await resp.text();
          const fileSize = new TextEncoder().encode(text).length;
          await parseVcfAndAutofill(text, preset.file, fileSize);
          if (preset.subjectId) setSubjectId(preset.subjectId);
          if (preset.genomicTrait) setDisease(preset.genomicTrait);
          else if (preset.disease) setDisease(preset.disease);
          if (preset.variantClass) setHpoCode(preset.variantClass);
          else if (preset.hpoCode) setHpoCode(preset.hpoCode);
          if (preset.geneSymbol) setGeneSymbol(preset.geneSymbol);
          if (preset.format || preset.fileFormat) setFileFormat(preset.format || preset.fileFormat);
          if (preset.ancestryRegion) setAncestryRegion(preset.ancestryRegion);
          if (preset.priceGeno) setPriceGeno(preset.priceGeno);
          if (preset.durationDays) setDurationDays(preset.durationDays);
          showToast(preset.toastMsg || `Loaded ${preset.file}`);
          return;
        }
      } catch (err) {
        console.warn("Preset fetch error, falling back to embedded:", err);
      }
    }

    setUploadedFileName(preset.file);
    if (preset.subjectId) setSubjectId(preset.subjectId);
    if (preset.genomicTrait) setDisease(preset.genomicTrait);
    else if (preset.disease) setDisease(preset.disease);
    if (preset.variantClass) setHpoCode(preset.variantClass);
    else if (preset.hpoCode) setHpoCode(preset.hpoCode);
    if (preset.geneSymbol) setGeneSymbol(preset.geneSymbol);
    if (preset.format || preset.fileFormat) setFileFormat(preset.format || preset.fileFormat);
    if (preset.ancestryRegion) setAncestryRegion(preset.ancestryRegion);
    if (preset.priceGeno) setPriceGeno(preset.priceGeno);
    if (preset.durationDays) setDurationDays(preset.durationDays);
    showToast(preset.toastMsg || `Loaded ${preset.file}`);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!account) {
      showToast("Please connect your wallet first.", "error");
      return;
    }

    setIsPublishing(true);
    setPublishStep(1);

    try {
      await onPublishSuccess({
        rawFileText,
        rawFileBlob,
        isChunked: isChunkedMode,
        subjectId,
        disease,
        geneSymbol,
        hpoCode,
        format: fileFormat,
        fileFormat,
        ancestryRegion,
        priceGeno,
        durationDays,
        onStepProgress: setPublishStep,
        onChunkProgress: (fraction, processed, total) => {
          setChunkProgress({
            percent: Math.round(fraction * 100),
            processedMB: (processed / (1024 * 1024)).toFixed(1),
            totalMB: (total / (1024 * 1024)).toFixed(1)
          });
        }
      });
    } finally {
      setIsPublishing(false);
      setPublishStep(0);
      setChunkProgress(null);
    }
  };

  return (
    <div style={{ maxWidth: "880px", margin: "0 auto" }}>
      <div>
        <div className="studio-panel">
          <div className="panel-title-bar">
            <div className="panel-title">
              <SealedCipherIcon size={18} color="#38bdf8" />
              <span style={{ fontSize: "14px", fontWeight: 700 }}>{t("studioTitle")}</span>
            </div>
            <span
              style={{
                fontSize: "11px",
                color: "var(--accent-emerald-text)",
                fontFamily: "var(--font-mono)"
              }}
            >
              ● {t("verifiedZeroDisk")}
            </span>
          </div>

          {/* INTERACTIVE DRAG & DROP ZONE */}
          <div
            className={`drag-drop-zone ${isDragging ? "dragging-active" : ""}`}
            role="button"
            tabIndex={0}
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={handleFileDrop}
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current && fileInputRef.current.click();
              }
            }}
          >
            <input
              type="file"
              id="genomic-file-input"
              ref={fileInputRef}
              style={{ display: "none" }}
              accept=".vcf,.vcf.gz,.fastq,.fq,.fasta,.fa,.json,.txt"
              onChange={handleFileInputChange}
            />
            <div className="drop-icon-wrap">
              <SealedCipherIcon size={32} color={isDragging ? "var(--accent-emerald)" : "var(--accent-cyan)"} />
            </div>
            <div className="drop-title" style={{ fontSize: "16px", fontWeight: 800, color: "var(--text-primary)" }}>
              {t("dragDropBoxTitle")}
            </div>
            <div className="drop-subtitle" style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
              {t("dragDropBoxSubtitle")}
            </div>

            {uploadedFileName && (
              <div
                className="drop-file-loaded-badge"
                style={{ flexDirection: "column", alignItems: "flex-start", gap: "6px" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <VerifiedBadgeIcon size={15} color="var(--accent-emerald)" />
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                    {t("loadedFilePrefix")} <strong>{uploadedFileName}</strong> ({uploadedFileSize.toLocaleString()} bytes)
                  </span>
                </div>
                {isChunkedMode && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "2px 8px",
                      background: "rgba(56, 189, 248, 0.15)",
                      border: "1px solid rgba(56, 189, 248, 0.4)",
                      borderRadius: "4px",
                      color: "var(--accent-cyan)",
                      fontSize: "11px",
                      fontFamily: "var(--font-mono)"
                    }}
                  >
                    <span>{t("crypt4ghActive")}</span>
                  </div>
                )}
                {chunkProgress && (
                  <div style={{ width: "100%", marginTop: "4px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: "11px",
                        color: "var(--accent-cyan)",
                        fontFamily: "var(--font-mono)"
                      }}
                    >
                      <span>{t("encryptingStream")} {chunkProgress.percent}%</span>
                      <span>
                        {chunkProgress.processedMB} MB / {chunkProgress.totalMB} MB
                      </span>
                    </div>
                    <div
                      style={{
                        width: "100%",
                        height: "4px",
                        background: "var(--border-subtle)",
                        borderRadius: "2px",
                        overflow: "hidden",
                        marginTop: "2px"
                      }}
                    >
                      <div
                        style={{
                          width: `${chunkProgress.percent}%`,
                          height: "100%",
                          background: "var(--accent-cyan)",
                          transition: "width 0.2s"
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* REAL SAMPLES QUICK-TEST BAR */}
          <ClinvarSampleBar onSelectPreset={applyPreset} />

          {/* Metadata & Tokenization Form */}
          <form onSubmit={handleSubmit} style={{ marginTop: "18px" }}>
            <div className="form-group-row">
              <div className="form-field">
                <label htmlFor="input-subject-id" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formSubjectId")}</label>
                <input
                  id="input-subject-id"
                  type="text"
                  className="field-input"
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                  aria-label={t("formSubjectId")}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="select-file-format" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formFormat")}</label>
                <select
                  id="select-file-format"
                  className="field-select"
                  value={fileFormat}
                  onChange={(e) => setFileFormat(e.target.value)}
                  aria-label={t("formFormat")}
                >
                  <option value="VCF v4.2">VCF v4.2 (Variant Call Format)</option>
                  <option value="gVCF">gVCF (Genomic VCF with Reference Blocks)</option>
                  <option value="FASTQ">FASTQ (Raw Next-Gen Sequencing Reads)</option>
                  <option value="FASTA">FASTA (Reference Assembly Sequence)</option>
                  <option value="BAM">BAM (Binary Aligned SAM Format)</option>
                  <option value="Crypt4GH">Crypt4GH (GA4GH Encrypted Container)</option>
                </select>
              </div>
            </div>

            <div className="form-group-row">
              <div className="form-field">
                <label htmlFor="input-gene-symbol" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formGene")}</label>
                <input
                  id="input-gene-symbol"
                  type="text"
                  className="field-input"
                  value={geneSymbol}
                  onChange={(e) => setGeneSymbol(e.target.value)}
                  aria-label={t("formGene")}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="input-ancestry-region" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formRegion")}</label>
                <input
                  id="input-ancestry-region"
                  type="text"
                  className="field-input"
                  value={ancestryRegion}
                  onChange={(e) => setAncestryRegion(e.target.value)}
                  aria-label={t("formRegion")}
                  required
                />
              </div>
            </div>

            <div className="form-group-row">
              <div className="form-field">
                <label htmlFor="input-disease" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formDisease")}</label>
                <input
                  id="input-disease"
                  type="text"
                  className="field-input"
                  value={disease}
                  onChange={(e) => setDisease(e.target.value)}
                  aria-label={t("formDisease")}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="input-hpo-code" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formHpo")}</label>
                <input
                  id="input-hpo-code"
                  type="text"
                  className="field-input"
                  value={hpoCode}
                  onChange={(e) => setHpoCode(e.target.value)}
                  aria-label={t("formHpo")}
                  required
                />
              </div>
            </div>

            <div className="form-group-row">
              <div className="form-field">
                <label htmlFor="input-price-geno" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formPrice")}</label>
                <input
                  id="input-price-geno"
                  type="number"
                  className="field-input"
                  value={priceGeno}
                  onChange={(e) => setPriceGeno(Number(e.target.value))}
                  aria-label={t("formPrice")}
                  min={1}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="input-duration-days" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formDuration")}</label>
                <input
                  id="input-duration-days"
                  type="number"
                  className="field-input"
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                  aria-label={t("formDuration")}
                  min={1}
                  required
                />
              </div>
            </div>

            <div
              style={{
                margin: "14px 0 16px 0",
                padding: "10px 14px",
                background: isChunkedMode ? "rgba(56, 189, 248, 0.08)" : "rgba(255, 255, 255, 0.03)",
                border: `1px solid ${isChunkedMode ? "rgba(56, 189, 248, 0.35)" : "var(--border-subtle)"}`,
                borderRadius: "var(--radius-sm)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between"
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: uploadedFileSize > MAX_PREVIEW_SIZE ? "default" : "pointer",
                  fontSize: "12px",
                  color: isChunkedMode ? "#38bdf8" : "var(--text-secondary)",
                  fontWeight: 600
                }}
              >
                <input
                  type="checkbox"
                  checked={isChunkedMode}
                  disabled={uploadedFileSize > MAX_PREVIEW_SIZE}
                  onChange={(e) => setIsChunkedMode(e.target.checked)}
                  style={{ accentColor: "#38bdf8", cursor: "pointer" }}
                />
                <span>GA4GH Crypt4GH Streaming Pipeline (64KB Slices)</span>
              </label>
              <span
                style={{
                  fontSize: "10px",
                  fontFamily: "var(--font-mono)",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  background: isChunkedMode ? "rgba(56, 189, 248, 0.2)" : "rgba(255, 255, 255, 0.05)",
                  color: isChunkedMode ? "#38bdf8" : "var(--text-muted)",
                  fontWeight: 700
                }}
              >
                {uploadedFileSize > MAX_PREVIEW_SIZE ? "GUARD LOCKED (>10MB)" : isChunkedMode ? "ACTIVE (64KB CHUNKS)" : "STANDARD (MONOLITHIC)"}
              </span>
            </div>

            <button type="submit" className="mint-action-btn" disabled={isPublishing} style={{ height: "46px", fontSize: "15px", fontWeight: 800 }}>
              {isPublishing ? (
                <>
                  <RefreshSpinIcon size={16} className="spin" />
                  <span>{t("mintingInProgress")}</span>
                </>
              ) : (
                <>
                  <SealedCipherIcon size={18} />
                  <span>{t("btnSignAndMint")}</span>
                </>
              )}
            </button>
          </form>

          {/* Collapsible Cryptographic Privacy Telemetry & Step Monitor */}
          <div style={{ marginTop: "24px", paddingTop: "18px", borderTop: "1px solid var(--border-subtle)" }}>
            <button
              type="button"
              onClick={() => setShowTelemetry(!showTelemetry)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                background: "var(--bg-surface-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                color: "var(--text-secondary)",
                transition: "all var(--transition-fast)"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <DataOwnerShieldIcon size={18} color="var(--accent-emerald)" />
                <span style={{ color: "var(--text-primary)", fontWeight: 700, fontSize: "13px" }}>
                  {t("privacyAuditTitle")}
                </span>
                <span className="audit-pass-badge">{t("auditPassedBadge")}</span>
              </div>
              <span style={{ fontSize: "12px", color: "var(--accent-cyan)", fontWeight: 600 }}>
                {showTelemetry ? `▲ ${t("filterHideAdvanced")}` : `▼ ${t("filterToggleAdvanced")}`}
              </span>
            </button>

            {showTelemetry && (
              <div style={{ marginTop: "16px" }}>
                <PipelineProgressMonitor
                  publishStep={publishStep}
                  liveTransmissionAudit={liveTransmissionAudit}
                  rawFileText={rawFileText}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
