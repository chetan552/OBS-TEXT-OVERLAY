// =============================================================================
// Theme renderer — shared by overlay.html, screen.html and the design page
// =============================================================================
// Turns a validated theme object into CSS custom properties. Keeping this in
// one file means the design page's live preview is driven by exactly the same
// code as the real overlay, so what you see is what OBS shows.
//
// Values arriving here have already been whitelisted server-side by
// lib/theme.js. This file assumes that and does no validation of its own.

(function (global) {
  "use strict";

  // Mirrors FONTS in lib/theme.js. Kept as a lookup so a page can resolve a
  // family id to a CSS stack and a Google Fonts spec without a round trip.
  var FONTS = {
    "Lato":              { stack: "Lato, sans-serif", spec: "Lato:wght@300;400;700" },
    "PT Sans Narrow":    { stack: '"PT Sans Narrow", sans-serif', spec: "PT+Sans+Narrow:wght@400;700" },
    "Oswald":            { stack: "Oswald, sans-serif", spec: "Oswald:wght@300;400;700" },
    "Bebas Neue":        { stack: '"Bebas Neue", sans-serif', spec: "Bebas+Neue" },
    "Montserrat":        { stack: "Montserrat, sans-serif", spec: "Montserrat:wght@300;400;700" },
    "Open Sans":         { stack: '"Open Sans", sans-serif', spec: "Open+Sans:wght@300;400;700" },
    "Roboto":            { stack: "Roboto, sans-serif", spec: "Roboto:wght@300;400;700" },
    "Inter":             { stack: "Inter, sans-serif", spec: "Inter:wght@300;400;700" },
    "Source Sans 3":     { stack: '"Source Sans 3", sans-serif', spec: "Source+Sans+3:wght@300;400;700" },
    "Merriweather":      { stack: "Merriweather, serif", spec: "Merriweather:wght@300;400;700" },
    "Playfair Display":  { stack: '"Playfair Display", serif', spec: "Playfair+Display:wght@400;700" },
    "Noto Serif":        { stack: '"Noto Serif", serif', spec: "Noto+Serif:wght@400;700" },
    "EB Garamond":       { stack: '"EB Garamond", serif', spec: "EB+Garamond:wght@400;700" },
    "system-sans":       { stack: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', spec: null },
    "system-serif":      { stack: 'Georgia, "Times New Roman", serif', spec: null },
  };

  function font(id) {
    return FONTS[id] || FONTS["Lato"];
  }

  /** #rrggbb + 0–1 alpha → an rgba() string. */
  function rgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  // ---- Google Fonts loading -------------------------------------------------
  // Only ever adds a stylesheet; never removes one. A page may cycle through
  // several fonts while the operator is designing, and dropping the old link
  // would make previously rendered text reflow for no reason.
  var loadedFonts = {};

  function ensureFont(id) {
    var spec = font(id).spec;
    if (!spec || loadedFonts[spec]) return;
    loadedFonts[spec] = true;

    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=" + spec + "&display=swap";
    document.head.appendChild(link);
  }

  // ---- Overlay --------------------------------------------------------------

  function applyOverlay(root, t) {
    ensureFont(t.fontFamily);

    var s = root.style;
    s.setProperty("--tp-font", font(t.fontFamily).stack);
    s.setProperty("--tp-font-size", t.fontSize + "px");
    s.setProperty("--tp-font-weight", t.fontWeight);
    s.setProperty("--tp-text-color", t.textColor);
    s.setProperty("--tp-text-transform", t.textTransform);
    s.setProperty("--tp-letter-spacing", t.letterSpacing + "px");

    s.setProperty("--tp-bar-color", rgba(t.barColor, t.barOpacity));
    s.setProperty("--tp-bar-height", t.barHeight + "px");
    s.setProperty("--tp-bar-max-width", t.barMaxWidth + "px");
    s.setProperty("--tp-pad-left", t.paddingLeft + "px");
    s.setProperty("--tp-pad-right", t.paddingRight + "px");
    s.setProperty("--tp-radius", t.cornerRadius + "px");
    s.setProperty("--tp-anim-ms", t.animationMs + "ms");

    // The angled cut points away from the anchored edge, so a right-anchored
    // bar mirrors the polygon rather than keeping a cut that points off-screen.
    var a = t.angleWidth + "px";
    s.setProperty(
      "--tp-clip",
      t.side === "right"
        ? "polygon(100% 0, 100% 100%, 0 100%, " + a + " 50%, 0 0)"
        : "polygon(100% 0, calc(100% - " + a + ") 50%, 100% 100%, 0 100%, 0 0)"
    );

    // Placement. Only the anchored side gets an offset; the opposite side is
    // left auto so the bar can grow with the text.
    s.setProperty("--tp-left", t.side === "left" ? t.offsetX + "px" : "auto");
    s.setProperty("--tp-right", t.side === "right" ? t.offsetX + "px" : "auto");

    if (t.vertical === "top") {
      s.setProperty("--tp-top", t.offsetY + "px");
      s.setProperty("--tp-bottom", "auto");
      s.setProperty("--tp-translate-y", "0");
    } else if (t.vertical === "bottom") {
      s.setProperty("--tp-top", "auto");
      s.setProperty("--tp-bottom", t.offsetY + "px");
      s.setProperty("--tp-translate-y", "0");
    } else {
      s.setProperty("--tp-top", "50%");
      s.setProperty("--tp-bottom", "auto");
      s.setProperty("--tp-translate-y", "-50%");
    }

    // The wrapper drives the reveal. Slide animates max-width from 0, which
    // needs overflow hidden; fade animates opacity and must not clip.
    root.setAttribute("data-tp-anim", t.animation);
    root.setAttribute("data-tp-side", t.side);
  }

  // ---- Screen ---------------------------------------------------------------

  function applyScreen(root, t) {
    ensureFont(t.fontFamily);

    var justify = { top: "flex-start", center: "center", bottom: "flex-end" }[t.verticalAlign];
    var alignItems = { left: "flex-start", center: "center", right: "flex-end" }[t.align];

    var s = root.style;
    s.setProperty("--tp-screen-font", font(t.fontFamily).stack);
    s.setProperty("--tp-screen-size", t.fontSize + "vw");
    s.setProperty("--tp-screen-weight", t.fontWeight);
    s.setProperty("--tp-screen-color", t.textColor);
    s.setProperty("--tp-screen-transform", t.textTransform);
    s.setProperty("--tp-screen-spacing", t.letterSpacing + "rem");
    s.setProperty("--tp-screen-line", t.lineHeight);
    s.setProperty("--tp-screen-bg", t.backgroundColor);
    s.setProperty("--tp-screen-pad", t.padding + "px");
    s.setProperty("--tp-screen-text-align", t.align);
    s.setProperty("--tp-screen-justify", justify);
    s.setProperty("--tp-screen-align", alignItems);
    s.setProperty("--tp-screen-fade", t.fadeMs + "ms");
  }

  global.TPTheme = {
    FONTS: FONTS,
    font: font,
    rgba: rgba,
    ensureFont: ensureFont,
    applyOverlay: applyOverlay,
    applyScreen: applyScreen,
  };
})(window);
