import React from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";

/**
 * GenoChain Fixed Bottom Status Bar (28px height, bottom: 0, left: 52px, right: 0)
 * Live EVM 31337, IPFS Kubo/Pinata engine telemetry, and on-chain royalty status.
 */
export default function OpenSeaBottomBar() {
  const {
    account,
    genoBalance,
    pinataJwt,
    kuboRpc,
    claimFaucet,
    setShowIpfsSettings,
    showToast
  } = useWeb3();
  const { lang, t } = useLanguage();

  const ipfsEngineLabel = pinataJwt
    ? `${t("footerPinataReady")} + ${t("footerKuboReady")}`
    : `${t("footerKuboReady")} (${kuboRpc ? "5001" : "Local"})`;

  return (
    <footer className="os2-bottom-bar" aria-label="GenoChain Protocol Status Bar">
      <div className="os2-bottom-inner">
        {/* Left Cluster: Live Node & Cryptographic Standards */}
        <div className="os2-bottom-left">
          <span className="os2-status-live">
            <span className="os2-live-dot" />
            <span>{t("footerEvmLive")}</span>
          </span>

          <span className="os2-bottom-divider hide-sm" />

          <button
            type="button"
            className="os2-bottom-link-btn hide-sm"
            onClick={() => setShowIpfsSettings(true)}
            title={kuboRpc}
          >
            <svg width="12" height="12" viewBox="0 -960 960 960" fill="currentColor">
              <path d="m422-232 207-248H469l29-227-185 267h139l-30 208ZM320-80l40-280H160l360-520h80l-40 320h240L400-80h-80Z" />
            </svg>
            <span>{ipfsEngineLabel}</span>
          </button>

          <span className="os2-bottom-divider hide-md" />

          <button
            type="button"
            className="os2-bottom-text-link hide-md"
            onClick={() =>
              showToast(
                lang === "vi"
                  ? "Mã hóa phía máy khách AES-256-GCM và bọc khóa RSA-OAEP 2048-bit (Non-Extractable)."
                  : "Client-side AES-256-GCM payload encryption & non-extractable RSA-OAEP 2048 key wrapping.",
                "info"
              )
            }
          >
            {t("footerCipherSpec")}
          </button>

          <span className="os2-bottom-divider hide-md" />

          <button
            type="button"
            className="os2-bottom-text-link hide-md"
            onClick={() =>
              showToast(
                lang === "vi"
                  ? "Chuẩn bản quyền EIP-2981 (10% bán chính thức, 5% tái sử dụng nghiên cứu)."
                  : "EIP-2981 Royalty enforcement: 10% primary access royalty & 5% secondary study reuse fee.",
                "info"
              )
            }
          >
            {t("footerRoyaltySpec")}
          </button>
        </div>

        {/* Right Cluster: Balance Quick-Faucet + IPFS Engine Config */}
        <div className="os2-bottom-right">
          {account && (
            <>
              <button
                type="button"
                className="os2-price-ticker-btn hide-sm"
                onClick={claimFaucet}
                title={t("faucetClaimTitle")}
              >
                <span>{`${genoBalance.toLocaleString()} $GENO`}</span>
              </button>
              <span className="os2-bottom-divider hide-sm" />
            </>
          )}

          <button
            id="footer-ipfs-settings-btn"
            type="button"
            className="os2-bottom-link-btn"
            onClick={() => setShowIpfsSettings(true)}
            title={t("footerIpfsConfig")}
            aria-label={t("footerIpfsConfig")}
          >
            <span>{t("footerIpfsConfig")}</span>
          </button>
        </div>
      </div>
    </footer>
  );
}
