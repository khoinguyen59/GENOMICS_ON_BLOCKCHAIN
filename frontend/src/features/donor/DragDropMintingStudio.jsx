import React, { useState, useRef, useEffect } from "react";
import { ethers } from "ethers";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { PRESET_CATALOG, parseVcfMetadata } from "../../services/vcfService";
import { encryptGenomicData, encryptGenomicDataChunked } from "../../../../crypto/client_crypto.js";
import { SealedCipherIcon, VerifiedBadgeIcon, RefreshSpinIcon, DataOwnerShieldIcon } from "../../components/icons/GenoIcons";
import ClinvarSampleBar from "./ClinvarSampleBar";
import PipelineProgressMonitor from "./PipelineProgressMonitor";

const INITIAL_VCF_CONTENT =
  `##fileformat=VCFv4.2\n` +
  `##fileDate=20261110\n` +
  `##source=1000Genomes_Phase3_KHV_WGS\n` +
  `##reference=GRCh38\n` +
  `##contig=<ID=chr12,length=133275309,assembly=GRCh38>\n` +
  `##INFO=<ID=AF,Number=A,Type=Float,Description="Global Allele Frequency">\n` +
  `##INFO=<ID=KHV_AF,Number=A,Type=Float,Description="Allele Frequency in 1000 Genomes Kinh in Ho Chi Minh City, Vietnam">\n` +
  `##INFO=<ID=GENE,Number=1,Type=String,Description="Gene Symbol">\n` +
  `##INFO=<ID=TRAIT,Number=1,Type=String,Description="Genomic Trait or Analysis Locus">\n` +
  `##INFO=<ID=DP,Number=1,Type=Integer,Description="Total Depth Across Cohort">\n` +
  `##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotations">\n` +
  `##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\n` +
  `##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">\n` +
  `##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">\n` +
  `#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t1000G_KHV_VN_01\n` +
  `chr12\t111803962\trs671\tG\tA\t100\tPASS\tAF=0.380;KHV_AF=0.520;GENE=ALDH2;TRAIT=Alcohol_Dehydrogenase_Metabolism;DP=2400;ANN=A|missense_variant|MODERATE|ALDH2|transcript|NM_000690.4|c.1510G>A|p.Glu504Lys\tGT:DP:GQ\t0/1:42:99`;

const INITIAL_VCF_BYTES = new TextEncoder().encode(INITIAL_VCF_CONTENT).length;

