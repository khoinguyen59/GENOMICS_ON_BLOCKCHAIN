(function () {
  try {
    var raw = localStorage.getItem("geno_os2_theme");
    var t = raw === "light" || raw === "dark" ? raw : "light";
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add("theme-" + t);
    var savedLang = localStorage.getItem("geno_lang");
    document.documentElement.lang = savedLang === "en" ? "en" : "vi";
  } catch (e) {}
})();