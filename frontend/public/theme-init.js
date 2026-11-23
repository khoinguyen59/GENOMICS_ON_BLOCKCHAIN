(function () {
  try {
    var raw = localStorage.getItem("geno_os2_theme");
    var t = raw === "light" || raw === "dark" ? raw : "light";
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add("theme-" + t);
  } catch (e) {}
})();