import React, { useState } from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useTheme } from "../../context/ThemeContext";
import { useLanguage } from "../../context/LanguageContext";

/**
 * OpenSea OS2 Fixed Bottom Status Bar (32px height, bottom: 0, left: 52px, right: 0)
 * Replicates exact footer bar from https://opensea.io
 */
export default function OpenSeaBottomBar() {
  const {
    userRole,
    setUserRole,
    setResearcherTab,
    setDonorTab,
    genoBalance,
    claimFaucet,
    setShowIpfsSettings,
    showToast
  } = useWeb3();
  const { theme, setTheme } = useTheme();
  const { lang, changeLanguage } = useLanguage();
  const [currencyMode, setCurrencyMode] = useState("usd");

  return (
    <footer className="os2-bottom-bar" aria-label="OpenSea Status Footer">
      <div className="os2-bottom-inner">
        {/* Left Cluster */}
        <div className="os2-bottom-left">
          <span className="os2-status-live">
            <span className="os2-live-dot" />
            <span>Live</span>
          </span>

          <span className="os2-bottom-divider" />

          <button
            type="button"
            className="os2-bottom-link-btn"
            onClick={() => setShowIpfsSettings(true)}
            title="IPFS & EVM Aggregator Engine"
          >
            <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor">
              <path d="m422-232 207-248H469l29-227-185 267h139l-30 208ZM320-80l40-280H160l360-520h80l-40 320h240L400-80h-80Z" />
            </svg>
            <span>Aggregating</span>
          </button>

          <span className="os2-bottom-divider" />

          <button
            type="button"
            className="os2-bottom-link-btn"
            onClick={() =>
              showToast(
                lang === "vi"
                  ? "Mạng lưới đang kết nối: Hardhat Localhost EVM (Chain ID: 31337, RPC: 127.0.0.1:8545)"
                  : "Connected Network: Hardhat Localhost EVM (Chain ID: 31337, RPC: 127.0.0.1:8545)",
                "info"
              )
            }
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="2" />
              <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
            </svg>
            <span>Networks</span>
          </button>

          <span className="os2-bottom-divider hide-sm" />

          <button
            type="button"
            className="os2-bottom-text-link hide-md"
            onClick={() =>
              showToast("DeSci Regulatory Compliance: GA4GH & GDPR Art. 17 Consent Permanence Enforced.", "info")
            }
          >
            Platform Terms
          </button>
          <button
            type="button"
            className="os2-bottom-text-link hide-md"
            onClick={() =>
              showToast("EIP-2981 10% Automated Creator Royalty & Timelock Escrow Smart Contract.", "info")
            }
          >
            Wallet &amp; Onramp Terms
          </button>
          <button
            type="button"
            className="os2-bottom-text-link hide-md"
            onClick={() =>
              showToast("Zero-Knowledge Client-Side AES-256-GCM & Non-Extractable RSA-OAEP 2048 Keys.", "info")
            }
          >
            Privacy Policy
          </button>

          <span className="os2-bottom-divider hide-lg" />

          {/* Social Icons matching OpenSea Footer */}
          <div className="os2-social-cluster hide-lg">
            {/* Discord */}
            <button
              type="button"
              className="os2-social-icon"
              title="GenoChain DeSci Discord Community"
              onClick={() => showToast("GenoChain DeSci Community - Global Decentralized Research Channel", "info")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028Z" />
              </svg>
            </button>
            {/* Reddit */}
            <button
              type="button"
              className="os2-social-icon"
              title="r/DeSciGenomics Forum"
              onClick={() => showToast("r/DeSciGenomics - Molecular Genetics & GA4GH Standards Forum", "info")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="10" />
              </svg>
            </button>
            {/* Telegram */}
            <button
              type="button"
              className="os2-social-icon"
              title="Telegram Node Alerts"
              onClick={() => showToast("Telegram Alert Bot: Connected to Hardhat EVM Chain 31337", "info")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
              </svg>
            </button>
            {/* X */}
            <button
              type="button"
              className="os2-social-icon"
              title="X (Twitter)"
              onClick={() => showToast("@GenoChain_DeSci - Decentralized Genomic Data Marketplace", "info")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </button>
            {/* Instagram */}
            <button
              type="button"
              className="os2-social-icon"
              title="3D Molecular Gallery"
              onClick={() => showToast("3D Molecular Visualization Gallery - 100% High-Res Biotech Renders", "info")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            </button>
          </div>
        </div>

        {/* Right Cluster */}
        <div className="os2-bottom-right">
          {/* ETH / GENO Price & Faucet Trigger */}
          <button
            type="button"
            className="os2-price-ticker-btn"
            onClick={claimFaucet}
            title="Click to claim +1,000 $GENO from Faucet"
          >
            <svg width="11" height="13" viewBox="0 0 256 417" fill="currentColor">
              <path d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" fillOpacity="0.6" />
              <path d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
              <path d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.601L256 236.587z" fillOpacity="0.6" />
              <path d="M127.962 416.905v-104.72L0 236.585z" />
            </svg>
            <span>
              {currencyMode === "usd"
                ? "$2,392.71"
                : `${genoBalance > 0 ? genoBalance.toLocaleString() : "1,000"} GENO`}
            </span>
          </button>

          <span className="os2-bottom-divider" />

          <button
            type="button"
            className="os2-bottom-link-btn"
            onClick={() =>
              showToast(
                lang === "vi"
                  ? "Hỗ trợ GenoChain: Trung tâm hỗ trợ tích hợp Web3 & Nút IPFS"
                  : "GenoChain Support: Web3 & IPFS Node Integration Hub",
                "info"
              )
            }
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>Support</span>
          </button>

          <span className="os2-bottom-divider" />

          {/* 3-Icon Theme Switcher (Sun | Moon | Half) matching OpenSea OS2 */}
          <div className="os2-pill-group">
            <button
              type="button"
              className={`os2-pill-icon-btn ${theme === "light" ? "active" : ""}`}
              onClick={() => setTheme("light")}
              title="Light Mode"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            </button>
            <button
              type="button"
              className={`os2-pill-icon-btn ${theme === "dark" ? "active" : ""}`}
              onClick={() => setTheme("dark")}
              title="Dark Mode"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            </button>
            <button
              type="button"
              className="os2-pill-icon-btn"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              title="Toggle Contrast"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18V4a8 8 0 0 1 0 16z" />
              </svg>
            </button>
          </div>

          {/* Collector / Pro Segmented Switch */}
          <div className="os2-pill-group">
            <button
              type="button"
              className={`os2-pill-txt-btn ${userRole === "researcher" ? "active" : ""}`}
              onClick={() => {
                setUserRole("researcher");
                setResearcherTab("catalog");
              }}
            >
              Collector
            </button>
            <button
              type="button"
              className={`os2-pill-txt-btn ${userRole === "donor" ? "active" : ""}`}
              onClick={() => {
                setUserRole("donor");
                setDonorTab("upload");
              }}
            >
              Pro
            </button>
          </div>

          {/* Crypto / USD Segmented Switch */}
          <div className="os2-pill-group">
            <button
              type="button"
              className={`os2-pill-txt-btn ${currencyMode === "crypto" ? "active" : ""}`}
              onClick={() => setCurrencyMode("crypto")}
            >
              Crypto
            </button>
            <button
              type="button"
              className={`os2-pill-txt-btn ${currencyMode === "usd" ? "active" : ""}`}
              onClick={() => setCurrencyMode("usd")}
            >
              USD
            </button>
          </div>

          {/* VI / EN Language Switch */}
          <div className="os2-pill-group">
            <button
              type="button"
              className={`os2-pill-txt-btn ${lang === "vi" ? "active" : ""}`}
              onClick={() => changeLanguage("vi")}
            >
              VI
            </button>
            <button
              type="button"
              className={`os2-pill-txt-btn ${lang === "en" ? "active" : ""}`}
              onClick={() => changeLanguage("en")}
            >
              EN
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