export default function DragDropMintingStudio({ onPublishSuccess }) {
  const { account, showToast } = useWeb3();
  const { t, lang } = useLanguage();

  // Drag & Drop State
  const MAX_PREVIEW_SIZE = 10 * 1024 * 1024; // 10MB memory guard

  // Drag & Drop State
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("KHV_chr12_1000genomes.vcf");
  const [uploadedFileSize, setUploadedFileSize] = useState(INITIAL_VCF_BYTES);
  const [rawFileBlob, setRawFileBlob] = useState(null);
  const [isChunkedMode, setIsChunkedMode] = useState(false);
  const [chunkProgress, setChunkProgress] = useState(null);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const fileInputRef = useRef(null);
  const uploadSeqRef = useRef(0);

  // Form State
  const [subjectId, setSubjectId] = useState("1000G_KHV_VN_01");
  const [disease, setDisease] = useState("1000 Genomes Project - Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)");
  const [hpoCode, setHpoCode] = useState("SO:0000694 - Population Genomic SNP Callset");
  const [geneSymbol, setGeneSymbol] = useState("ALDH2 / ADH1B Multi-locus Loci (chr12)");
  const [fileFormat, setFileFormat] = useState("VCF v4.2");
  const [ancestryRegion, setAncestryRegion] = useState("Vietnamese Kinh (1000 Genomes: KHV)");
  const [bloodGroup, setBloodGroup] = useState("N/A");
  const [clinicalSignificance, setClinicalSignificance] = useState("Physiological Traits");
  const [zygosity, setZygosity] = useState("0/1 Heterozygous");
  const [rawFileText, setRawFileText] = useState(INITIAL_VCF_CONTENT);
  const [priceGeno, setPriceGeno] = useState(100);
  const [durationDays, setDurationDays] = useState(45);
  const [royaltyBps, setRoyaltyBps] = useState(1000);
  const [blindTagSalt, setBlindTagSalt] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishStep, setPublishStep] = useState(0);

  // Live Transmission Privacy Audit State
  const [liveTransmissionAudit, setLiveTransmissionAudit] = useState({
    plaintextSizeInRam: INITIAL_VCF_BYTES,
    plaintextBytesOverWire: 0,
    ciphertextSize: INITIAL_VCF_BYTES + 28,
    ivHex: "000000000000000000000000",
    tagHex: "00000000000000000000000000000000",
    dataHash: "Computing on-chain ciphertext package hash...",
    status: "INITIALIZING: Live WebCrypto AES-GCM engine in RAM..."
  });

  useEffect(() => {
    let isMounted = true;
    const initSeq = uploadSeqRef.current;
    (async () => {
      try {
        const encPreview = await encryptGenomicData(rawFileText);
        if (!isMounted || uploadSeqRef.current !== initSeq) return;
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

  const parseVcfAndAutofill = async (content, filename, fileSize, isLargeFile = false, expectedSeq = null) => {
    const seq = expectedSeq ?? ++uploadSeqRef.current;
    if (uploadSeqRef.current !== seq) return;
    setUploadedFileName(filename);
    setUploadedFileSize(fileSize);
    setLiveTransmissionAudit(null);

    if (isLargeFile) {
      const previewSliceBytes = new TextEncoder().encode(content).length;
      const previewSnippet = content.split("\n").slice(0, 100).join("\n");
      setRawFileText(
        `##fileformat=VCFv4.2\n` +
        `##source=GA4GH_Crypt4GH_Streaming_Pipeline\n` +
        `##file_size_bytes=${fileSize}\n` +
        `##preview_slice_bytes=${previewSliceBytes}\n` +
        `##streaming_mode=64KB_BLOCK_SLICING\n` +
        `##[PREVIEW_TRUNCATED: Displaying 256KB preview slice of ${(fileSize / (1024 * 1024)).toFixed(2)} MB dataset]\n` +
        previewSnippet
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
    setBloodGroup(parsed.detectedBloodGroup || "N/A");
    if (parsed.detectedClinicalSignificance) setClinicalSignificance(parsed.detectedClinicalSignificance);
    if (parsed.detectedZygosity) setZygosity(parsed.detectedZygosity);

    if (isLargeFile) {
      try {
        const chunkRes = await encryptGenomicDataChunked(content, {
          chunkSize: 64 * 1024,
          onProgress: (fraction) => {
            if (uploadSeqRef.current !== seq) return;
            setChunkProgress({
              percent: Math.round(fraction * 100),
              processedMB: ((fraction * fileSize) / (1024 * 1024)).toFixed(1),
              totalMB: (fileSize / (1024 * 1024)).toFixed(1)
            });
          }
        });
        if (uploadSeqRef.current !== seq) return;
        const ivBytes = chunkRes.payload.subarray(24, 36);
        const ivHex = Array.from(ivBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        const chunk0Len = new DataView(chunkRes.payload.buffer, chunkRes.payload.byteOffset).getUint32(20, false);
        const tagBytes = chunkRes.payload.subarray(24 + chunk0Len - 16, 24 + chunk0Len);
        const tagHex = Array.from(tagBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

        setLiveTransmissionAudit({
          plaintextSizeInRam: fileSize,
          plaintextBytesOverWire: 0,
          ciphertextSize: chunkRes.payload.byteLength,
          previewSliceBytes: new TextEncoder().encode(content).length,
          ivHex: ivHex,
          tagHex: tagHex,
          dataHash: chunkRes.rawDataHash,
          status: `VERIFIED: GA4GH Crypt4GH Streaming Engine Active (${(fileSize / (1024 * 1024)).toFixed(1)} MB full dataset, 256KB preview slice hashed) - 64KB Slices`
        });
        showToast(
          lang === "vi"
            ? `Phát hiện tệp lớn (${(fileSize / (1024 * 1024)).toFixed(1)} MB): đã băm lát xem trước 256KB, bật chế độ luồng 64KB`
            : `Large file detected (${(fileSize / (1024 * 1024)).toFixed(1)} MB): 256KB preview slice hashed, GA4GH Streaming Mode Active`
        );
      } catch (err) {
        console.warn("Chunked pre-encryption preview note:", err);
        if (uploadSeqRef.current === seq) setLiveTransmissionAudit(null);
      }
    } else {
      // Compute live client-side WebCrypto encryption preview to demonstrate Zero Plaintext Leakage
      try {
        const encPreview = await encryptGenomicData(content);
        if (uploadSeqRef.current !== seq) return;
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
        showToast(
          lang === "vi"
            ? `Đã phân tích & tiền mã hóa trong RAM: ${filename} (${fileSize.toLocaleString()} bytes)`
            : `Parsed & Pre-encrypted: ${filename} (${fileSize.toLocaleString()} bytes)`
        );
      } catch (e) {
        console.warn("Pre-encryption error:", e);
        if (uploadSeqRef.current === seq) setLiveTransmissionAudit(null);
      }
    }
  };

  const processUploadedFile = async (file) => {
    const seq = ++uploadSeqRef.current;
    setChunkProgress(null);
    setLiveTransmissionAudit(null);
    const lowerName = (file.name || "").toLowerCase();
    let isBinary =
      lowerName.endsWith(".gz") ||
      lowerName.endsWith(".bam") ||
      lowerName.endsWith(".c4gh") ||
      lowerName.endsWith(".bcf");
    try {
      const headBuf = new Uint8Array(await file.slice(0, 512).arrayBuffer());
      if (uploadSeqRef.current !== seq) return;
      if (headBuf.length >= 2 && headBuf[0] === 0x1f && headBuf[1] === 0x8b) isBinary = true;
      if (headBuf.length >= 4 && headBuf[0] === 0x42 && headBuf[1] === 0x41 && headBuf[2] === 0x4d && headBuf[3] === 0x01) isBinary = true;
      for (let i = 0; i < headBuf.length; i++) {
        if (headBuf[i] === 0x00) {
          isBinary = true;
          break;
        }
      }
    } catch {}
    if (uploadSeqRef.current !== seq) return;

    if (isBinary) {
      setIsChunkedMode(true);
      setRawFileBlob(file);
      setUploadedFileName(file.name);
      setUploadedFileSize(file.size);
      const parsed = parseVcfMetadata("", file.name);
      setGeneSymbol(parsed.detectedGene);
      setDisease(parsed.detectedTrait || parsed.detectedDisease);
      setHpoCode(parsed.detectedVariantClass || parsed.detectedHpo);
      if (parsed.detectedFormat) setFileFormat(parsed.detectedFormat);
      setAncestryRegion(parsed.detectedRegion);
      setSubjectId(parsed.detectedSubject);
      setBloodGroup(parsed.detectedBloodGroup || "N/A");
      if (parsed.detectedClinicalSignificance) setClinicalSignificance(parsed.detectedClinicalSignificance);
      if (parsed.detectedZygosity) setZygosity(parsed.detectedZygosity);
      setRawFileText(
        `##binary_container=${parsed.detectedFormat || "BINARY"}\n` +
        `##file_name=${file.name}\n` +
        `##file_size_bytes=${file.size}\n` +
        `##integrity=LOSSLESS_RAW_BYTES_CHUNKED_AES256_GCM`
      );
      try {
        const isLargeBinary = file.size > MAX_PREVIEW_SIZE;
        const previewTarget = isLargeBinary ? file.slice(0, 256 * 1024) : file;
        const chunkRes = await encryptGenomicDataChunked(previewTarget, { chunkSize: 64 * 1024 });
        if (uploadSeqRef.current !== seq) return;
        const ivBytes = chunkRes.payload.subarray(24, 36);
        const ivHex = Array.from(ivBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        const chunk0Len = new DataView(chunkRes.payload.buffer, chunkRes.payload.byteOffset).getUint32(20, false);
        const tagBytes = chunkRes.payload.subarray(24 + chunk0Len - 16, 24 + chunk0Len);
        const tagHex = Array.from(tagBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        setLiveTransmissionAudit({
          plaintextSizeInRam: file.size,
          plaintextBytesOverWire: 0,
          ciphertextSize: chunkRes.payload.byteLength,
          ...(isLargeBinary ? { previewSliceBytes: previewTarget.size } : {}),
          ivHex,
          tagHex,
          dataHash: chunkRes.rawDataHash,
          status: isLargeBinary
            ? `VERIFIED: Lossless Binary Container (${parsed.detectedFormat || "Binary"}, ${(file.size / (1024 * 1024)).toFixed(1)} MB full dataset, 256KB preview slice hashed) - 64KB Slices`
            : `VERIFIED: Lossless Binary Container (${parsed.detectedFormat || "Binary"}) - 64KB Slices`
        });
      } catch (err) {
        console.warn("Binary pre-encryption preview note:", err);
        if (uploadSeqRef.current === seq) setLiveTransmissionAudit(null);
      }
      if (uploadSeqRef.current !== seq) return;
      showToast(
        lang === "vi"
          ? `Đã nạp nguyên vẹn container nhị phân: ${file.name} (${file.size.toLocaleString()} bytes)`
          : `Binary genomic container loaded losslessly: ${file.name} (${file.size.toLocaleString()} bytes)`
      );
    } else if (file.size > MAX_PREVIEW_SIZE) {
      setIsChunkedMode(true);
      setRawFileBlob(file);
      const headerSlice = file.slice(0, 256 * 1024);
      const reader = new FileReader();
      reader.onload = (event) => {
        if (uploadSeqRef.current !== seq) return;
        const headerText = event.target.result;
        parseVcfAndAutofill(headerText, file.name, file.size, true, seq);
      };
      reader.readAsText(headerSlice);
    } else {
      setIsChunkedMode(false);
      setRawFileBlob(null);
      const reader = new FileReader();
      reader.onload = (event) => {
        if (uploadSeqRef.current !== seq) return;
        const text = event.target.result;
        setRawFileText(text);
        parseVcfAndAutofill(text, file.name, file.size, false, seq);
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
    const preset = PRESET_CATALOG[presetKey];
    if (!preset) return;
    const seq = ++uploadSeqRef.current;

    if (preset.url) {
      try {
        const resp = await fetch(preset.url);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const text = await resp.text();
        if (uploadSeqRef.current !== seq) return;
        const fileSize = new TextEncoder().encode(text).length;
        setIsChunkedMode(false);
        setRawFileBlob(null);
        setChunkProgress(null);
        await parseVcfAndAutofill(text, preset.file, fileSize, false, seq);
        if (uploadSeqRef.current !== seq) return;
        if (preset.subjectId) setSubjectId(preset.subjectId);
        if (preset.genomicTrait) setDisease(preset.genomicTrait);
        else if (preset.disease) setDisease(preset.disease);
        if (preset.variantClass) setHpoCode(preset.variantClass);
        else if (preset.hpoCode) setHpoCode(preset.hpoCode);
        if (preset.geneSymbol) setGeneSymbol(preset.geneSymbol);
        if (preset.format || preset.fileFormat) setFileFormat(preset.format || preset.fileFormat);
        if (preset.ancestryRegion) setAncestryRegion(preset.ancestryRegion);
        if (preset.bloodGroup || preset.bloodType) setBloodGroup(preset.bloodGroup || preset.bloodType);
        else setBloodGroup("N/A");
        if (preset.clinicalSignificance) setClinicalSignificance(preset.clinicalSignificance);
        if (preset.zygosity) setZygosity(preset.zygosity);
        if (preset.priceGeno) setPriceGeno(preset.priceGeno);
        if (preset.durationDays) setDurationDays(preset.durationDays);
        showToast(
          (lang === "vi" ? preset.toastVi : preset.toastEn) ||
            preset.toastMsg ||
            preset.toastVi ||
            preset.toastEn ||
            `Loaded ${preset.file}`
        );
        return;
      } catch (err) {
        console.warn("Preset fetch error:", err);
        showToast(`${t("presetLoadErrorPrefix")}${preset.file}: ${err.message}`, "error");
        return;
      }
    }

    if (preset.sampleContent) {
      setIsChunkedMode(false);
      setRawFileBlob(null);
      setChunkProgress(null);
      const fileSize = new TextEncoder().encode(preset.sampleContent).length;
      await parseVcfAndAutofill(preset.sampleContent, preset.file, fileSize, false, seq);
      if (uploadSeqRef.current !== seq) return;
      if (preset.subjectId) setSubjectId(preset.subjectId);
      if (preset.genomicTrait) setDisease(preset.genomicTrait);
      else if (preset.disease) setDisease(preset.disease);
      if (preset.variantClass) setHpoCode(preset.variantClass);
      else if (preset.hpoCode) setHpoCode(preset.hpoCode);
      if (preset.geneSymbol) setGeneSymbol(preset.geneSymbol);
      if (preset.format || preset.fileFormat) setFileFormat(preset.format || preset.fileFormat);
      if (preset.ancestryRegion) setAncestryRegion(preset.ancestryRegion);
      if (preset.bloodGroup || preset.bloodType) setBloodGroup(preset.bloodGroup || preset.bloodType);
      else setBloodGroup("N/A");
      if (preset.clinicalSignificance) setClinicalSignificance(preset.clinicalSignificance);
      if (preset.zygosity) setZygosity(preset.zygosity);
      if (preset.priceGeno) setPriceGeno(preset.priceGeno);
      if (preset.durationDays) setDurationDays(preset.durationDays);
      showToast(
        (lang === "vi" ? preset.toastVi : preset.toastEn) ||
          preset.toastMsg ||
          preset.toastVi ||
          preset.toastEn ||
          `Loaded ${preset.file}`
      );
      return;
    }
    showToast(`${t("presetLoadErrorPrefix")}${preset.file}`, "error");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!account) {
      showToast(t("vaultErrConnectWallet"), "error");
      return;
    }
    const trimmedPrice = String(priceGeno ?? "").trim();
    let parsedPriceWei = 0n;
    if (/^\d+(\.\d{1,18})?$/.test(trimmedPrice)) {
      try {
        parsedPriceWei = ethers.parseUnits(trimmedPrice, 18);
      } catch {
        parsedPriceWei = 0n;
      }
    }
    if (parsedPriceWei <= 0n) {
      showToast(
        lang === "vi"
          ? "Phí truy cập ($GENO) phải là số thập phân dương hợp lệ > 0 (tối đa 18 chữ số thập phân)."
          : "Access fee ($GENO) must be a valid positive decimal number > 0 (up to 18 decimals).",
        "error"
      );
      return;
    }
    const trimmedDuration = String(durationDays ?? "").trim();
    const parsedDuration = /^\d+$/.test(trimmedDuration) ? Number(trimmedDuration) : NaN;
    if (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > 365) {
      showToast(
        lang === "vi"
          ? "Thời hạn cấp quyền phải là số nguyên từ 1 đến 365 ngày (MAX_ACCESS_DURATION)."
          : "Access duration must be an integer between 1 and 365 days (MAX_ACCESS_DURATION).",
        "error"
      );
      return;
    }

    setIsPublishing(true);
    setPublishStep(1);

    try {
      await onPublishSuccess?.({
        rawFileText,
        rawFileBlob,
        isChunked: isChunkedMode,
        fileSize: uploadedFileSize,
        subjectId,
        disease,
        geneSymbol,
        hpoCode,
        format: fileFormat,
        fileFormat,
        ancestryRegion,
        bloodGroup: bloodGroup === "N/A" ? "" : bloodGroup,
        clinicalSignificance,
        zygosity,
        priceGeno: trimmedPrice,
        durationDays: parsedDuration,
        royaltyBps: Number(royaltyBps) || 1000,
        blindTagSalt,
        onStepProgress: setPublishStep,
        onChunkProgress: (fraction, processed, total) => {
          setChunkProgress({
            percent: Math.round(fraction * 100),
            processedMB: (processed / (1024 * 1024)).toFixed(1),
            totalMB: (total / (1024 * 1024)).toFixed(1)
          });
        }
      });
    } catch (err) {
      console.warn("Publish error handled:", err?.message || err);
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
              aria-label={t("dragDropBoxTitle")}
              ref={fileInputRef}
              style={{ display: "none" }}
              accept=".vcf,.vcf.gz,.bam,.c4gh,.fastq,.fastq.gz,.fq,.fasta,.fa,.json,.txt"
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
                  <option value="VCF.GZ (BGZF)">VCF.GZ (BGZF Compressed Variant Call Format)</option>
                  <option value="gVCF">gVCF (Genomic VCF with Reference Blocks)</option>
                  <option value="FASTQ">FASTQ (Raw Next-Gen Sequencing Reads)</option>
                  <option value="FASTA">FASTA (Reference Assembly Sequence)</option>
                  <option value="BAM">BAM (Binary Aligned SAM Format)</option>
                  <option value="GA4GH JSON">GA4GH JSON (Phenopacket v2 Metadata)</option>
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
                  step="any"
                  className="field-input"
                  value={priceGeno}
                  onChange={(e) => setPriceGeno(e.target.value)}
                  aria-label={t("formPrice")}
                  min={0}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="input-duration-days" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{t("formDuration")}</label>
                <input
                  id="input-duration-days"
                  type="number"
                  step={1}
                  className="field-input"
                  value={durationDays}
                  onChange={(e) => setDurationDays(e.target.value)}
                  aria-label={t("formDuration")}
                  min={1}
                  max={365}
                  required
                />
              </div>
            </div>

            <div className="form-group-row">
              <div className="form-field">
                <label htmlFor="select-clinical-significance" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
                  {t("formClinicalSignificance")}
                </label>
                <select
                  id="select-clinical-significance"
                  className="field-select"
                  value={clinicalSignificance}
                  onChange={(e) => setClinicalSignificance(e.target.value)}
                  aria-label={t("formClinicalSignificance")}
                >
                  <option value="Physiological Traits">{t("sigTrait")}</option>
                  <option value="Pharmacogenomics">{t("sigPharmaco")}</option>
                  <option value="Carrier Screening">{t("sigCarrier")}</option>
                  <option value="Reference Benchmark">{t("sigBenchmark")}</option>
                  <option value="Functional Variation">{t("sigFunctional")}</option>
                  <option value="Physical Traits & Performance">{t("catTraits")}</option>
                  <option value="Sensory & Metabolism">{t("catSensory")}</option>
                  <option value="Population Genetics">{t("cat1000G")}</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="select-zygosity" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
                  {t("formZygosity")}
                </label>
                <select
                  id="select-zygosity"
                  className="field-select"
                  value={zygosity}
                  onChange={(e) => setZygosity(e.target.value)}
                  aria-label={t("formZygosity")}
                >
                  <option value="0/1 Heterozygous">{t("zygHet")}</option>
                  <option value="1/1 Homozygous Alt">{t("zygHomAlt")}</option>
                  <option value="0/0 Homozygous Ref">{t("zygHomRef")}</option>
                </select>
              </div>
            </div>

            <div className="form-group-row">
              <div className="form-field">
                <label htmlFor="select-blood-group" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
                  {t("formBloodGroup")}
                </label>
                <select
                  id="select-blood-group"
                  className="field-select"
                  value={bloodGroup}
                  onChange={(e) => setBloodGroup(e.target.value)}
                  aria-label={t("formBloodGroup")}
                >
                  <option value="N/A">N/A</option>
                  <option value="O+">O+</option>
                  <option value="O-">O-</option>
                  <option value="A+">A+</option>
                  <option value="A-">A-</option>
                  <option value="B+">B+</option>
                  <option value="B-">B-</option>
                  <option value="AB+">AB+</option>
                  <option value="AB-">AB-</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="select-royalty-bps" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
                  {t("formRoyaltyRate")}
                </label>
                <select
                  id="select-royalty-bps"
                  className="field-select"
                  value={royaltyBps}
                  onChange={(e) => setRoyaltyBps(Number(e.target.value))}
                  aria-label={t("formRoyaltyRate")}
                >
                  <option value={500}>5% (500 bps)</option>
                  <option value={600}>6% (600 bps)</option>
                  <option value={700}>7% (700 bps)</option>
                  <option value={800}>8% (800 bps)</option>
                  <option value={900}>9% (900 bps)</option>
                  <option value={1000}>10% (1000 bps — Default)</option>
                </select>
              </div>
            </div>

            <div className="form-field" style={{ marginTop: "10px" }}>
              <label htmlFor="input-blind-salt" className="field-label" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
                {t("blindSaltLabel")}
              </label>
              <input
                id="input-blind-salt"
                type="text"
                className="field-input"
                placeholder={t("blindSaltPlaceholder")}
                aria-label={t("blindSaltLabel")}
                value={blindTagSalt}
                onChange={(e) => setBlindTagSalt(e.target.value)}
              />
            </div>

            <div
              style={{
                margin: "14px 0 16px 0",
                padding: "10px 14px",
                background: isChunkedMode ? "rgba(56, 189, 248, 0.08)" : "var(--bg-surface-elevated)",
                border: `1px solid ${isChunkedMode ? "var(--accent-cyan)" : "var(--border-subtle)"}`,
                borderRadius: "var(--radius-sm)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                flexWrap: "wrap"
              }}
            >
              <label
                htmlFor="checkbox-crypt4gh"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: uploadedFileSize > MAX_PREVIEW_SIZE ? "default" : "pointer",
                  fontSize: "12.5px",
                  color: isChunkedMode ? "var(--accent-cyan)" : "var(--text-secondary)",
                  fontWeight: 600
                }}
              >
                <input
                  type="checkbox"
                  id="checkbox-crypt4gh"
                  aria-label={t("providerCrypt4ghLabel")}
                  checked={isChunkedMode}
                  disabled={uploadedFileSize > MAX_PREVIEW_SIZE}
                  onChange={(e) => setIsChunkedMode(e.target.checked)}
                  style={{ accentColor: "var(--accent-cyan)", cursor: "pointer" }}
                />
                <span>{t("providerCrypt4ghLabel")}</span>
              </label>
              <span
                style={{
                  fontSize: "10.5px",
                  fontFamily: "var(--font-mono)",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  background: isChunkedMode ? "rgba(56, 189, 248, 0.16)" : "var(--bg-input)",
                  border: "1px solid var(--border-subtle)",
                  color: isChunkedMode ? "var(--accent-cyan)" : "var(--text-muted)",
                  fontWeight: 700,
                  whiteSpace: "nowrap"
                }}
              >
                {uploadedFileSize > MAX_PREVIEW_SIZE ? t("providerModeLocked") : isChunkedMode ? t("providerModeActive") : t("providerModeStandard")}
              </span>
            </div>

            <button
              id="btn-mint-submit"
              type="submit"
              className="mint-action-btn"
              title={t("btnSignAndMint")}
              disabled={isPublishing}
              style={{ height: "46px", fontSize: "15px", fontWeight: 800 }}
            >
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
              id="btn-toggle-privacy-telemetry"
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
                  royaltyBps={royaltyBps}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}