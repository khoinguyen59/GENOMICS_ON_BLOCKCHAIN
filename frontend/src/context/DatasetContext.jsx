import React, { createContext, useContext, useEffect, useMemo } from "react";
import { useWeb3 } from "./Web3Context";
import { useGenomicCatalog } from "../hooks/useGenomicCatalog";
import { useGenomicFilters } from "../hooks/useGenomicFilters";
import { useDatasetDecryption } from "../hooks/useDatasetDecryption";

const DatasetContext = createContext(null);

export function DatasetProvider({ children }) {
  const { account, contracts, getContracts, researcherKeyPair } = useWeb3();

  const catalog = useGenomicCatalog({ account, getContracts });
  const filters = useGenomicFilters({ datasets: catalog.datasets });
  const decryption = useDatasetDecryption({
    datasets: catalog.datasets,
    setPurchasedData: catalog.setPurchasedData,
    account,
    contracts,
    researcherKeyPair
  });

  const { setPurchasedData } = catalog;

  // Memory Hygiene (VULN-04 Fixed): DatasetContext disconnect memory clearance
  useEffect(() => {
    if (!account) {
      setPurchasedData([]);
    } else {
      // Active account connected; catalog handles on-chain synchronization
    }
  }, [account, setPurchasedData]);

  const value = useMemo(
    () => ({
      // 1. Catalog & On-chain Data State
      datasets: catalog.datasets,
      setDatasets: catalog.setDatasets,
      purchasedData: catalog.purchasedData,
      setPurchasedData: catalog.setPurchasedData,
      loadingChain: catalog.loadingChain,
      fetchOnChainDatasets: catalog.fetchOnChainDatasets,
      selectedAssetModal: catalog.selectedAssetModal,
      setSelectedAssetModal: catalog.setSelectedAssetModal,

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
      handleDownloadPdf: decryption.handleDownloadPdf
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
