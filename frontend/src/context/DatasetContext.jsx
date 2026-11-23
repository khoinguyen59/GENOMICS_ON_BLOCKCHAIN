import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useWeb3 } from "./Web3Context";
import { useLanguage } from "./LanguageContext";
import { useGenomicCatalog } from "../hooks/useGenomicCatalog";
import { useGenomicFilters } from "../hooks/useGenomicFilters";
import { useDatasetDecryption } from "../hooks/useDatasetDecryption";

const DatasetContext = createContext(null);

export function DatasetProvider({ children }) {
  const { account, signer, contracts, getContracts, researcherKeyPair, showToast } = useWeb3();
  const { lang } = useLanguage();

  const catalog = useGenomicCatalog({ account, getContracts, lang });
  const filters = useGenomicFilters({ datasets: catalog.datasets });
  const decryption = useDatasetDecryption({
    datasets: catalog.datasets,
    setPurchasedData: catalog.setPurchasedData,
    account,
    signer,
    contracts,
    researcherKeyPair,
    showToast,
    lang
  });

  const { setPurchasedData } = catalog;
  const { handleClearDecryptedData } = decryption;

  // Memory Hygiene (VULN-04 / MED-02 Fixed): DatasetContext disconnect & wallet-switch memory clearance
  const prevAccountRef = useRef(account);
  useEffect(() => {
    const prevAddr = prevAccountRef.current ? prevAccountRef.current.toLowerCase() : "";
    const nextAddr = account ? account.toLowerCase() : "";
    if (!account) {
      handleClearDecryptedData();
      setPurchasedData([]);
    } else if (prevAddr !== nextAddr) {
      handleClearDecryptedData();
      setPurchasedData([]);
    }
    prevAccountRef.current = account;
  }, [account, handleClearDecryptedData, setPurchasedData]);

  const value = useMemo(
    () => ({
      // 1. Catalog & On-chain Data State
      datasets: catalog.datasets,
      setDatasets: catalog.setDatasets,
      catalogError: catalog.catalogError,
      purchasedData: catalog.purchasedData,
      setPurchasedData: catalog.setPurchasedData,
      loadingChain: catalog.loadingChain,
      fetchOnChainDatasets: catalog.fetchOnChainDatasets,
      selectedAssetModal: catalog.selectedAssetModal,
      setSelectedAssetModal: catalog.setSelectedAssetModal,
      confirmCapsuleAndReleaseEscrow: catalog.confirmCapsuleAndReleaseEscrow,
      disputeCapsule: catalog.disputeCapsule,
      setManualEscrowRelease: catalog.setManualEscrowRelease,
      releaseEscrow: catalog.releaseEscrow,
      claimDisputeTimeoutRefund: catalog.claimDisputeTimeoutRefund,

      // 2. 15-Tier Multi-Attribute Genomic Filters
      filterKeyword: filters.filterKeyword,
      setFilterKeyword: filters.setFilterKeyword,
      filterChromosome: filters.filterChromosome,
      setFilterChromosome: filters.setFilterChromosome,
      filterGene: filters.filterGene,
      setFilterGene: filters.setFilterGene,
      filterSignificance: filters.filterSignificance,
      setFilterSignificance: filters.setFilterSignificance,
      filterConsequence: filters.filterConsequence,
      setFilterConsequence: filters.setFilterConsequence,
      filterZygosity: filters.filterZygosity,
      setFilterZygosity: filters.setFilterZygosity,
      filterRegion: filters.filterRegion,
      setFilterRegion: filters.setFilterRegion,
      filterBloodType: filters.filterBloodType,
      setFilterBloodType: filters.setFilterBloodType,
      filterFormat: filters.filterFormat,
      setFilterFormat: filters.setFilterFormat,
      filterAssembly: filters.filterAssembly,
      setFilterAssembly: filters.setFilterAssembly,
      filterPlatform: filters.filterPlatform,
      setFilterPlatform: filters.setFilterPlatform,
      filterPriceTier: filters.filterPriceTier,
      setFilterPriceTier: filters.setFilterPriceTier,
      minPrice: filters.minPrice,
      setMinPrice: filters.setMinPrice,
      maxPrice: filters.maxPrice,
      setMaxPrice: filters.setMaxPrice,
      filterStatus: filters.filterStatus,
      setFilterStatus: filters.setFilterStatus,
      filterDuration: filters.filterDuration,
      setFilterDuration: filters.setFilterDuration,
      blindMatchIds: filters.blindMatchIds,
      setBlindMatchIds: filters.setBlindMatchIds,
      sortBy: filters.sortBy,
      setSortBy: filters.setSortBy,
      resetFilters: filters.resetFilters,
      filteredDatasets: filters.filteredDatasets,

      // 3. Bilingual Localization Helpers
      getLocalizedTitle: filters.getLocalizedTitle,
      getLocalizedTrait: filters.getLocalizedTrait,
      getLocalizedSignificance: filters.getLocalizedSignificance,
      getLocalizedConsequence: filters.getLocalizedConsequence,
      getLocalizedZygosity: filters.getLocalizedZygosity,

      // 4. Client-side Decryption & File Download Handlers
      decryptingDataId: decryption.decryptingDataId,
      decryptionProgress: decryption.decryptionProgress,
      handleDecryptData: decryption.handleDecryptData,
      handleDownloadFile: decryption.handleDownloadFile,
      handleDownloadPdf: decryption.handleDownloadPdf,
      handleClearDecryptedData: decryption.handleClearDecryptedData
    }),
    [catalog, filters, decryption]
  );

  return <DatasetContext.Provider value={value}>{children}</DatasetContext.Provider>;
}

export function useDatasets() {
  const context = useContext(DatasetContext);
  if (!context) {
    throw new Error("useDatasets must be used within a DatasetProvider");
  }
  return context;
}

export const useDataset = useDatasets;

export { DatasetContext };
export default DatasetContext;