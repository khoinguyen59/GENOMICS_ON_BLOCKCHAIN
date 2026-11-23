import React from "react";
import { useWeb3, CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { formatConfiguredChainText } from "../../utils/asyncResilience";

/**
 * GenoChain Fixed Bottom Status Bar (28px height, bottom: 0, left: 52px, right: 0)
 * Live EVM network, IPFS Kubo/Pinata engine telemetry, and on-chain royalty status.
 */
export default function OpenSeaBottomBar() {
  const {
    account,
    genoBalance,
    pinataJwt,
    kuboRpc,
    kuboGateway,
    rpcOnline,
    wrongChain,
    configuredChainId = CONFIGURED_CHAIN_ID,
    configuredChainName = CONFIGURED_CHAIN_NAME,
    claimFaucet,
    faucetEnabled,
    faucetVoucherRequired,
    setShowIpfsSettings,
    showToast
  } = useWeb3();
  const { lang, t } = useLanguage();

  const activeIpfsEndpoint = kuboRpc || kuboGateway || "";
  const kuboDisplayPort = (() => {
    if (!activeIpfsEndpoint) return "Local";
    try {
      const parsed = new URL(activeIpfsEndpoint);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      }
    } catch {}
    const m = String(activeIpfsEndpoint).match(/:(\d+)(?:\/|$)/);
    return m ? m[1] : "Local";
  })();

  const ipfsEngineLabel = pinataJwt
    ? `${t("footerPinataReady")} + ${t("footerKuboReady")}`
    : `${t("footerKuboReady")} (${kuboDisplayPort})`;

  const chainIdText = String(configuredChainId);
  const evmStatusLabel = !rpcOnline
    ? t("rpcOfflineTitle")
    : wrongChain
    ? (lang === "vi" ? `Sai mạng ví (Chọn ${chainIdText})` : `Wrong Chain (Switch ${chainIdText})`)
    : formatConfiguredChainText(t("footerEvmLive") || `EVM ${chainIdText} Live`, configuredChainId, configuredChainName);
  const evmDotStyle = !rpcOnline
    ? { background: "#ef4444", boxShadow: "0 0 6px #ef4444" }
    : wrongChain
    ? { background: "#f59e0b", boxShadow: "0 0 6px #f59e0b" }
    : undefined;

  return (
    <footer className="os2-bottom-bar" aria-label="GenoChain Protocol Status Bar">
      <div className="os2-bottom-inner">
        {/* Left Cluster: Live Node & Cryptographic Standards */}
        <div className="os2-bottom-left">
          <span className="os2-status-live">
            <span className="os2-live-dot" style={evmDotStyle} />
            <span>{evmStatusLabel}</span>
          </span>

          <span className="os2-bottom-divider hide-sm" />

          <button
            type="button"
            className="os2-bottom-link-btn hide-sm"
            onClick={() => setShowIpfsSettings(true)}
            title={activeIpfsEndpoint}
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
                  ? "Chuẩn bản quyền EIP-2981 (5%–10% bán chính thức tùy chọn theo mẫu gen, 5% tái sử dụng nghiên cứu)."
                  : "EIP-2981 Royalty enforcement: 5%–10% configurable per-dataset primary royalty & 5% secondary study reuse fee.",
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
                onClick={() => claimFaucet()}
                disabled={!faucetEnabled}
                aria-disabled={!faucetEnabled}
                title={
                  !faucetEnabled
                    ? t("faucetDisabledMsg")
                    : faucetVoucherRequired
                      ? t("faucetVoucherModalTitle")
                      : t("faucetClaimTitle")
                }
              >
                <span>
                  {faucetVoucherRequired
                    ? `${genoBalance.toLocaleString()} $GENO · ${t("faucetVoucherShortTag")}`
                    : `${genoBalance.toLocaleString()} $GENO`}
                </span>
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