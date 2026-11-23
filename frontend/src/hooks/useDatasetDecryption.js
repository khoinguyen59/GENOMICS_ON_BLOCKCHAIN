import { useState, useCallback, useRef } from "react";
import {
  decryptDatasetPayload,
  decryptSummaryReport,
  fetchPhenopacketMetadata
} from "../services/datasetService.js";

export function useDatasetDecryption({
  datasets = [],
  setPurchasedData,
  showToast = () => {},
  account: hookAccount,
  signer: hookSigner = null,
  contracts: hookContracts,
  researcherKeyPair: hookKeyPair,
  lang = "en"
} = {}) {
  const [decryptingDataId, setDecryptingDataId] = useState(null);
  const [decryptionProgress, setDecryptionProgress] = useState(0);
  const activeAccountRef = useRef(hookAccount);
  activeAccountRef.current = hookAccount;
  const decryptSeqRef = useRef(0);

  const handleDecryptData = useCallback(
    async (dataId, options = {}) => {
      const activeAccount = options.account || hookAccount;
      const activeContracts = options.contracts || hookContracts;
      const activeSigner = options.signer || hookSigner || activeContracts?.signer || null;
      const activeKeyPair = options.researcherKeyPair || hookKeyPair;
      const mySeq = ++decryptSeqRef.current;
      const isStale = () => {
        if (decryptSeqRef.current !== mySeq) return true;
        const currentAcct = activeAccountRef.current;
        if (activeAccount && currentAcct && activeAccount.toLowerCase() !== currentAcct.toLowerCase()) {
          return true;
        }
        if (activeAccount && !currentAcct) return true;
        return false;
      };

      try {
        const ds = (datasets || []).find((d) => d.dataId === dataId);
        if (!ds) return;

        setDecryptingDataId(dataId);
        setDecryptionProgress(10);
        showToast(
          lang === "vi"
            ? "1/4: Đang tải chuỗi gen mã hóa & báo cáo tóm tắt từ IPFS..."
            : "1/4: Fetching encrypted sequence & summary report from IPFS...",
          "info"
        );

        const decryptedPlaintext = await decryptDatasetPayload({
          dataset: ds,
          account: activeAccount,
          contracts: activeContracts,
          signer: activeSigner,
          researcherKeyPair: activeKeyPair,
          onProgress: (p) => {
            if (!isStale()) setDecryptionProgress(p);
          }
        });

        if (isStale()) {
          if (decryptedPlaintext instanceof Uint8Array) decryptedPlaintext.fill(0);
          return;
        }

        let decryptedPdfBytes = null;
        if (ds.summaryCid) {
          showToast(
            lang === "vi"
              ? "2/4: Đang giải mã báo cáo PDF-1.4 hệ gen..."
              : "2/4: Decrypting ISO 32000 / PDF-1.4 Genomic Summary...",
            "info"
          );
          try {
            decryptedPdfBytes = await decryptSummaryReport({
              dataset: ds,
              account: activeAccount,
              contracts: activeContracts,
              signer: activeSigner,
              researcherKeyPair: activeKeyPair
            });
          } catch (e) {
            if (isStale()) {
              if (decryptedPlaintext instanceof Uint8Array) decryptedPlaintext.fill(0);
              return;
            }
            if (/tamper|integrity|anchor|mismatch/i.test(e?.message || "")) {
              throw e;
            }
            console.warn("PDF summary report decryption warning:", e);
            showToast(
              lang === "vi" ? `Lỗi báo cáo PDF: ${e.message}` : `PDF summary report error: ${e.message}`,
              "error"
            );
          }
        }

        if (isStale()) {
          if (decryptedPlaintext instanceof Uint8Array) decryptedPlaintext.fill(0);
          if (decryptedPdfBytes instanceof Uint8Array) decryptedPdfBytes.fill(0);
          return;
        }

        let phenopacketJson = null;
        if (ds.metadataCid) {
          showToast(
            lang === "vi"
              ? "3/4: Đang tải và đối soát siêu dữ liệu GA4GH Phenopacket v2..."
              : "3/4: Fetching GA4GH Phenopacket v2 JSON metadata...",
            "info"
          );
          try {
            phenopacketJson = await fetchPhenopacketMetadata({
              metadataCid: ds.metadataCid,
              expectedMetadataHash: ds.metadataHash
            });
          } catch (e) {
            if (isStale()) {
              if (decryptedPlaintext instanceof Uint8Array) decryptedPlaintext.fill(0);
              if (decryptedPdfBytes instanceof Uint8Array) decryptedPdfBytes.fill(0);
              return;
            }
            if (/tamper|integrity|anchor|mismatch/i.test(e?.message || "")) {
              throw e;
            }
            console.warn("Phenopacket metadata fetch warning:", e);
            showToast(
              lang === "vi" ? `Lỗi siêu dữ liệu Phenopacket: ${e.message}` : `Phenopacket metadata error: ${e.message}`,
              "error"
            );
          }
        }

        if (isStale()) {
          if (decryptedPlaintext instanceof Uint8Array) decryptedPlaintext.fill(0);
          if (decryptedPdfBytes instanceof Uint8Array) decryptedPdfBytes.fill(0);
          return;
        }

        if (setPurchasedData) {
          setPurchasedData((prev) =>
            (prev || []).map((p) =>
              p.dataId === dataId
                ? {
                    ...p,
                    decryptedContent: decryptedPlaintext,
                    decryptedPdfBytes: decryptedPdfBytes,
                    phenopacketJson: phenopacketJson
                  }
                : p
            )
          );
        }

        const verifiedParts = [lang === "vi" ? "Chuỗi gốc" : "Raw Sequence"];
        if (decryptedPdfBytes) verifiedParts.push("PDF");
        if (phenopacketJson) verifiedParts.push("Phenopacket");
        showToast(
          lang === "vi"
            ? `Đã giải mã & đối soát khớp SHA-256 (${verifiedParts.join(", ")}).`
            : `Decrypted & SHA-256 verified (${verifiedParts.join(", ")}).`
        );
      } catch (err) {
        if (!isStale()) {
          showToast((lang === "vi" ? "Lỗi giải mã: " : "Decryption error: ") + err.message, "error");
        }
      } finally {
        if (decryptSeqRef.current === mySeq) {
          setDecryptingDataId(null);
          setDecryptionProgress(0);
        }
      }
    },
    [datasets, setPurchasedData, showToast, hookAccount, hookSigner, hookContracts, hookKeyPair, lang]
  );

  const handleDownloadFile = useCallback(
    (content, filename, explicitMime = null) => {
      const cleanName = (filename || "Genomic_Data.vcf")
        .replace(/[/\\?%*:|"<>]/g, "_")
        .replace(/\s+/g, "_");
      const isBin = content instanceof Uint8Array || content instanceof ArrayBuffer;
      const bytes = content instanceof Uint8Array ? content : isBin ? new Uint8Array(content) : null;
      const isGzip = Boolean(bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b);
      const mimeType =
        explicitMime ||
        (isGzip
          ? "application/gzip"
          : isBin
          ? "application/octet-stream"
          : "text/plain;charset=utf-8");
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = cleanName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(lang === "vi" ? `Đã tải tệp ${cleanName}` : `Downloaded ${cleanName}`);
    },
    [showToast, lang]
  );

  const handleDownloadPdf = useCallback(
    (pdfBytes, filename) => {
      if (!pdfBytes) {
        showToast(
          lang === "vi"
            ? "Báo cáo PDF hệ gen chưa sẵn sàng hoặc đang giải mã."
            : "Genomic PDF report not available or still decrypting.",
          "error"
        );
        return;
      }
      const cleanName = (filename || "Genomic_Report.pdf")
        .replace(/[/\\?%*:|"<>]/g, "_")
        .replace(/\s+/g, "_");
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = cleanName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(
        lang === "vi"
          ? `Đã tải Báo Cáo Tóm Tắt Hệ Gen: ${cleanName}`
          : `Downloaded Genomic Summary Report: ${cleanName}`
      );
    },
    [showToast, lang]
  );

  const handleClearDecryptedData = useCallback(
    (dataId = null) => {
      if (dataId === null) {
        decryptSeqRef.current += 1;
        setDecryptingDataId(null);
        setDecryptionProgress(0);
      }
      if (!setPurchasedData) return;
      setPurchasedData((prev) =>
        (prev || []).map((p) => {
          if (dataId === null || p.dataId === dataId) {
            return {
              ...p,
              decryptedContent: null,
              decryptedPdfBytes: null,
              phenopacketJson: null
            };
          }
          return p;
        })
      );
    },
    [setPurchasedData]
  );

  return {
    decryptingDataId,
    decryptionProgress,
    handleDecryptData,
    handleDownloadFile,
    handleDownloadPdf,
    handleClearDecryptedData
  };
}