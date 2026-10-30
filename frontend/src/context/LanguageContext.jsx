import React, { createContext, useContext, useState, useEffect } from "react";
import { translations } from "../i18n/translations";

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem("geno_lang") || "vi";
    }
    return "vi";
  });

  const changeLanguage = (newLang) => {
    if (newLang === "vi" || newLang === "en") {
      setLang(newLang);
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem("geno_lang", newLang);
      }
    }
  };

  const toggleLanguage = () => {
    const next = lang === "vi" ? "en" : "vi";
    changeLanguage(next);
  };

  const t = (key) => {
    if (translations[lang] && translations[lang][key]) {
      return translations[lang][key];
    }
    if (translations.en && translations.en[key]) {
      return translations.en[key];
    }
    return key;
  };

  return (
    <LanguageContext.Provider value={{ lang, language: lang, changeLanguage, toggleLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return ctx;
}
