import React, { useState } from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import {
  InMemoryDecryptIcon,
  IpfsMeshIcon,
  GridIcon,
  ActivityPulseIcon
} from "../../components/icons/GenoIcons";
import OpenSeaSpotlightShowcase from "./OpenSeaSpotlightShowcase";
import GenomicFilterBar from "./GenomicFilterBar";
import DatasetCatalogTable from "./DatasetCatalogTable";
import DatasetCatalogGrid from "./DatasetCatalogGrid";
import LicensedDatasetsView from "./LicensedDatasetsView";
import OpenSeaActivityFeed from "./OpenSeaActivityFeed";

export default function ResearcherMarketplace({ onPurchase, onDecrypt, onDownload, onDownloadPdf, onClaimRefund }) {
  const {
    researcherTab,
    setResearcherTab,
    viewMode,
    account,
    isPubKeyRegisteredOnChain,
    registerPublicKeyOnChain
  } = useWeb3();
  const { purchasedData, datasets } = useDatasets();
  const { t } = useLanguage();

  // OpenSea Collection View Tabs: "items" vs "activity"
  const [collectionTab, setCollectionTab] = useState("items");

  return (
    <div className="os2-marketplace-wrapper">
      {/* Public Key On-Chain Registration Banner (compact bar when connected & unregistered) */}
      {account && !isPubKeyRegisteredOnChain && (
        <div className="os2-pubkey-alert-bar">
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "260px" }}>
            <span style={{ fontSize: "12px", color: "var(--accent-amber)", lineHeight: "1.4" }}>
              ⚠ {t("registerKeyBanner")}
            </span>
          </div>
          <button
            className="btn-terminal btn-terminal-primary"
            style={{ height: "28px", padding: "0 12px", fontSize: "11.5px", fontWeight: 700 }}
            onClick={registerPublicKeyOnChain}
            type="button"
          >
            {t("registerKeyBtn")}
          </button>
        </div>
      )}

      {/* Sub-tab 1: OpenSea OS2 Discover & Cohort Catalog */}
      {researcherTab === "catalog" && (
        <section>
          {/* OpenSea OS2 Subnav + 2-Column Split Viewport (Hero + Trending Tokens | Right Leaderboard) */}
          <OpenSeaSpotlightShowcase onPurchase={onPurchase} />

          {/* OpenSea All Genomic Cohorts & Activity Section */}
          <div id="os2-collections-section" className="os2-collections-divider">
            <div className="os2-section-header" style={{ marginBottom: 0 }}>
              <div>
                <h3 className="os2-section-title">Explore All Genomic Cohorts</h3>
                <p className="os2-section-subtitle"> Filter by chromosome, dbSNP rsID, variant consequence & on-chain escrow status</p>
              </div>
            </div>

            <div className="opensea-collection-nav-bar" style={{ marginBottom: 0, borderBottom: "none" }}>
              <div className="collection-subtabs-group">
                <button
                  type="button"
                  className={`collection-subtab-btn ${collectionTab === "items" ? "active" : ""}`}
                  onClick={() => setCollectionTab("items")}
                >
                  <GridIcon size={14} />
                  <span>{t("tabItems") || "Items"}</span>
                  <span className="collection-subtab-pill">{datasets.length}</span>
                </button>

                <button
                  id="os2-tab-activity-btn"
                  type="button"
                  className={`collection-subtab-btn ${collectionTab === "activity" ? "active" : ""}`}
                  onClick={() => setCollectionTab("activity")}
                >
                  <ActivityPulseIcon size={14} />
                  <span>{t("tabActivity") || "Activity"}</span>
                  <span className="live-pulse-dot-inline" />
                </button>

                <button
                  type="button"
                  className="collection-subtab-btn"
                  onClick={() => setResearcherTab("licensed")}
                >
                  <InMemoryDecryptIcon size={14} />
                  <span>{t("tabLicensedDatasets")}</span>
                  <span className="collection-subtab-pill">{purchasedData.length}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Render Items View (Split Filter Sidebar & Grid/Table) */}
          {collectionTab === "items" && (
            <GenomicFilterBar onPurchase={onPurchase}>
              {viewMode === "table" ? (
                <DatasetCatalogTable onPurchase={onPurchase} />
              ) : (
                <DatasetCatalogGrid onPurchase={onPurchase} />
              )}
            </GenomicFilterBar>
          )}

          {/* Render Activity View (Live Blockchain Transaction Feed) */}
          {collectionTab === "activity" && <OpenSeaActivityFeed />}
        </section>
      )}

      {/* Sub-tab 2: Licensed Datasets & In-Memory Decryption */}
      {researcherTab === "licensed" && (
        <section>
          <div className="portal-subnav-bar" style={{ marginBottom: "18px" }}>
            <div className="subnav-tabs">
              <button
                className="subnav-tab-item"
                onClick={() => setResearcherTab("catalog")}
                type="button"
              >
                <IpfsMeshIcon size={16} color="var(--text-muted)" />
                <span>← {t("tabCohortCatalog")}</span>
              </button>
              <button
                className="subnav-tab-item active"
                onClick={() => setResearcherTab("licensed")}
                type="button"
              >
                <InMemoryDecryptIcon size={16} color="var(--accent-emerald)" />
                <span>{t("tabLicensedDatasets")} ({purchasedData.length})</span>
              </button>
            </div>
          </div>

          <LicensedDatasetsView
            onDecrypt={onDecrypt}
            onDownload={onDownload}
            onDownloadPdf={onDownloadPdf}
            onClaimRefund={onClaimRefund}
          />
        </section>
      )}
    </div>
  );
}
