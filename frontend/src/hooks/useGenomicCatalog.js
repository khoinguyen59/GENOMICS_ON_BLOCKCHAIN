import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ethers } from "ethers";
import seedMetadata from "../contracts/seedMetadata.json";
import contractAddresses from "../contracts/contractAddresses.json";
import GenomicsRegistryABI from "../contracts/GenomicsRegistryABI.json";
import { retrieveFromIpfs, evictLocalIpfsContent, verifySummaryCidIntegrity } from "../../../ipfs/pinata_uploader.js";
import { PRESET_CATALOG } from "../services/vcfService";
import { queryFilterChunked, getDeploymentStartBlock } from "../services/datasetService";
import { sanitizeMetadataTree, executeSerializedTx, runWithConcurrency } from "../utils/asyncResilience";

const KNOWN_GENE_CHROM = {
  ALDH2: "chr12",
  ADH1B: "chr4",
  ACTN3: "chr11",
  HERC2: "chr15",
  OCA2: "chr15",
  TAS2R38: "chr7",
  EDAR: "chr2",
  LCT: "chr2",
  MCM6: "chr2",
  CYP1A2: "chr15",
  ABCC11: "chr16",
  NA12878: "chr20",
  CHRM: "chrM",
};

function extractCleanGeneSymbol(seedMatch, preset, rawPhenoGene) {
  if (seedMatch?.geneSymbol) {
    return seedMatch.geneSymbol === "KHV_1000G" ? "KHV-WGS" : seedMatch.geneSymbol;
  }
  if (preset?.geneSymbol) {
    return preset.geneSymbol.split(/[\s(/,:]/)[0];
  }
  if (rawPhenoGene && typeof rawPhenoGene === "string") {
    const cleaned = rawPhenoGene.replace(/^var-/i, "").trim();
    const sym = cleaned.split(/[\s(/,:]/)[0];
    if (sym) return sym;
  }
  return "UNSPECIFIED";
}

function extractCleanChromosome(seedMatch, ipfsMeta, geneSym, geneInfo, dId, hasPreset) {
  if (seedMatch?.chromosome) return seedMatch.chromosome;
  const vd = ipfsMeta?.interpretations?.[0]?.diagnosis?.genomicInterpretations?.[0]?.variantInterpretation?.variationDescriptor;
  const vcfChrom = vd?.vcfRecord?.chrom || vd?.chromosome;
  if (vcfChrom && String(vcfChrom).trim() && String(vcfChrom).toUpperCase() !== "UNSPECIFIED") {
    return String(vcfChrom).trim();
  }
  const combined = `${geneSym || ""} ${geneInfo || ""} ${ipfsMeta?.diseases?.[0]?.term?.label || ""} ${vd?.id || ""}`;
  const chromMatch = combined.match(/\b(chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M|MT))\b/i);
  if (chromMatch) {
    return chromMatch[1].toLowerCase() === "chrmt" ? "chrM" : chromMatch[1].toLowerCase().replace(/^chrm$/i, "chrM");
  }
  const upperSym = String(geneSym || "").toUpperCase();
  if (KNOWN_GENE_CHROM[upperSym]) return KNOWN_GENE_CHROM[upperSym];
  if (hasPreset) {
    return dId === 1 ? "chr12" : dId === 2 ? "chr11" : dId === 3 ? "chr12" : dId === 4 ? "chr2" : dId === 5 ? "chr15" : dId === 6 ? "chr16" : dId === 7 ? "chr20" : dId === 8 ? "chr15" : dId === 9 ? "chr7" : "chr2";
  }
  return "UNSPECIFIED";
}

function extractCleanRsId(seedMatch, ipfsMeta, geneInfo, dId, hasPreset) {
  if (seedMatch?.rsId) return seedMatch.rsId;
  const vd = ipfsMeta?.interpretations?.[0]?.diagnosis?.genomicInterpretations?.[0]?.variantInterpretation?.variationDescriptor;
  const rawId = String(vd?.id || "").trim();
  const vcfId = String(vd?.vcfRecord?.id || "").trim();
  const rsFromVcf = vcfId.match(/\b(rs\d+)\b/i);
  if (rsFromVcf) return rsFromVcf[1];
  const rsFromVar = rawId.match(/\b(rs\d+)\b/i);
  if (rsFromVar) return rsFromVar[1];
  const rsFromGene = String(geneInfo || "").match(/\b(rs\d+)\b/i);
  if (rsFromGene) return rsFromGene[1];
  if (rawId && !/^var-/i.test(rawId)) return rawId;
  if (hasPreset) {
    return dId === 1 ? "rs671" : dId === 2 ? "rs1815739" : dId === 3 ? "rs671" : dId === 4 ? "rs4988235" : dId === 5 ? "rs762551" : dId === 6 ? "rs17822931" : dId === 7 ? "GIAB-NA12878" : dId === 8 ? "rs12913832" : dId === 9 ? "rs713598" : "rs3827760";
  }
  return "N/A";
}

const sanitizeMetaTree = sanitizeMetadataTree;

function extractPhenopacketBloodGroup(ipfsMeta) {
  if (!ipfsMeta || typeof ipfsMeta !== "object") return "";
  if (Array.isArray(ipfsMeta.measurements)) {
    const abo = ipfsMeta.measurements.find((m) => m?.assay?.id === "LOINC:882-1");
    const label = abo?.value?.ontologyClass?.label || abo?.value?.quantity?.value;
    if (label && String(label).trim()) return String(label).trim();
  }
  return ipfsMeta?.subject?.bloodGroup || ipfsMeta?.bloodType || "";
}

const PRESET_BY_DATA_ID = {
  1: PRESET_CATALOG.KHV_1000G, 2: PRESET_CATALOG.ACTN3_PERFORMANCE, 3: PRESET_CATALOG.ALDH2_METABOLISM,
  4: PRESET_CATALOG.LCT_LACTASE, 5: PRESET_CATALOG.CYP1A2_CAFFEINE, 6: PRESET_CATALOG.ABCC11_EARWAX,
  7: PRESET_CATALOG.NA12878_GIAB, 8: PRESET_CATALOG.HERC2_PIGMENTATION, 9: PRESET_CATALOG.TAS2R38_TASTE,
  10: PRESET_CATALOG.EDAR_MORPHOLOGY, 11: PRESET_CATALOG.WGS_FASTQ_READS, 12: PRESET_CATALOG.CHRM_MITOCHONDRIAL,
  13: PRESET_CATALOG.SAMTOOLS_REF_PANEL
};

export function useGenomicCatalog({ account, getContracts, lang }) {
  const [rawDatasets, setRawDatasets] = useState([]);
  const [catalogError, setCatalogError] = useState(null);
  const [rawPurchasedData, setRawPurchasedData] = useState([]);
  const [loadingChain, setLoadingChain] = useState(true);
  const [selectedAssetModal, setSelectedAssetModal] = useState(null);
  const fetchSeqRef = useRef(0);
  const latestAccountRef = useRef(account);
  latestAccountRef.current = account;
  const committedDecryptedBuffersRef = useRef(new Set());

  // Deterministic post-commit zeroing of any dropped decrypted Uint8Array buffers (immune to React 18 MessageChannel batching)
  useEffect(() => {
    const retained = new Set();
    for (const p of rawPurchasedData || []) {
      if (p?.decryptedContent instanceof Uint8Array) retained.add(p.decryptedContent);
      if (p?.decryptedPdfBytes instanceof Uint8Array) retained.add(p.decryptedPdfBytes);
    }
    for (const buf of committedDecryptedBuffersRef.current) {
      if (!retained.has(buf)) {
        buf.fill(0);
      }
    }
    committedDecryptedBuffersRef.current = retained;
  }, [rawPurchasedData]);

  useEffect(() => {
    return () => {
      for (const buf of committedDecryptedBuffersRef.current) {
        buf.fill(0);
      }
      committedDecryptedBuffersRef.current.clear();
    };
  }, []);

  const activeLang =
    lang === "en" || lang === "vi"
      ? lang
      : typeof window !== "undefined" && window.localStorage
        ? window.localStorage.getItem("geno_lang") || "vi"
        : "vi";

  const datasets = useMemo(
    () =>
      (rawDatasets || []).map((d) => ({
        ...d,
        registeredAt: d.rawRegisteredAtSec
          ? new Date(d.rawRegisteredAtSec * 1000).toLocaleDateString(activeLang === "vi" ? "vi-VN" : "en-US")
          : d.registeredAt || "",
      })),
    [rawDatasets, activeLang]
  );

  const activeAccountLower = account ? account.toLowerCase() : "";
  const purchasedData = useMemo(
    () =>
      (rawPurchasedData || [])
        .filter((p) => activeAccountLower && (!p.accountAddr || p.accountAddr === activeAccountLower))
        .map((p) => {
        const isOwner = Boolean(p.isOwner);
        const isEscrowPending = Boolean(p.isEscrowPending);
        const escrowInfo = p.escrowInfo;
        let expiryLabel = activeLang === "vi" ? "Vĩnh viễn (Chủ sở hữu)" : "Perpetual (Owner)";
        if (isEscrowPending && escrowInfo) {
          if (escrowInfo.isDisputed) {
            expiryLabel = activeLang === "vi" ? "Ký quỹ đang khiếu nại (Chờ Admin)" : "Escrow Disputed (Admin Review)";
          } else if (escrowInfo.capsuleDelivered) {
            expiryLabel = activeLang === "vi" ? "Khóa đã giao (Chờ xác nhận)" : "Capsule Delivered (Pending Release)";
          } else if (escrowInfo.canRefund) {
            expiryLabel = activeLang === "vi" ? "Hết hạn ký quỹ (Sẵn sàng hoàn tiền)" : "Escrow Expired (Refund Ready)";
          } else {
            expiryLabel = activeLang === "vi" ? "Ký quỹ chờ bàn giao" : "Escrow Pending Delivery";
          }
        } else if (!isOwner && p.grantExpiresAtSec) {
          const remDays = Math.max(0, Math.ceil((Number(p.grantExpiresAtSec) - Number(p.chainNowSec || Math.floor(Date.now() / 1000))) / 86400));
          expiryLabel =
            remDays > 0
              ? activeLang === "vi" ? `${remDays} ngày còn lại` : `${remDays} days left`
              : activeLang === "vi" ? "Hết hạn" : "Expired";
        } else if (!isOwner) {
          expiryLabel = activeLang === "vi" ? `${p.durationDays} ngày` : `${p.durationDays} days`;
        }
        return {
          ...p,
          registeredAt: p.rawRegisteredAtSec
            ? new Date(p.rawRegisteredAtSec * 1000).toLocaleDateString(activeLang === "vi" ? "vi-VN" : "en-US")
            : p.registeredAt || "",
          purchasedAt: isOwner
            ? activeLang === "vi" ? "Chủ Dữ Liệu" : "Data Owner"
            : isEscrowPending
              ? activeLang === "vi" ? "Ký Quỹ Đang Bật" : "Escrow Active"
              : activeLang === "vi" ? "Đang Hoạt Động" : "Active",
          expiresAt: expiryLabel,
          expiryLabel,
        };
      }),
    [rawPurchasedData, activeLang, activeAccountLower]
  );

  const fetchOnChainDatasets = useCallback(async (currentAccount) => {
    const requestedAccount = currentAccount !== undefined ? currentAccount : latestAccountRef.current;
    // Drop stale refreshes triggered for a previously connected wallet after an account switch
    if (
      currentAccount !== undefined &&
      requestedAccount &&
      latestAccountRef.current &&
      requestedAccount.toLowerCase() !== latestAccountRef.current.toLowerCase()
    ) {
      return;
    }
    const mySeq = ++fetchSeqRef.current;
    setLoadingChain(true);
    setCatalogError(null);
    try {
      const contracts = await getContracts();
      if (!contracts || fetchSeqRef.current !== mySeq) return;
      const activeProvider = contracts.registry.runner?.provider || contracts.registry.runner;
      let chainNowSec = Math.floor(Date.now() / 1000);
      try {
        const latestBlock = await activeProvider?.getBlock?.("latest");
        if (latestBlock?.timestamp !== undefined && latestBlock?.timestamp !== null) {
          chainNowSec = Number(latestBlock.timestamp);
        }
      } catch {}
      // Query exact on-chain EIP-2981 RoyaltyPaid events once per sync for truthful royalty accounting
      const royaltyWeiByDataId = new Map();
      try {
        if (contracts.registry?.filters?.RoyaltyPaid) {
          const royaltyEvents = await queryFilterChunked(
            contracts.registry,
            contracts.registry.filters.RoyaltyPaid(),
            getDeploymentStartBlock(),
            "latest"
          );
          for (const ev of royaltyEvents) {
            const idNum = Number(ev.args?.dataId ?? ev.args?.[0] ?? 0);
            const amtWei = BigInt(ev.args?.amount ?? ev.args?.[2] ?? 0n);
            if (idNum > 0 && amtWei > 0n) {
              royaltyWeiByDataId.set(idNum, (royaltyWeiByDataId.get(idNum) || 0n) + amtWei);
            }
          }
        }
      } catch {}
      if (fetchSeqRef.current !== mySeq) return;
      let items;
      if (typeof contracts.registry.getDataItemsPaginated === "function") {
        const pageSize = 100;
        const collected = [];
        let offset = 0;
        let total = Infinity;
        while (offset < total) {
          const [pageItems, totalCount] = await contracts.registry.getDataItemsPaginated(offset, pageSize);
          total = Number(totalCount || 0n);
          if (!pageItems || pageItems.length === 0) break;
          collected.push(...pageItems);
          offset += pageItems.length;
        }
        items = collected;
      } else {
        items = await contracts.registry.getAllDataItems();
      }
      const mapped = await runWithConcurrency(items, async (raw) => {
        const dId = Number(raw.dataId), tId = Number(raw.tokenId), statusNum = Number(raw.status);
        const statusStr = statusNum === 0 ? "Active" : statusNum === 1 ? "Paused" : "Revoked";
        const priceWeiStr = raw.price.toString();
        const priceFormatted = ethers.formatUnits(raw.price, 18);
        const priceFmt = Number(priceFormatted), durationDay = Number(raw.accessDuration) / 86400;
        const accessCount = Number(raw.accessCount || 0), dynamicOwner = raw.currentOwner;
        const seedMatch = seedMetadata?.seeds?.find(
          (s) =>
            s.rawDataHash &&
            String(s.rawDataHash).toLowerCase() === String(raw.rawDataHash || "").toLowerCase() &&
            s.metadataCid === raw.metadataCid
        );
        const p = seedMatch ? (PRESET_BY_DATA_ID[Number(seedMatch.dataId)] || null) : null;
        let originalCreator = dynamicOwner;
        let royaltyBps = 1000;
        let onChainSummaryHash = null;
        let onChainMetadataHash = null;
        let reuseCount = 0;
        let blindTagCount = 0;
        let reuseFeeGeno = 0;
        try {
          const [nftRec, royaltyInfoRes, artifactHashes, rawReuseCnt, rawTagCnt, rawReuseFee] = await Promise.all([
            contracts.nft.getGenomicRecord(tId).catch(() => null),
            contracts.nft.royaltyInfo(tId, 10000n).catch(() => null),
            contracts.registry.getArtifactHashes(dId).catch(() => null),
            contracts.registry.datasetReuseCount(dId).catch(() => 0n),
            contracts.registry.datasetBlindTagCount(dId).catch(() => 0n),
            contracts.registry.quoteReuseFee(dId).catch(() => 0n)
          ]);
          if (nftRec?.originalCreator) originalCreator = nftRec.originalCreator;
          if (royaltyInfoRes && royaltyInfoRes[1] !== undefined) royaltyBps = Number(royaltyInfoRes[1]);
          if (artifactHashes) {
            if (artifactHashes[1] && artifactHashes[1] !== ethers.ZeroHash) onChainSummaryHash = artifactHashes[1];
            if (artifactHashes[2] && artifactHashes[2] !== ethers.ZeroHash) onChainMetadataHash = artifactHashes[2];
          }
          reuseCount = Number(rawReuseCnt || 0n);
          blindTagCount = Number(rawTagCnt || 0n);
          reuseFeeGeno = Number(ethers.formatUnits(rawReuseFee || 0n, 18));
        } catch {}

        const resolvedMetadataHash = onChainMetadataHash || seedMatch?.metadataHash || null;
        const hasAnchorHash = Boolean(resolvedMetadataHash && resolvedMetadataHash !== ethers.ZeroHash);
        let ipfsMeta = null;
        let metadataVerificationStatus = hasAnchorHash ? "unverified" : "unanchored";
        if (raw.metadataCid) {
          try {
            const bytes = await retrieveFromIpfs(raw.metadataCid, undefined, { fastCatalog: true });
            if (bytes?.length) {
              if (hasAnchorHash) {
                const computedHash = ethers.sha256(bytes);
                if (computedHash.toLowerCase() !== resolvedMetadataHash.toLowerCase()) {
                  metadataVerificationStatus = "tampered";
                  evictLocalIpfsContent(raw.metadataCid);
                  throw new Error(`Cryptographic tamper detected: Metadata CID ${raw.metadataCid} hash mismatch`);
                }
                metadataVerificationStatus = "verified";
              } else {
                try {
                  await verifySummaryCidIntegrity(raw.metadataCid, bytes);
                } catch (cidErr) {
                  metadataVerificationStatus = "tampered";
                  evictLocalIpfsContent(raw.metadataCid);
                  throw cidErr;
                }
                metadataVerificationStatus = "unanchored";
              }
              ipfsMeta = sanitizeMetaTree(JSON.parse(new TextDecoder().decode(bytes)));
            }
          } catch (e) {
            if (metadataVerificationStatus === "tampered" || !seedMatch) {
              console.warn(`Failed to fetch or verify IPFS metadata for dataset #${dId}:`, e);
            }
          }
        }
        const metadataTampered = metadataVerificationStatus === "tampered";
        let extractedSummaryHash = seedMatch?.summaryDataHash || null;
        if (!extractedSummaryHash && ipfsMeta?.files) {
          const sumFile = ipfsMeta.files.find((f) => f.fileAttributes?.fileFormat === "application/pdf" || (f.uri && f.uri.includes(raw.summaryCiphertextCid)));
          extractedSummaryHash = sumFile?.fileAttributes?.summaryDataHash || sumFile?.fileAttributes?.rawDataHash || null;
        }
        const phenoGene = ipfsMeta?.interpretations?.[0]?.diagnosis?.genomicInterpretations?.[0]?.variantInterpretation?.variationDescriptor?.geneContext?.symbol;

        const resolvedSummaryHash = onChainSummaryHash || extractedSummaryHash;
        const artifactHashCount = [raw.rawDataHash, resolvedSummaryHash, resolvedMetadataHash]
          .filter((h) => h && h !== ethers.ZeroHash).length;

        const geneSym = extractCleanGeneSymbol(seedMatch, p, phenoGene);
        const geneInfo = p?.geneSymbol || seedMatch?.gene || (phenoGene ? `${String(phenoGene).replace(/^var-/i, "")}` : `Target Locus: ${raw.rawCiphertextCid.substring(0, 8)}...`);
        const chrom = extractCleanChromosome(seedMatch, ipfsMeta, geneSym, geneInfo, dId, Boolean(p));
        const cleanRsId = extractCleanRsId(seedMatch, ipfsMeta, geneInfo, dId, Boolean(p));
        const phenoSigRef = ipfsMeta?.metaData?.externalReferences?.find(
          (r) => r?.id === "GENOCHAIN_CLINICAL_SIGNIFICANCE"
        )?.description;
        const sig =
          seedMatch?.clinicalSignificance ||
          phenoSigRef ||
          ipfsMeta?.clinicalSignificance ||
          (p
            ? (dId === 1
                ? "Population Genetics"
                : [2, 6, 8, 10].includes(dId)
                  ? "Physical Traits & Performance"
                  : [3, 4, 9].includes(dId)
                    ? "Sensory & Metabolism"
                    : dId === 5
                      ? "Pharmacogenomics"
                      : "Reference Benchmark")
            : "Physiological Traits");
        const cons = seedMatch?.consequence || (p ? ([4, 5, 8].includes(dId) ? "regulatory_variant" : dId === 2 ? "stop_gained" : dId === 7 ? "synonymous_variant" : "missense_variant") : "missense_variant");
        const rawPhenoZyg = ipfsMeta?.interpretations?.[0]?.diagnosis?.genomicInterpretations?.[0]?.variantInterpretation?.variationDescriptor?.allelicState?.label;
        const normalizedPhenoZyg = (() => {
          const s = String(rawPhenoZyg || "").trim();
          if (!s || s.toLowerCase() === "unspecified") return "";
          if (s.includes("0/1") || s.includes("1/1") || s.includes("0/0")) return s;
          if (s.includes("1/0") || s.includes("0|1") || s.includes("1|0")) return "0/1 Heterozygous";
          if (s.includes("1|1")) return "1/1 Homozygous Alt";
          if (s.includes("0|0")) return "0/0 Homozygous Ref";
          const low = s.toLowerCase();
          if (low.includes("hetero")) return "0/1 Heterozygous";
          if (low.includes("homo") && low.includes("ref")) return "0/0 Homozygous Ref";
          if (low.includes("homo")) return "1/1 Homozygous Alt";
          return s;
        })();
        const zyg = seedMatch?.zygosity || normalizedPhenoZyg || (p ? ([4, 6, 10].includes(dId) ? "1/1 (Homozygous Alt)" : "0/1 (Heterozygous)") : "0/1 Heterozygous");
        const refAssembly = seedMatch?.assembly || ipfsMeta?.interpretations?.[0]?.diagnosis?.genomicInterpretations?.[0]?.variantInterpretation?.variationDescriptor?.vcfRecord?.genomeAssembly || (p && dId === 7 ? "GRCh37" : chrom === "chrM" ? "rCRS" : "GRCh38");
        const metaMime = ipfsMeta?.files?.[0]?.fileAttributes?.fileFormat || ipfsMeta?.format || "";
        const metaMimeLower = String(metaMime).toLowerCase();
        const dataFormat = seedMatch?.format || (metaMimeLower.includes("fastq") || geneSym === "FASTQ" || geneInfo.includes("FASTQ") ? "FASTQ (Reads)" : metaMimeLower.includes("bam") ? "BAM (Binary)" : metaMimeLower.includes("c4gh") || metaMimeLower.includes("crypt4gh") ? "Crypt4GH" : metaMimeLower.includes("gz") ? "VCF.GZ" : geneSym === "FASTA" || geneInfo.includes("FASTA") || chrom === "chrM" ? "FASTA (Sequence)" : geneSym === "JSON" || geneInfo.includes("Phenopacket") ? "GA4GH JSON" : (metaMime || "VCF"));
        const seqPlatform = seedMatch?.platform || (p ? (dId === 1 ? "1000 Genomes WGS" : dId === 7 ? "GATK Pipeline" : "Illumina NovaSeq") : geneInfo.includes("SAMtools") ? "SAMtools Panel" : "Illumina NovaSeq");

        const hancestroLabel = ipfsMeta?.phenotypicFeatures?.find((f) => f.type?.id?.startsWith("HANCESTRO"))?.type?.label;
        const bloodGrp = seedMatch?.bloodGroup || seedMatch?.bloodType || extractPhenopacketBloodGroup(ipfsMeta) || p?.bloodGroup || p?.bloodType || "N/A";
        return {
          dataId: dId, tokenId: tId, owner: dynamicOwner, originalCreator, metadataTampered, metadataVerificationStatus,
          disease: p?.titleVi || seedMatch?.disease || ipfsMeta?.diseases?.[0]?.term?.label || `Molecular Genomic Cohort #${dId}`,
          titleVi: p?.titleVi || seedMatch?.disease || ipfsMeta?.diseases?.[0]?.term?.label || `Mẫu Hệ Gen Phân Tử #${dId}`,
          titleEn: p?.titleEn || ipfsMeta?.diseases?.[0]?.term?.label || `Molecular Genomic Cohort #${dId}`,
          traitVi: p?.traitVi || seedMatch?.disease || ipfsMeta?.phenotypicFeatures?.[0]?.type?.label || `Đặc Tính Hệ Gen #${dId}`,
          traitEn: p?.traitEn || ipfsMeta?.phenotypicFeatures?.[0]?.type?.label || `Genomic Trait #${dId}`,
          category: p?.category || sig, categoryVi: p?.categoryVi || "Mẫu Di Truyền On-Chain", categoryEn: p?.categoryEn || "On-Chain Cohort",
          gene: geneInfo, geneSymbol: geneSym, chromosome: chrom, pos: seedMatch?.pos || ipfsMeta?.interpretations?.[0]?.diagnosis?.genomicInterpretations?.[0]?.variantInterpretation?.variationDescriptor?.vcfRecord?.pos || 0,
          rsId: cleanRsId,
          clinicalSignificance: sig, consequence: cons, zygosity: zyg, assembly: refAssembly, format: dataFormat, platform: seqPlatform,
          hpoTerm: p?.variantClass || seedMatch?.hpoTerm || ipfsMeta?.phenotypicFeatures?.[0]?.type?.label || "SO:0000694 (Genomic Variant)",
          region: p?.ancestryRegion || seedMatch?.region || hancestroLabel || ipfsMeta?.subject?.ancestry || "On-Chain Verified Cohort",
          ancestry: seedMatch?.ancestry || hancestroLabel || p?.ancestryRegion || ipfsMeta?.subject?.ancestry || "On-Chain Verified Cohort",
          clinvarId: seedMatch?.clinvarId || (cleanRsId && cleanRsId !== "N/A" ? `dbSNP:${cleanRsId}` : "N/A"),
          bloodGroup: bloodGrp, bloodType: bloodGrp,
          price: priceFmt, priceWei: priceWeiStr, priceFormatted, durationDays: durationDay, accessDurationSec: Number(raw.accessDuration || durationDay * 86400), accessCount,
          accumulatedRoyalty: Number(ethers.formatUnits(royaltyWeiByDataId.get(dId) || 0n, 18)), royaltyBps, status: statusStr, statusNum,
          rawCid: raw.rawCiphertextCid, summaryCid: raw.summaryCiphertextCid, metadataCid: raw.metadataCid,
          rawDataHash: raw.rawDataHash, summaryDataHash: resolvedSummaryHash,
          metadataHash: resolvedMetadataHash, artifactHashCount,
          reuseCount, blindTagCount, reuseFeeGeno,
          rawRegisteredAtSec: Number(raw.registeredAt || 0),
          registeredAt: new Date(Number(raw.registeredAt) * 1000).toLocaleDateString()
        };
      }, 6);
      if (fetchSeqRef.current !== mySeq) return;
      setRawDatasets(mapped);

      const effectiveAccount = latestAccountRef.current;
      if (effectiveAccount) {
        if (
          requestedAccount &&
          effectiveAccount.toLowerCase() !== requestedAccount.toLowerCase()
        ) {
          return;
        }
        const accessChecks = await runWithConcurrency(mapped, async (d) => {
          const isOwner = d.owner.toLowerCase() === effectiveAccount.toLowerCase();
          let hasAccess = false, grantData = null, escrowInfo = null;
          try {
            hasAccess = await contracts.registry.hasActiveAccess(d.dataId, effectiveAccount);
            if (hasAccess) grantData = await contracts.registry.accessGrants(d.dataId, effectiveAccount);
          } catch {}
          if (!isOwner) {
            try {
              const dep = await contracts.registry.escrowDeposits(d.dataId, effectiveAccount);
              if (dep && dep.amount > 0n) {
                const [isDisputed, isManual, rawDisputedAt, rawLockDeadline] = await Promise.all([
                  contracts.registry.escrowDisputed(d.dataId, effectiveAccount).catch(() => false),
                  contracts.registry.manualEscrowRelease(d.dataId, effectiveAccount).catch(() => false),
                  contracts.registry.escrowDisputedAt
                    ? contracts.registry.escrowDisputedAt(d.dataId, effectiveAccount).catch(() => 0n)
                    : Promise.resolve(0n),
                  contracts.registry.getEscrowLockDeadline
                    ? contracts.registry.getEscrowLockDeadline(d.dataId, effectiveAccount).catch(() => null)
                    : Promise.resolve(null)
                ]);
                const depTime = Number(dep.depositTime), disputeWin = Number(dep.disputeWindow);
                const deliveryDeadline = depTime + disputeWin;
                const fallbackLockDeadline = isManual
                  ? deliveryDeadline + 7 * 86400
                  : deliveryDeadline;
                const lockDeadline =
                  rawLockDeadline !== null && rawLockDeadline !== undefined && BigInt(rawLockDeadline) > 0n
                    ? Number(rawLockDeadline)
                    : fallbackLockDeadline;
                const capsuleDelivered = Boolean(dep.capsuleDelivered);
                const isDisp = Boolean(isDisputed);
                const disputedAt = Number(rawDisputedAt || 0n);
                const disputeTimeoutAt = disputedAt > 0 ? disputedAt + 30 * 86400 : 0;
                const canClaimDisputeTimeout = Boolean(
                  !dep.released && !dep.refunded && isDisp && disputedAt > 0 && chainNowSec >= disputeTimeoutAt
                );
                const isInactive = d.statusNum !== 0;
                let canRefund = !dep.released && !dep.refunded && !isDisp && (
                  capsuleDelivered
                    ? (
                        chainNowSec < lockDeadline &&
                        (d.statusNum === 2 || d.statusNum === 1)
                      )
                    : (isInactive || chainNowSec >= deliveryDeadline)
                );
                if (
                  canRefund &&
                  capsuleDelivered &&
                  d.statusNum === 1 &&
                  contracts.registry.claimEscrowRefund?.staticCall
                ) {
                  try {
                    const roRegistry = contracts.provider
                      ? contracts.registry.connect(contracts.provider)
                      : contracts.registry;
                    await roRegistry.claimEscrowRefund.staticCall(d.dataId, { from: effectiveAccount });
                  } catch {
                    canRefund = false;
                  }
                }
                const canDispute = !dep.released && !dep.refunded && capsuleDelivered && !isDisp && chainNowSec < lockDeadline;
                escrowInfo = {
                  amount: Number(ethers.formatUnits(dep.amount, 18)), depositTime: depTime, disputeWindow: disputeWin,
                  deadline: capsuleDelivered ? lockDeadline : deliveryDeadline,
                  deliveryDeadline, lockDeadline,
                  disputedAt, disputeTimeoutAt, canClaimDisputeTimeout,
                  released: Boolean(dep.released), refunded: Boolean(dep.refunded), capsuleDelivered,
                  isDisputed: isDisp, isManual: Boolean(isManual), isPending: !dep.released && !dep.refunded, canRefund, canDispute
                };
              }
            } catch {}
          }
          return { d, isOwner, hasAccess, grantData, escrowInfo };
        }, 6);

        if (fetchSeqRef.current !== mySeq) return;

        const purchasedList = [];
        for (const item of accessChecks) {
          const { d, isOwner, hasAccess, grantData, escrowInfo } = item;
          if (hasAccess || isOwner || escrowInfo?.isPending) {
            const isEscrowPending = Boolean(!isOwner && escrowInfo?.isPending);
            purchasedList.push({
              ...d,
              accountAddr: effectiveAccount.toLowerCase(),
              grantExpiresAtSec: grantData?.expiresAt ? Number(grantData.expiresAt) : null,
              chainNowSec,
              escrowInfo,
              isEscrowPending,
              capsuleDelivered: Boolean(escrowInfo?.capsuleDelivered),
              hasActiveAccess: hasAccess,
              isOwner,
              decryptedContent: null,
              decryptedPdfBytes: null,
              phenopacketJson: null,
              partialWarning: null
            });
          }
        }

        setRawPurchasedData((prev) => {
          const prevList = prev || [];
          const prevMap = new Map(prevList.map((p) => [`${p.accountAddr || ""}:${p.dataId}`, p]));
          return purchasedList.map((n) => {
            const key = `${n.accountAddr || ""}:${n.dataId}`;
            const p = prevMap.get(key);
            if (p?.decryptedContent && n.status === "Active" && !n.escrowInfo?.isDisputed) {
              return {
                ...n,
                decryptedContent: p.decryptedContent,
                decryptedPdfBytes: p.decryptedPdfBytes,
                phenopacketJson: p.phenopacketJson,
                partialWarning: p.partialWarning ?? null
              };
            }
            return n;
          });
        });
      } else {
        setRawPurchasedData([]);
      }
    } catch (err) {
      if (fetchSeqRef.current !== mySeq) return;
      console.warn("Dataset sync warning:", err.message);
      setCatalogError(err.message);
      setRawDatasets([]);
      setRawPurchasedData([]);
    } finally {
      if (fetchSeqRef.current === mySeq) {
        setLoadingChain(false);
      }
    }
  }, [getContracts]);

  // MED-02: Immediately purge previous wallet's purchased/decrypted buffers on EVERY wallet change before RPC resolves
  useEffect(() => {
    setRawPurchasedData([]);
    fetchOnChainDatasets(account);
  }, [fetchOnChainDatasets, account]);

  const confirmCapsuleAndReleaseEscrow = useCallback(
    async (dataId) => {
      return executeSerializedTx(account, async () => {
        const { registry } = await getContracts();
        const tx = await registry.confirmCapsuleAndReleaseEscrow(dataId);
        await tx.wait();
        await fetchOnChainDatasets(account);
        return tx;
      });
    },
    [getContracts, fetchOnChainDatasets, account]
  );

  const disputeCapsule = useCallback(
    async (dataId) => {
      return executeSerializedTx(account, async () => {
        const { registry } = await getContracts();
        const tx = await registry.disputeCapsule(dataId);
        await tx.wait();
        await fetchOnChainDatasets(account);
        return tx;
      });
    },
    [getContracts, fetchOnChainDatasets, account]
  );

  const setManualEscrowRelease = useCallback(
    async (dataId, manual) => {
      return executeSerializedTx(account, async () => {
        const { registry } = await getContracts();
        const tx = await registry.setManualEscrowRelease(dataId, manual);
        await tx.wait();
        await fetchOnChainDatasets(account);
        return tx;
      });
    },
    [getContracts, fetchOnChainDatasets, account]
  );

  const releaseEscrow = useCallback(
    async (dataId, buyer) => {
      return executeSerializedTx(account, async () => {
        const { registry } = await getContracts();
        const tx = await registry.releaseEscrow(dataId, buyer || account);
        await tx.wait();
        await fetchOnChainDatasets(account);
        return tx;
      });
    },
    [getContracts, fetchOnChainDatasets, account]
  );

  const claimDisputeTimeoutRefund = useCallback(
    async (dataId) => {
      return executeSerializedTx(account, async () => {
        const { registry } = await getContracts();
        const tx = await registry.claimDisputeTimeoutRefund(dataId);
        await tx.wait();
        await fetchOnChainDatasets(account);
        return tx;
      });
    },
    [getContracts, fetchOnChainDatasets, account]
  );

  const syncedSelectedAssetModal = useMemo(() => {
    if (!selectedAssetModal) return null;
    return datasets.find((d) => d.dataId === selectedAssetModal.dataId) || selectedAssetModal;
  }, [selectedAssetModal, datasets]);

  return {
    datasets, setDatasets: setRawDatasets,
    catalogError,
    purchasedData, setPurchasedData: setRawPurchasedData,
    loadingChain, fetchOnChainDatasets,
    selectedAssetModal: syncedSelectedAssetModal, setSelectedAssetModal,
    confirmCapsuleAndReleaseEscrow,
    disputeCapsule,
    setManualEscrowRelease,
    releaseEscrow,
    claimDisputeTimeoutRefund
  };
}

export async function confirmCapsuleAndReleaseEscrow(registryOrSigner, dataId) {
  if (!registryOrSigner) throw new Error("Registry contract or signer required.");
  const registry = registryOrSigner.confirmCapsuleAndReleaseEscrow
    ? registryOrSigner
    : new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, registryOrSigner);
  const tx = await registry.confirmCapsuleAndReleaseEscrow(dataId);
  await tx.wait();
  return tx;
}

export async function disputeCapsule(registryOrSigner, dataId) {
  if (!registryOrSigner) throw new Error("Registry contract or signer required.");
  const registry = registryOrSigner.disputeCapsule
    ? registryOrSigner
    : new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, registryOrSigner);
  const tx = await registry.disputeCapsule(dataId);
  await tx.wait();
  return tx;
}

export async function setManualEscrowRelease(registryOrSigner, dataId, manual) {
  if (!registryOrSigner) throw new Error("Registry contract or signer required.");
  const registry = registryOrSigner.setManualEscrowRelease
    ? registryOrSigner
    : new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, registryOrSigner);
  const tx = await registry.setManualEscrowRelease(dataId, manual);
  await tx.wait();
  return tx;
}

export async function releaseEscrow(registryOrSigner, dataId, buyer) {
  if (!registryOrSigner) throw new Error("Registry contract or signer required.");
  const registry = registryOrSigner.releaseEscrow
    ? registryOrSigner
    : new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, registryOrSigner);
  const tx = await registry.releaseEscrow(dataId, buyer);
  await tx.wait();
  return tx;
}