import React from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";

/**
 * OpenSea OS2 Left Collapsible Sidebar Rail (52px collapsed -> 220px expanded on hover)
 * Built from live scraped DOM & SVG paths of https://opensea.io
 */
export default function OpenSeaLeftSidebar({ activeNav, onSelectNav }) {
  const {
    userRole,
    setUserRole,
    donorTab,
    setDonorTab,
    researcherTab,
    setResearcherTab,
    claimFaucet,
    setShowIpfsSettings,
    showToast
  } = useWeb3();
  const { lang } = useLanguage();
  const { purchasedData } = useDatasets();

  const handleNavClick = (id) => {
    if (onSelectNav) onSelectNav(id);

    switch (id) {
      case "discover":
        setUserRole("researcher");
        setResearcherTab("catalog");
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "collections":
        setUserRole("researcher");
        setResearcherTab("catalog");
        setTimeout(() => {
          const el = document.getElementById("os2-collections-section");
          if (el) el.scrollIntoView({ behavior: "smooth" });
        }, 80);
        break;
      case "tokens":
        setUserRole("researcher");
        setResearcherTab("catalog");
        setTimeout(() => {
          const el = document.getElementById("os2-trending-tokens-section");
          if (el) el.scrollIntoView({ behavior: "smooth" });
        }, 80);
        break;
      case "perpetuals":
        setUserRole("researcher");
        setResearcherTab("catalog");
        setTimeout(() => {
          const el = document.getElementById("os2-collections-section");
          if (el) el.scrollIntoView({ behavior: "smooth" });
        }, 80);
        break;
      case "swap":
        claimFaucet();
        break;
      case "drops":
      case "studio":
        setUserRole("donor");
        setDonorTab("upload");
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "activity":
        setUserRole("researcher");
        setResearcherTab("catalog");
        setTimeout(() => {
          const actBtn = document.getElementById("os2-tab-activity-btn");
          if (actBtn) actBtn.click();
          const el = document.getElementById("os2-collections-section");
          if (el) el.scrollIntoView({ behavior: "smooth" });
        }, 80);
        break;
      case "rewards":
        showToast(
          lang === "vi"
            ? "EIP-2981 Royalty: Tự động trích 10% bản quyền vĩnh viễn cho Data Owner trên mọi giao dịch!"
            : "EIP-2981 Royalty: Automatically disburses 10% creator royalty on every access transaction!",
          "info"
        );
        break;
      case "tools":
        setUserRole("researcher");
        setResearcherTab("licensed");
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "profile":
        setUserRole("donor");
        setDonorTab("vault");
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "resources":
        showToast(
          lang === "vi"
            ? "Chuẩn dữ liệu: GA4GH Phenopackets v2, Crypt4GH Chunked AES-256-GCM, IPFS Multihash CIDv0."
            : "Standards: GA4GH Phenopackets v2, Crypt4GH Chunked AES-256-GCM, IPFS Multihash CIDv0.",
          "info"
        );
        break;
      case "settings":
        setShowIpfsSettings(true);
        break;
      case "support":
        showToast(
          lang === "vi"
            ? "Hệ thống GenoChain: Nền tảng chia sẻ dữ liệu di truyền phi tập trung DeSci bảo mật cao"
            : "GenoChain Protocol: High-security decentralized genomic data exchange platform",
          "info"
        );
        break;
      default:
        break;
    }
  };

  const currentActive =
    activeNav ||
    (userRole === "donor"
      ? donorTab === "vault"
        ? "profile"
        : "studio"
      : researcherTab === "licensed"
        ? "tools"
        : "discover");

  const primaryItems = [
    {
      id: "discover",
      label: lang === "vi" ? "Discover" : "Discover",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="m260-260 300-140 140-300-300 140-140 300Zm220-180q-17 0-28.5-11.5T440-480q0-17 11.5-28.5T480-520q17 0 28.5 11.5T520-480q0 17-11.5 28.5T480-440Zm0 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
        </svg>
      )
    },
    {
      id: "collections",
      label: lang === "vi" ? "Collections" : "Collections",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M440-120H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h240v720Zm-80-80v-560H200v560h160Zm160-320v-320h240q33 0 56.5 23.5T840-760v240H520Zm80-80h160v-160H600v160Zm-80 480v-320h320v240q0 33-23.5 56.5T760-120H520Zm80-80h160v-160H600v160ZM360-480Zm240-120Zm0 240Z" />
        </svg>
      )
    },
    {
      id: "tokens",
      label: lang === "vi" ? "Tokens" : "Tokens",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M600-160q-134 0-227-93t-93-227q0-134 93-227t227-93q134 0 227 93t93 227q0 134-93 227t-227 93Zm-320-10q-106-28-173-114T40-480q0-110 67-196t173-114v84q-72 25-116 87t-44 139q0 77 44 139t116 87v84Zm320-310Zm0 240q100 0 170-70t70-170q0-100-70-170t-170-70q-100 0-170 70t-70 170q0 100 70 170t170 70Z" />
        </svg>
      )
    },
    {
      id: "perpetuals",
      label: "Perpetuals",
      badge: "Beta",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M220-260q-92 0-156-64T0-480q0-92 64-156t156-64q37 0 71 13t61 37l68 62-60 54-62-56q-16-14-36-22t-42-8q-58 0-99 41t-41 99q0 58 41 99t99 41q22 0 42-8t36-22l310-280q27-24 61-37t71-13q92 0 156 64t64 156q0 92-64 156t-156 64q-37 0-71-13t-61-37l-68-62 60-54 62 56q16 14 36 22t42 8q58 0 99-41t41-99q0-58-41-99t-99-41q-22 0-42 8t-36 22L352-310q-27 24-61 37t-71 13Z" />
        </svg>
      )
    },
    {
      id: "swap",
      label: "Swap",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M240-200 80-360l56-58 64 64v-286q0-66 47-113t113-47q66 0 113 47t47 113v280q0 33 23.5 56.5T600-280q33 0 56.5-23.5T680-360v-286l-64 64-56-58 160-160 160 160-56 58-64-64v286q0 66-47 113t-113 47q-66 0-113-47t-47-113v-280q0-33-23.5-56.5T360-720q-33 0-56.5 23.5T280-640v286l64-64 56 58-160 160Z" />
        </svg>
      )
    },
    {
      id: "drops",
      label: "Drops",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Zm0-480h560v-80H200v80Zm0 0v-80 80Z" />
        </svg>
      )
    },
    {
      id: "activity",
      label: "Activity",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M100-180v-121.54h121.54V-180H100Zm216.92 0v-121.54H860V-180H316.92ZM100-419.23v-121.54h121.54v121.54H100Zm216.92 0v-121.54H860v121.54H316.92ZM100-658.46V-780h121.54v121.54H100Zm216.92 0V-780H860v121.54H316.92Z" />
        </svg>
      )
    },
    {
      id: "rewards",
      label: "Rewards",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M480-80q-61 0-125-22t-116-60q-52-38-85.5-89T120-360v-120l160 120-62 62q29 51 92 88t130 47v-357H320v-80h120v-47q-35-13-57.5-43.5T360-760q0-50 35-85t85-35q50 0 85 35t35 85q0 39-22.5 69.5T520-647v47h120v80H520v357q67-10 130-47t92-88l-62-62 160-120v120q0 58-33.5 109T721-162q-52 38-116 60T480-80Zm0-640q17 0 28.5-11.5T520-760q0-17-11.5-28.5T480-800q-17 0-28.5 11.5T440-760q0 17 11.5 28.5T480-720Z" />
        </svg>
      )
    },
    {
      id: "tools",
      label: "Tools",
      badge: purchasedData.length > 0 ? String(purchasedData.length) : "Beta",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="m422-232 207-248H469l29-227-185 267h139l-30 208ZM320-80l40-280H160l360-520h80l-40 320h240L400-80h-80Zm151-390Z" />
        </svg>
      )
    },
    {
      id: "studio",
      label: "Studio",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M160-120v-170l527-526q12-12 27-18t30-6q16 0 30.5 6t25.5 18l56 56q12 11 18 25.5t6 30.5q0 15-6 30t-18 27L330-120H160Zm80-80h56l393-392-28-29-29-28-392 393v56Zm560-503-57-57 57 57Zm-139 82-29-28 57 57-28-29ZM560-120q74 0 137-37t63-103q0-36-19-62t-51-45l-59 59q23 10 36 22t13 26q0 23-36.5 41.5T560-200q-17 0-28.5 11.5T520-160q0 17 11.5 28.5T560-120ZM183-426l60-60q-20-8-31.5-16.5T200-520q0-12 18-24t76-37q88-38 117-69t29-70q0-55-44-87.5T280-840q-45 0-80.5 16T145-785q-11 13-9 29t15 26q13 11 29 9t27-13q14-14 31-20t42-6q41 0 60.5 12t19.5 28q0 14-17.5 25.5T262-654q-80 35-111 63.5T120-520q0 32 17 54.5t46 39.5Z" />
        </svg>
      )
    },
    {
      id: "profile",
      label: "Profile",
      hasChevron: true,
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M234-276q51-39 114-61.5T480-360q69 0 132 22.5T726-276q35-41 54.5-93T800-480q0-133-93.5-226.5T480-800q-133 0-226.5 93.5T160-480q0 59 19.5 111t54.5 93Zm246-164q-59 0-99.5-40.5T340-580q0-59 40.5-99.5T480-720q59 0 99.5 40.5T620-580q0 59-40.5 99.5T480-440Zm0 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
        </svg>
      )
    }
  ];

  const secondaryItems = [
    {
      id: "resources",
      label: "Resources",
      hasChevron: true,
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M400-400h160v-80H400v80Zm0-120h320v-80H400v80Zm0-120h320v-80H400v80Zm-80 400q-33 0-56.5-23.5T240-320v-480q0-33 23.5-56.5T320-880h480q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H320Zm0-80h480v-480H320v480ZM160-80q-33 0-56.5-23.5T80-160v-560h80v560h560v80H160Zm160-720v480-480Z" />
        </svg>
      )
    },
    {
      id: "settings",
      label: "Settings",
      hasChevron: true,
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z" />
        </svg>
      )
    },
    {
      id: "support",
      label: "Support",
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="m480-80-10-120h-10q-142 0-241-99t-99-241q0-142 99-241t241-99q71 0 132.5 26.5t108 73q46.5 46.5 73 108T800-540q0 75-24.5 144t-67 128q-42.5 59-101 107T480-80Zm80-146q71-60 115.5-140.5T720-540q0-109-75.5-184.5T460-800q-109 0-184.5 75.5T200-540q0 109 75.5 184.5T460-280h100v54Zm-101-95q17 0 29-12t12-29q0-17-12-29t-29-12q-17 0-29 12t-12 29q0 17 12 29t29 12Zm-29-127h60q0-30 6-42t38-44q18-18 30-39t12-45q0-51-34.5-76.5T460-720q-44 0-74 24.5T344-636l56 22q5-17 19-33.5t41-16.5q27 0 40.5 15t13.5 33q0 17-10 30.5T480-558q-35 30-42.5 47.5T430-448Z" />
        </svg>
      )
    }
  ];

  return (
    <aside className="os2-left-sidebar" aria-label="OpenSea Primary Navigation">
      <nav className="os2-left-nav">
        {/* Top Brand Row: Official OpenSea Sailboat Emblem + Wordmark on Hover */}
        <button
          type="button"
          className="os2-brand-btn"
          onClick={() => handleNavClick("discover")}
          title="OpenSea — GenoChain DeSci Exchange"
        >
          <span className="os2-brand-logo-wrap">
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M15.131 0C6.743-.067-.069 6.744.001 15.132.07 23.276 6.725 29.931 14.869 30c8.388.072 15.202-6.742 15.13-15.13C29.932 6.727 23.276.07 15.131 0Z"
                fill="#0086FF"
              />
              <path
                d="M14.978 4.634c.537 0 .972.435.972.972v1.248c2.982 1.392 4.935 3.702 4.935 6.315 0 1.533-.67 2.96-1.827 4.16-.222.23-.53.36-.852.36h-2.254v1.857h2.83c.61 0 1.706-1.158 2.225-1.856 0 0 .022-.034.082-.052.06-.018 5.198-1.197 5.198-1.197a.17.17 0 0 1 .214.162v1.081c0 .07-.037.13-.102.158-.352.15-1.515.69-2 1.362-1.247 1.737-2.2 4.467-4.33 4.467h-8.887c-3.147 0-5.78-2.498-5.778-5.825 0-.082.07-.15.153-.15h4.212c.145 0 .26.117.26.26v.813c0 .432.349.783.782.783h3.195v-1.86h-2.182a9.293 9.293 0 0 0 2.002-5.783c0-2.437-.934-4.66-2.464-6.322.925.108 1.81.292 2.644.537v-.518c0-.537.435-.972.972-.972Zm-4.333 2.83a7.154 7.154 0 0 1 1.536 4.44c0 1.45-.43 2.8-1.17 3.926h-5.2l4.834-8.365Z"
                fill="#FFF"
              />
            </svg>
          </span>
          <span className="os2-brand-wordmark">OpenSea</span>
        </button>

        {/* Primary Navigation Links */}
        <div className="os2-nav-group">
          {primaryItems.map((item) => {
            const isActive = currentActive === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`os2-nav-item ${isActive ? "active" : ""}`}
                onClick={() => handleNavClick(item.id)}
                title={item.label}
              >
                <span className="os2-nav-icon">{item.svg}</span>
                <span className="os2-nav-label">
                  <span>{item.label}</span>
                  {item.badge && <span className="os2-nav-badge">{item.badge}</span>}
                </span>
                {item.hasChevron && (
                  <svg className="os2-nav-chevron" viewBox="0 -960 960 960" width="16" height="16" fill="currentColor">
                    <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        <div className="os2-nav-divider" />

        {/* Secondary Navigation Links */}
        <div className="os2-nav-group">
          {secondaryItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="os2-nav-item"
              onClick={() => handleNavClick(item.id)}
              title={item.label}
            >
              <span className="os2-nav-icon">{item.svg}</span>
              <span className="os2-nav-label">
                <span>{item.label}</span>
              </span>
              {item.hasChevron && (
                <svg className="os2-nav-chevron" viewBox="0 -960 960 960" width="16" height="16" fill="currentColor">
                  <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </nav>
    </aside>
  );
}
