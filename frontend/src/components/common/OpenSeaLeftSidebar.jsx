import React from "react";
import { useWeb3 } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import { GenoLogoIcon } from "../icons/GenoIcons";

/**
 * GenoChain Collapsible Navigation Rail (52px collapsed -> 220px expanded on hover)
 */
export default function OpenSeaLeftSidebar({ activeNav, onSelectNav }) {
  const {
    userRole,
    setUserRole,
    donorTab,
    setDonorTab,
    researcherTab,
    setResearcherTab,
    setShowIpfsSettings
  } = useWeb3();
  const { t } = useLanguage();
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
      case "admin":
        setUserRole("admin");
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "settings":
        setShowIpfsSettings(true);
        break;
      default:
        break;
    }
  };

  const currentActive =
    activeNav ||
    (userRole === "admin"
      ? "admin"
      : userRole === "donor"
        ? donorTab === "vault"
          ? "profile"
          : "studio"
        : researcherTab === "licensed"
          ? "tools"
          : "discover");

  const primaryItems = [
    {
      id: "discover",
      label: t("navDiscover"),
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="m260-260 300-140 140-300-300 140-140 300Zm220-180q-17 0-28.5-11.5T440-480q0-17 11.5-28.5T480-520q17 0 28.5 11.5T520-480q0 17-11.5 28.5T480-440Zm0 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
        </svg>
      )
    },
    {
      id: "collections",
      label: t("navCollections"),
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M440-120H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h240v720Zm-80-80v-560H200v560h160Zm160-320v-320h240q33 0 56.5 23.5T840-760v240H520Zm80-80h160v-160H600v160Zm-80 480v-320h320v240q0 33-23.5 56.5T760-120H520Zm80-80h160v-160H600v160ZM360-480Zm240-120Zm0 240Z" />
        </svg>
      )
    },
    {
      id: "activity",
      label: t("navActivity"),
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M100-180v-121.54h121.54V-180H100Zm216.92 0v-121.54H860V-180H316.92ZM100-419.23v-121.54h121.54v121.54H100Zm216.92 0v-121.54H860v121.54H316.92ZM100-658.46V-780h121.54v121.54H100Zm216.92 0V-780H860v121.54H316.92Z" />
        </svg>
      )
    },
    {
      id: "tools",
      label: t("navTools"),
      badge: purchasedData.length > 0 ? String(purchasedData.length) : null,
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="m422-232 207-248H469l29-227-185 267h139l-30 208ZM320-80l40-280H160l360-520h80l-40 320h240L400-80h-80Zm151-390Z" />
        </svg>
      )
    },
    {
      id: "studio",
      label: t("navStudioNav"),
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M160-120v-170l527-526q12-12 27-18t30-6q16 0 30.5 6t25.5 18l56 56q12 11 18 25.5t6 30.5q0 15-6 30t-18 27L330-120H160Zm80-80h56l393-392-28-29-29-28-392 393v56Zm560-503-57-57 57 57Zm-139 82-29-28 57 57-28-29ZM560-120q74 0 137-37t63-103q0-36-19-62t-51-45l-59 59q23 10 36 22t13 26q0 23-36.5 41.5T560-200q-17 0-28.5 11.5T520-160q0 17 11.5 28.5T560-120ZM183-426l60-60q-20-8-31.5-16.5T200-520q0-12 18-24t76-37q88-38 117-69t29-70q0-55-44-87.5T280-840q-45 0-80.5 16T145-785q-11 13-9 29t15 26q13 11 29 9t27-13q14-14 31-20t42-6q41 0 60.5 12t19.5 28q0 14-17.5 25.5T262-654q-80 35-111 63.5T120-520q0 32 17 54.5t46 39.5Z" />
        </svg>
      )
    },
    {
      id: "profile",
      label: t("navProfile"),
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M234-276q51-39 114-61.5T480-360q69 0 132 22.5T726-276q35-41 54.5-93T800-480q0-133-93.5-226.5T480-800q-133 0-226.5 93.5T160-480q0 59 19.5 111t54.5 93Zm246-164q-59 0-99.5-40.5T340-580q0-59 40.5-99.5T480-720q59 0 99.5 40.5T620-580q0 59-40.5 99.5T480-440Zm0 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
        </svg>
      )
    },
    {
      id: "admin",
      label: t("navAdmin"),
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="M480-80q-139-35-229.5-159.5T160-516v-244l320-120 320 120v244q0 152-90.5 276.5T480-80Zm0-84q104-33 172-132t68-220v-189l-240-90-240 90v189q0 121 68 220t172 132Zm0-316Z" />
        </svg>
      )
    }
  ];

  const secondaryItems = [
    {
      id: "settings",
      label: t("navSettings"),
      svg: (
        <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
          <path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z" />
        </svg>
      )
    }
  ];

  return (
    <aside className="os2-left-sidebar" aria-label="GenoChain Primary Navigation">
      <nav className="os2-left-nav">
        {/* Top Brand Row: GenoChain Helix Emblem + Wordmark on Hover */}
        <button
          type="button"
          className="os2-brand-btn"
          onClick={() => handleNavClick("discover")}
          title="GenoChain - DeSci Genomic Data Exchange"
        >
          <span className="os2-brand-logo-wrap">
            <GenoLogoIcon size={26} color="#0284c7" />
          </span>
          <span className="os2-brand-wordmark">GenoChain</span>
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
              className={`os2-nav-item ${currentActive === item.id ? "active" : ""}`}
              onClick={() => handleNavClick(item.id)}
              title={item.label}
            >
              <span className="os2-nav-icon">{item.svg}</span>
              <span className="os2-nav-label">
                <span>{item.label}</span>
              </span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  );
}
