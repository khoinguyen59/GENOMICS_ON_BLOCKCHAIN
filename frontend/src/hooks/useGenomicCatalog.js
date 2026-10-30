import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import seedMetadata from "../contracts/seedMetadata.json";
import { retrieveFromIpfs } from "../../../ipfs/pinata_uploader.js";
import { PRESET_CATALOG } from "../services/vcfService";

const PRESET_BY_DATA_ID = {
  1: PRESET_CATALOG.KHV_1000G, 2: PRESET_CATALOG.ACTN3_PERFORMANCE, 3: PRESET_CATALOG.ALDH2_METABOLISM,
  4: PRESET_CATALOG.LCT_LACTASE, 5: PRESET_CATALOG.CYP1A2_CAFFEINE, 6: PRESET_CATALOG.ABCC11_EARWAX,
  7: PRESET_CATALOG.NA12878_GIAB, 8: PRESET_CATALOG.HERC2_PIGMENTATION, 9: PRESET_CATALOG.TAS2R38_TASTE,
  10: PRESET_CATALOG.EDAR_MORPHOLOGY, 11: PRESET_CATALOG.WGS_FASTQ_READS, 12: PRESET_CATALOG.CHRM_MITOCHONDRIAL,
  13: PRESET_CATALOG.SAMTOOLS_REF_PANEL
};

export function buildInitialDatasetsFromSeed() {
  return (seedMetadata?.seeds || []).map((s) => {
    const dId = Number(s.dataId);
    const p = PRESET_BY_DATA_ID[dId] || PRESET_CATALOG.ACTN3_PERFORMANCE;
    const sig = s.clinicalSignificance || "Physical Traits & Performance";
    return {
      dataId: dId, tokenId: dId,
      owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", originalCreator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      disease: p?.titleVi || s.disease, titleVi: p?.titleVi || s.disease, titleEn: p?.titleEn || s.disease,
      traitVi: p?.traitVi || s.disease, traitEn: p?.traitEn || s.disease,
      category: p?.category || sig, categoryVi: p?.categoryVi || "Tính Trạng Thể Chất", categoryEn: p?.categoryEn || "Physical Traits",
      gene: p?.geneSymbol || s.gene, geneSymbol: s.geneSymbol === "KHV_1000G" ? "KHV-WGS" : s.geneSymbol || `GENO_${dId}`,
      chromosome: s.chromosome || "chr12", pos: s.pos || 111803962, rsId: s.rsId || "rs671",
      clinicalSignificance: sig, consequence: s.consequence || "missense_variant", zygosity: s.zygosity || "0/1 (Heterozygous)",
      assembly: s.assembly || "GRCh38", format: "VCF v4.2",
      platform: dId === 1 ? "1000 Genomes WGS" : dId === 7 ? "GATK Pipeline" : "Illumina NovaSeq",
      hpoTerm: p?.variantClass || s.hpoTerm || "SO:0000694", region: p?.ancestryRegion || s.region || "Global",
      ancestry: p?.ancestryRegion || s.ancestry || "Global", clinvarId: s.clinvarId || "dbSNP:rs671",
      price: Number(p?.priceGeno || 80), durationDays: Number(p?.durationDays || 30),
      accessCount: 0, accumulatedRoyalty: 0, royaltyBps: 1000, status: "Active", statusNum: 0,
      rawCid: s.rawCid, summaryCid: s.summaryCid, metadataCid: s.metadataCid,
      rawDataHash: s.rawDataHash, summaryDataHash: s.summaryDataHash,
      registeredAt: new Date().toLocaleDateString()
    };
  });
}

