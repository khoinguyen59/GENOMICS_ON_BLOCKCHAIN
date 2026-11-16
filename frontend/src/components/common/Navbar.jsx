import React from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useTheme } from "../../context/ThemeContext";
import { useDatasets } from "../../context/DatasetContext";
import {
  GenoTokenIcon,
  SearchGlassIcon,
  CloseCrossIcon
} from "../icons/GenoIcons";

/**
 * OpenSea OS2 Sticky Top Bar
 * Matches https://opensea.io top header:
 * - Left: Search OpenSea input with "/" shortcut badge
 * - Right: Sign in / Connected Wallet + User Profile Circle Avatar
 */
export default function Navbar() {
  const {
    userRole,
    setUserRole,
    setDonorTab,
    setResearcherTab,
    account,
    genoBalance,
    connectWallet,
    disconnectWallet,
    claimFaucet,
    showToast
  } = useWeb3();

  const { filterKeyword, setFilterKeyword } = useDatasets();
  const { lang, changeLanguage, t } = useLanguage();
  const { theme, setTheme } = useTheme();

  return (
    <header className="os2-top-navbar">
      {/* Left: OpenSea OS2 Search Input */}
      <div className="os2-top-search-wrap">
        <div className="os2-top-search-box">
          <SearchGlassIcon size={16} color="var(--text-muted)" className="os2-search-icon" />
          <input
            id="nav-search-input"
            type="text"
            className="os2-search-input"
            placeholder={t("searchPlaceholderNav")}
            aria-label={t("searchPlaceholderNav")}
            value={filterKeyword}
            onChange={(e) => setFilterKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && userRole !== "researcher") {
                setUserRole("researcher");
                setResearcherTab("catalog");
              }
            }}
          />
          {filterKeyword ? (
            <button
              type="button"
              className="os2-search-clear"
              onClick={() => setFilterKeyword("")}
              title={t("clearAll")}
            >
              <CloseCrossIcon size={12} color="var(--text-muted)" />
            </button>
          ) : (
            <kbd className="os2-search-kbd">/</kbd>
          )}
        </div>
      </div>

      {/* Right: Role Switcher, Sign in / Wallet Cluster & Profile Circle */}
      <div className="os2-top-right">
        <div className="os2-role-switch-group" role="group" aria-label="Role Switcher">
          <button
            id="navbar-role-researcher"
            type="button"
            className={`os2-role-btn ${userRole === "researcher" ? "active" : ""}`}
            title={t("roleNavResearcher") || "Researcher"}
            onClick={() => {
              setUserRole("researcher");
              setResearcherTab("catalog");
            }}
          >
            {t("roleNavResearcher") || "Researcher"}
          </button>
          <button
            id="navbar-role-donor"
            type="button"
            className={`os2-role-btn ${userRole === "donor" ? "active" : ""}`}
            title={t("roleNavProvider") || "Provider"}
            onClick={() => {
              setUserRole("donor");
              setDonorTab("upload");
            }}
          >
            {t("roleNavProvider") || "Provider"}
          </button>
          <button
            id="navbar-role-admin"
            type="button"
            className={`os2-role-btn ${userRole === "admin" ? "active" : ""}`}
            title={t("roleNavAdmin") || "Admin"}
            onClick={() => setUserRole("admin")}
          >
            {t("roleNavAdmin") || "Admin"}
          </button>
        </div>

        {account ? (
          <div className="os2-wallet-cluster">
            <button
              type="button"
              className="os2-faucet-btn"
              onClick={claimFaucet}
              title={t("faucetClaimTitle")}
            >
              <GenoTokenIcon size={14} color="#fbbf24" />
              <span>{t("faucetClaim")}</span>
            </button>

            <div className="os2-wallet-pill">
              <span className="os2-wallet-bal">
                <GenoTokenIcon size={13} color="#0086FF" />
                {genoBalance.toLocaleString()} $GENO
              </span>
              <button
                type="button"
                className="os2-wallet-addr"
                onClick={() => {
                  if (navigator.clipboard) {
                    navigator.clipboard.writeText(account);
                    showToast(t("copiedToast"));
                  }
                }}
                title={account}
              >
                {account.substring(0, 6)}...{account.substring(account.length - 4)}
              </button>
            </div>

            <button
              type="button"
              className="os2-disconnect-btn"
              onClick={disconnectWallet}
              title={t("disconnectWallet") || "Disconnect Wallet"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="os2-signin-btn"
            onClick={() => connectWallet()}
          >
            {t("connectWallet")}
          </button>
        )}

        {/* Language & Theme Switchers */}
        <div className="os2-pill-group os2-lang-group" role="group" aria-label="Language Switcher">
          <button
            id="navbar-lang-vi"
            type="button"
            className={`os2-lang-btn ${lang === "vi" ? "active" : ""}`}
            title={t("langVi")}
            onClick={() => changeLanguage("vi")}
          >
            VI
          </button>
          <button
            id="navbar-lang-en"
            type="button"
            className={`os2-lang-btn ${lang === "en" ? "active" : ""}`}
            title={t("langEn")}
            onClick={() => changeLanguage("en")}
          >
            EN
          </button>
        </div>

        <button
          id="navbar-theme-toggle"
          type="button"
          className="os2-lang-mini-btn"
          title={t("themeToggleTitle")}
          aria-label={t("themeToggleTitle")}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          )}
        </button>

        {/* GenoChain Profile / Sovereign Vault Shortcut */}
        <button
          id="navbar-profile-btn"
          type="button"
          className="os2-profile-avatar-btn"
          title={t("navProfile")}
          aria-label={t("navProfile")}
          onClick={() => {
            if (account && navigator.clipboard) {
              navigator.clipboard.writeText(account).catch(() => {});
              showToast(t("profileCopiedMsg"));
            }
            setUserRole("donor");
            setDonorTab("vault");
          }}
        >
          <svg viewBox="0 -960 960 960" width="22" height="22" fill="currentColor">
            <path d="M234-276q51-39 114-61.5T480-360q69 0 132 22.5T726-276q35-41 54.5-93T800-480q0-133-93.5-226.5T480-800q-133 0-226.5 93.5T160-480q0 59 19.5 111t54.5 93Zm246-164q-59 0-99.5-40.5T340-580q0-59 40.5-99.5T480-720q59 0 99.5 40.5T620-580q0 59-40.5 99.5T480-440Zm0 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
