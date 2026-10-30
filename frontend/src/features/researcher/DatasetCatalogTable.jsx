import React from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import {
  GenoLogoIcon,
  VerifiedBadgeIcon,
  SealedCipherIcon,
  InMemoryDecryptIcon,
  GenoTokenIcon
} from "../../components/icons/GenoIcons";
import contractAddresses from "../../contracts/contractAddresses.json";

export default function DatasetCatalogTable({ onPurchase }) {
  const { account, setResearcherTab } = useWeb3();
  const {
    filteredDatasets,
    datasets,
    purchasedData,
    setSelectedAssetModal,
    getLocalizedTitle,
    getLocalizedSignificance,
    getLocalizedConsequence,
    getLocalizedZygosity
  } = useDatasets();
  const { t, language } = useLanguage();

  return (
    <div className="terminal-table-container">
      <table className="terminal-table">
        <thead>
          <tr>
            <th className="col-id">{t("colId")}</th>
            <th>{t("colTargetGene")}</th>
            <th>{t("colChromAssembly")}</th>
            <th>{t("colClinicalSig")}</th>
            <th>{t("colConsequenceZyg")}</th>
            <th>{t("colRawSequenceState")}</th>
            <th>{t("colPriceRoyalty")}</th>
            <th>{t("colTerm")}</th>
            <th style={{ textAlign: "right", paddingRight: "18px" }}>{t("colAction")}</th>
          </tr>
        </thead>
        <tbody>
          {filteredDatasets.map((ds) => {
            const isPurchased = purchasedData.some((p) => p.dataId === ds.dataId);
            const isOwner = account && ds.owner.toLowerCase() === account.toLowerCase();

            return (
              <tr key={ds.dataId}>
                <td className="col-id">#{String(ds.dataId).padStart(2, "0")}</td>
                <td>
                  <div className="gene-cell">
                    <div className="gene-icon-badge">
                      <GenoLogoIcon size={16} />
                    </div>
                    <div>
                      <div className="gene-symbol-row">
                        <span className="gene-symbol">{ds.geneSymbol || ds.gene}</span>
                        <span className="rsid-chip">{ds.rsId || "rs671"}</span>
                        <VerifiedBadgeIcon size={13} color="#10b981" />
                      </div>
                      <div className="disease-subtext">
                        {getLocalizedTitle ? getLocalizedTitle(ds, language) : ds.disease}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                    <span className="chrom-chip">{ds.chromosome || "chr12"}</span>
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted, #94a3b8)",
                        fontFamily: "var(--font-mono)"
                      }}
                    >
                      {ds.assembly || "GRCh38"} • {ds.pos ? Number(ds.pos).toLocaleString() : ""}
                    </span>
                  </div>
                </td>
                <td>
                  <span
                    className={`sig-chip ${
                      ds.clinicalSignificance === "Pathogenic Risk"
                        ? "sig-pathogenic"
                        : ds.clinicalSignificance === "Pharmacogenomics"
                        ? "sig-pharmaco"
                        : ds.clinicalSignificance === "Carrier Screening"
                        ? "sig-carrier"
                        : ds.clinicalSignificance === "Reference Benchmark"
                        ? "sig-benchmark"
                        : "sig-trait"
                    }`}
                  >
                    {getLocalizedSignificance
                      ? getLocalizedSignificance(ds.clinicalSignificance, language)
                      : (ds.clinicalSignificance || "Physiological Traits")}
                  </span>
                  <div style={{ fontSize: "11px", color: "var(--text-muted, #94a3b8)", marginTop: "3px" }}>
                    {ds.hpoTerm ? ds.hpoTerm.split(" ")[0] : ""} • {ds.ancestry || ds.region || "Global"}
                  </div>
                </td>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                    <span className="consequence-chip">
                      {getLocalizedConsequence
                        ? getLocalizedConsequence(ds.consequence, language)
                        : (ds.consequence || "missense_variant")}
                    </span>
                    <div>
                      <span className="zyg-chip">
                        {getLocalizedZygosity
                          ? getLocalizedZygosity(ds.zygosity, language)
                          : (ds.zygosity || "0/1 (Het)")}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <span
                    className="sealed-sequence-badge"
                    title={t("sealedCiphertextTitle")}
                  >
                    <SealedCipherIcon size={12} color="#38bdf8" />
                    <span>{t("sealedCiphertext")}</span>
                  </span>
                </td>
                <td>
                  <div className="price-main" style={{ fontSize: "13px", fontWeight: 700 }}>
                    {ds.price} $GENO
                  </div>
                  <div className="price-sub" style={{ fontSize: "11px" }}>
                    {t("royaltyNote")}
                  </div>
                </td>
                <td>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--text-secondary, #cbd5e1)"
                    }}
                  >
                    {ds.durationDays} {t("durationDays")}
                  </span>
                </td>
                <td style={{ textAlign: "right", paddingRight: "18px" }}>
                  <div className="action-cell-btns" style={{ justifyContent: "flex-end", gap: "6px" }}>
                    {isOwner ? (
                      <span className="owner-chip">{t("btnYourDataset")}</span>
                    ) : isPurchased ? (
                      <button
                        className="btn-terminal btn-terminal-success"
                        style={{ height: "30px", padding: "0 10px", fontSize: "12px" }}
                        onClick={() => setResearcherTab("licensed")}
                        type="button"
                      >
                        <InMemoryDecryptIcon size={13} />
                        <span>{t("btnPurchased")}</span>
                      </button>
                    ) : (
                      <button
                        className="btn-terminal btn-terminal-primary"
                        style={{ height: "30px", padding: "0 10px", fontSize: "12px" }}
                        onClick={() => onPurchase?.(ds)}
                        disabled={ds.status !== "Active"}
                        type="button"
                      >
                        <SealedCipherIcon size={12} />
                        <span>{t("btnPurchase")}</span>
                      </button>
                    )}
                    <button
                      className="btn-terminal btn-terminal-ghost"
                      style={{ height: "30px", padding: "0 8px", fontSize: "12px" }}
                      onClick={() => setSelectedAssetModal(ds)}
                      title={t("btnInspectTitle")}
                      type="button"
                    >
                      <span>{t("btnInspect")}</span>
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {filteredDatasets.length === 0 && (
            <tr>
              <td
                colSpan={9}
                style={{
                  textAlign: "center",
                  padding: "48px 20px",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)"
                }}
              >
                {t("noDatasetsFound")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="table-footer-bar" style={{ fontSize: "12px" }}>
        <span>
          {t("tableShowingCount")} {filteredDatasets.length} {t("tableOfCount")} {datasets.length} {t("tableVerifiedDatasets")}
        </span>
        <span style={{ color: "var(--text-disabled)" }}>
          Escrow:{" "}
          {contractAddresses.GenomicsRegistry
            ? `${contractAddresses.GenomicsRegistry.substring(0, 10)}...`
            : "Active"}{" "}
          • {t("royaltyActiveTag")}
        </span>
      </div>
    </div>
  );
}