export function useGenomicCatalog({ account, getContracts }) {
  const [datasets, setDatasets] = useState(() => buildInitialDatasetsFromSeed());
  const [purchasedData, setPurchasedData] = useState([]);
  const [loadingChain, setLoadingChain] = useState(true);
  const [selectedAssetModal, setSelectedAssetModal] = useState(null);

  const fetchOnChainDatasets = useCallback(async (currentAccount) => {
    setLoadingChain(true);
    try {
      const contracts = await getContracts();
      if (!contracts) return;
      const items = await contracts.registry.getAllDataItems();
      const mapped = await Promise.all(items.map(async (raw) => {
        const dId = Number(raw.dataId), tId = Number(raw.tokenId), statusNum = Number(raw.status);
        const statusStr = statusNum === 0 ? "Active" : statusNum === 1 ? "Paused" : "Revoked";
        const priceFmt = Number(ethers.formatUnits(raw.price, 18)), durationDay = Number(raw.accessDuration) / 86400;
        const accessCount = Number(raw.accessCount || 0), dynamicOwner = raw.currentOwner;
        const seedMatch = seedMetadata?.seeds?.find((s) => s.dataId === dId);
        let ipfsMeta = null;
        if (!seedMatch && raw.metadataCid) {
          try {
            const bytes = await retrieveFromIpfs(raw.metadataCid);
            if (bytes?.length) ipfsMeta = JSON.parse(new TextDecoder().decode(bytes));
          } catch {}
        }
        let extractedSummaryHash = seedMatch?.summaryDataHash || null;
        if (!extractedSummaryHash && ipfsMeta?.files) {
          const sumFile = ipfsMeta.files.find((f) => f.fileAttributes?.fileFormat === "application/pdf" || (f.uri && f.uri.includes(raw.summaryCiphertextCid)));
          extractedSummaryHash = sumFile?.fileAttributes?.summaryDataHash || sumFile?.fileAttributes?.rawDataHash || null;
        }
        const phenoGene = ipfsMeta?.interpretations?.[0]?.diagnosis?.genomicInterpretations?.[0]?.variantInterpretation?.variationDescriptor?.geneContext?.symbol;
        const p = PRESET_BY_DATA_ID[dId] || PRESET_CATALOG.ACTN3_PERFORMANCE;
        const geneSym = seedMatch?.geneSymbol === "KHV_1000G" ? "KHV-WGS" : seedMatch?.geneSymbol || p?.geneSymbol?.split(" ")?.[0] || phenoGene || (dId === 1 ? "KHV-WGS" : `GENO_${dId}`);
        const chrom = seedMatch?.chromosome || (dId === 1 ? "chr12" : dId === 2 ? "chr11" : dId === 3 ? "chr12" : dId === 4 ? "chr2" : dId === 5 ? "chr15" : dId === 6 ? "chr16" : dId === 7 ? "chr20" : dId === 8 ? "chr15" : dId === 9 ? "chr7" : dId === 10 ? "chr2" : `chr${((dId % 22) + 1)}`);
        const sig = seedMatch?.clinicalSignificance || (dId === 1 ? "Population Genetics" : [2, 6, 8, 10].includes(dId) ? "Physical Traits & Performance" : [3, 4, 9].includes(dId) ? "Sensory & Metabolism" : dId === 5 ? "Pharmacogenomics" : "Reference Benchmark");
        const cons = seedMatch?.consequence || ([4, 5, 8].includes(dId) ? "regulatory_variant" : dId === 2 ? "stop_gained" : dId === 7 ? "synonymous_variant" : "missense_variant");
        const zyg = seedMatch?.zygosity || ([4, 6, 10].includes(dId) ? "1/1 (Homozygous Alt)" : "0/1 (Heterozygous)");
        const refAssembly = seedMatch?.assembly || (dId === 7 ? "GRCh37" : chrom === "chrM" ? "rCRS" : "GRCh38");
        const geneInfo = p?.geneSymbol || seedMatch?.gene || (phenoGene ? `${phenoGene} Molecular Locus` : `Target Locus: ${raw.rawCiphertextCid.substring(0, 8)}...`);
        const dataFormat = seedMatch?.format || (geneSym === "FASTQ" || geneInfo.includes("FASTQ") ? "FASTQ (Reads)" : geneSym === "FASTA" || geneInfo.includes("FASTA") || chrom === "chrM" ? "FASTA (Sequence)" : geneSym === "JSON" || geneInfo.includes("Phenopacket") ? "GA4GH JSON" : "VCF v4.2");
        const seqPlatform = seedMatch?.platform || (dId === 1 ? "1000 Genomes WGS" : dId === 7 ? "GATK Pipeline" : geneInfo.includes("SAMtools") ? "SAMtools Panel" : "Illumina NovaSeq");

        return {
          dataId: dId, tokenId: tId, owner: dynamicOwner, originalCreator: raw.currentOwner,
          disease: p?.titleVi || seedMatch?.disease || ipfsMeta?.diseases?.[0]?.term?.label || `Molecular Genomic Cohort #${dId}`,
          titleVi: p?.titleVi || seedMatch?.disease || `Mẫu Hệ Gen Phân Tử #${dId}`,
          titleEn: p?.titleEn || `Molecular Genomic Cohort #${dId}`,
          traitVi: p?.traitVi || seedMatch?.disease || `Đặc Tính Hệ Gen #${dId}`,
          traitEn: p?.traitEn || `Genomic Trait #${dId}`,
          category: p?.category || sig, categoryVi: p?.categoryVi || "Tính Trạng Thể Chất", categoryEn: p?.categoryEn || "Physical Traits",
          gene: geneInfo, geneSymbol: geneSym, chromosome: chrom, pos: seedMatch?.pos || 111803962,
          rsId: seedMatch?.rsId || (dId === 1 ? "rs671" : dId === 2 ? "rs1815739" : dId === 3 ? "rs671" : dId === 4 ? "rs4988235" : dId === 5 ? "rs762551" : dId === 6 ? "rs17822931" : dId === 7 ? "GIAB-NA12878" : dId === 8 ? "rs12913832" : dId === 9 ? "rs713598" : dId === 10 ? "rs3827760" : `rs${dId * 104729}`),
          clinicalSignificance: sig, consequence: cons, zygosity: zyg, assembly: refAssembly, format: dataFormat, platform: seqPlatform,
          hpoTerm: p?.variantClass || seedMatch?.hpoTerm || ipfsMeta?.phenotypicFeatures?.[0]?.type?.label || "SO:0000694 (Genomic Variant)",
          region: p?.ancestryRegion || seedMatch?.region || "Southeast Asian (Vietnamese)",
          ancestry: p?.ancestryRegion || seedMatch?.ancestry || ipfsMeta?.phenotypicFeatures?.find((f) => f.type?.id === "HANCESTRO:0009")?.type?.label || "Vietnamese Kinh (1000 Genomes: KHV)",
          clinvarId: seedMatch?.clinvarId || "dbSNP:rs671", price: priceFmt, durationDays: durationDay, accessCount,
          accumulatedRoyalty: priceFmt * accessCount * 0.1, royaltyBps: 1000, status: statusStr, statusNum,
          rawCid: raw.rawCiphertextCid, summaryCid: raw.summaryCiphertextCid, metadataCid: raw.metadataCid,
          rawDataHash: raw.rawDataHash, summaryDataHash: extractedSummaryHash,
          registeredAt: new Date(Number(raw.registeredAt) * 1000).toLocaleDateString()
        };
      }));
      setDatasets(mapped);

      if (currentAccount) {
        const accessChecks = await Promise.all(mapped.map(async (d) => {
          const isOwner = d.owner.toLowerCase() === currentAccount.toLowerCase();
          let hasAccess = false, grantData = null, escrowInfo = null;
          try {
            hasAccess = await contracts.registry.hasActiveAccess(d.dataId, currentAccount);
            if (hasAccess) grantData = await contracts.registry.accessGrants(d.dataId, currentAccount);
          } catch {}
          if (!isOwner) {
            try {
              const dep = await contracts.registry.escrowDeposits(d.dataId, currentAccount);
              if (dep && dep.amount > 0n) {
                const depTime = Number(dep.depositTime), disputeWin = Number(dep.disputeWindow), deadline = depTime + disputeWin;
                const canRefund = Math.floor(Date.now() / 1000) >= deadline && !dep.released && !dep.refunded;
                escrowInfo = {
                  amount: Number(ethers.formatUnits(dep.amount, 18)), depositTime: depTime, disputeWindow: disputeWin,
                  deadline, released: dep.released, refunded: dep.refunded, isPending: !dep.released && !dep.refunded, canRefund
                };
              }
            } catch {}
          }
          return { d, isOwner, hasAccess, grantData, escrowInfo };
        }));

        const purchasedList = [];
        for (const item of accessChecks) {
          const { d, isOwner, hasAccess, grantData, escrowInfo } = item;
          if (hasAccess || isOwner || escrowInfo?.isPending) {
            const isEscrowPending = Boolean(!isOwner && escrowInfo?.isPending);
            let expiryLabel = "Perpetual (Owner)";
            if (isEscrowPending) {
              expiryLabel = escrowInfo.canRefund ? "Escrow Expired (Refund Ready)" : "Escrow Pending Delivery";
            } else if (!isOwner && grantData?.expiresAt) {
              const remDays = Math.max(0, Math.ceil((Number(grantData.expiresAt) - Math.floor(Date.now() / 1000)) / 86400));
              expiryLabel = remDays > 0 ? `${remDays} days left` : "Expired";
            } else if (!isOwner) {
              expiryLabel = `${d.durationDays} days`;
            }
            purchasedList.push({
              ...d, purchasedAt: isOwner ? "Data Owner" : isEscrowPending ? "Escrow Active" : "Active",
              expiresAt: expiryLabel, escrowInfo, isEscrowPending, hasActiveAccess: hasAccess, isOwner,
              decryptedContent: null, decryptedPdfBytes: null, phenopacketJson: null
            });
          }
        }

        setPurchasedData((prev) => {
          const prevMap = new Map((prev || []).map((p) => [p.dataId, p]));
          return purchasedList.map((n) => {
            const p = prevMap.get(n.dataId);
            return p?.decryptedContent ? { ...n, decryptedContent: p.decryptedContent, decryptedPdfBytes: p.decryptedPdfBytes, phenopacketJson: p.phenopacketJson } : n;
          });
        });
      } else {
        setPurchasedData([]);
      }
    } catch (err) {
      console.warn("Dataset sync warning:", err.message);
    } finally {
      setLoadingChain(false);
    }
  }, [getContracts]);

  useEffect(() => { fetchOnChainDatasets(account); }, [fetchOnChainDatasets, account]);

  return {
    datasets, setDatasets,
    purchasedData, setPurchasedData,
    loadingChain, fetchOnChainDatasets,
    selectedAssetModal, setSelectedAssetModal
  };
}
