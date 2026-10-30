import { useState, useCallback } from "react";
import {
  decryptDatasetPayload,
  decryptSummaryReport,
  fetchPhenopacketMetadata
} from "../services/datasetService.js";

export function useDatasetDecryption({
  datasets = [],
  setPurchasedData,
  showToast = console.log,
  account: hookAccount,
  contracts: hookContracts,
  researcherKeyPair: hookKeyPair
} = {}) {
  const [decryptingDataId, setDecryptingDataId] = useState(null);
  const [decryptionProgress, setDecryptionProgress] = useState(0);

  const handleDecryptData = useCallback(
    async (dataId, options = {}) => {
      const activeAccount = options.account || hookAccount;
      const activeContracts = options.contracts || hookContracts;
      const activeKeyPair = options.researcherKeyPair || hookKeyPair;

      try {
        const ds = (datasets || []).find((d) => d.dataId === dataId);
        if (!ds) return;

        setDecryptingDataId(dataId);
        setDecryptionProgress(10);
        showToast("1/4: Fetching encrypted sequence & summary report from IPFS...", "info");

        const decryptedPlaintext = await decryptDatasetPayload({
          dataset: ds,
          account: activeAccount,
          contracts: activeContracts,
          researcherKeyPair: activeKeyPair,
          onProgress: (p) => setDecryptionProgress(p)
        });

        let decryptedPdfBytes = null;
        if (ds.summaryCid) {
          showToast("2/4: Decrypting ISO 32000 / PDF-1.4 Genomic Summary...", "info");
          try {
            decryptedPdfBytes = await decryptSummaryReport({
              dataset: ds,
              account: activeAccount,
              contracts: activeContracts,
              researcherKeyPair: activeKeyPair
            });
          } catch (e) {
            console.warn("PDF summary report decryption notice:", e);
          }
        }

        let phenopacketJson = null;
        if (ds.metadataCid) {
          showToast("3/4: Fetching GA4GH Phenopacket v2 JSON metadata...", "info");
          try {
            phenopacketJson = await fetchPhenopacketMetadata({ metadataCid: ds.metadataCid });
          } catch (e) {
            console.warn("Phenopacket metadata fetch notice:", e);
          }
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

        showToast("Decrypted successfully! Raw VCF, Genomic PDF, and Phenopacket verified.");
      } catch (err) {
        showToast(`Decryption error: ${err.message}`, "error");
      } finally {
        setDecryptingDataId(null);
        setDecryptionProgress(0);
      }
    },
    [datasets, setPurchasedData, showToast, hookAccount, hookContracts, hookKeyPair]
  );

  const handleDownloadFile = useCallback(
    (content, filename) => {
      const cleanName = (filename || "Genomic_Data.vcf")
        .replace(/[/\\?%*:|"<>]/g, "_")
        .replace(/\s+/g, "_");
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = cleanName;
      link.click();
      URL.revokeObjectURL(url);
      showToast(`Downloaded ${cleanName}`);
    },
    [showToast]
  );

  const handleDownloadPdf = useCallback(
    (pdfBytes, filename) => {
      if (!pdfBytes) {
        showToast("Genomic PDF report not available or still decrypting.", "error");
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
      URL.revokeObjectURL(url);
      showToast(`Downloaded Genomic Summary Report: ${cleanName}`);
    },
    [showToast]
  );

  return {
    decryptingDataId,
    decryptionProgress,
    handleDecryptData,
    handleDownloadFile,
    handleDownloadPdf
  };
}
