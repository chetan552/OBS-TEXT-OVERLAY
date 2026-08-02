// =============================================================================
// Theme schema — per-channel appearance for the overlay and screen pages
// =============================================================================
// The DEFAULTS below are the original hard-coded design, value for value.
// "Reset to default" restores exactly this, so a church can always get back
// to the look it started with.
//
// Everything here is untrusted input that ends up in CSS custom properties,
// so sanitize() is a whitelist, not a filter: unknown keys are dropped,
// numbers are clamped to a range, colors must match a strict hex pattern,
// and fonts and enums must be members of a fixed list. Nothing a user types
// can reach the page as arbitrary CSS.

// ---- Fonts ------------------------------------------------------------------
// Each entry is loadable from Google Fonts except the two system stacks.
// `spec` is the Google Fonts family query; null means no download needed.
const FONTS = [
  { id: "Lato", label: "Lato", spec: "Lato:wght@300;400;700", stack: "Lato, sans-serif" },
  { id: "PT Sans Narrow", label: "PT Sans Narrow", spec: "PT+Sans+Narrow:wght@400;700", stack: '"PT Sans Narrow", sans-serif' },
  { id: "Oswald", label: "Oswald", spec: "Oswald:wght@300;400;700", stack: "Oswald, sans-serif" },
  { id: "Bebas Neue", label: "Bebas Neue", spec: "Bebas+Neue", stack: '"Bebas Neue", sans-serif' },
  { id: "Montserrat", label: "Montserrat", spec: "Montserrat:wght@300;400;700", stack: "Montserrat, sans-serif" },
  { id: "Open Sans", label: "Open Sans", spec: "Open+Sans:wght@300;400;700", stack: '"Open Sans", sans-serif' },
  { id: "Roboto", label: "Roboto", spec: "Roboto:wght@300;400;700", stack: "Roboto, sans-serif" },
  { id: "Inter", label: "Inter", spec: "Inter:wght@300;400;700", stack: "Inter, sans-serif" },
  { id: "Source Sans 3", label: "Source Sans 3", spec: "Source+Sans+3:wght@300;400;700", stack: '"Source Sans 3", sans-serif' },
  { id: "Merriweather", label: "Merriweather (serif)", spec: "Merriweather:wght@300;400;700", stack: "Merriweather, serif" },
  { id: "Playfair Display", label: "Playfair Display (serif)", spec: "Playfair+Display:wght@400;700", stack: '"Playfair Display", serif' },
  { id: "Noto Serif", label: "Noto Serif", spec: "Noto+Serif:wght@400;700", stack: '"Noto Serif", serif' },
  { id: "EB Garamond", label: "EB Garamond (serif)", spec: "EB+Garamond:wght@400;700", stack: '"EB Garamond", serif' },
  { id: "system-sans", label: "System sans-serif", spec: null, stack: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { id: "system-serif", label: "System serif", spec: null, stack: 'Georgia, "Times New Roman", serif' },
];

const FONT_IDS = FONTS.map((f) => f.id);

// ---- Field definitions ------------------------------------------------------
// Types: color (#rrggbb), number (min/max, optional step), enum, bool, font.

const OVERLAY_FIELDS = {
  // Text
  fontFamily:     { type: "font",   default: "Lato" },
  fontSize:       { type: "number", default: 44,  min: 12, max: 160, unit: "px" },
  fontWeight:     { type: "enum",   default: "400", values: ["300", "400", "700"] },
  textColor:      { type: "color",  default: "#ffffff" },
  textTransform:  { type: "enum",   default: "none", values: ["none", "uppercase", "capitalize"] },
  letterSpacing:  { type: "number", default: 0,   min: -5, max: 20, step: 0.5, unit: "px" },

  // Bar
  barColor:       { type: "color",  default: "#2b404e" },
  barOpacity:     { type: "number", default: 0.9, min: 0,  max: 1,   step: 0.05 },
  barHeight:      { type: "number", default: 100, min: 40, max: 300, unit: "px" },
  barMaxWidth:    { type: "number", default: 900, min: 200, max: 1920, unit: "px" },
  paddingLeft:    { type: "number", default: 40,  min: 0,  max: 200, unit: "px" },
  paddingRight:   { type: "number", default: 64,  min: 0,  max: 200, unit: "px" },
  angleWidth:     { type: "number", default: 24,  min: 0,  max: 120, unit: "px" },
  cornerRadius:   { type: "number", default: 0,   min: 0,  max: 60,  unit: "px" },

  // Placement on the 1920×1080 canvas
  side:           { type: "enum",   default: "left", values: ["left", "right"] },
  vertical:       { type: "enum",   default: "top",  values: ["top", "center", "bottom"] },
  offsetX:        { type: "number", default: 0,   min: 0, max: 800, unit: "px" },
  offsetY:        { type: "number", default: 0,   min: 0, max: 800, unit: "px" },

  // Motion
  animation:      { type: "enum",   default: "slide", values: ["slide", "fade", "none"] },
  animationMs:    { type: "number", default: 300, min: 0, max: 2000, step: 50, unit: "ms" },
};

const SCREEN_FIELDS = {
  // Text
  fontFamily:     { type: "font",   default: "PT Sans Narrow" },
  fontSize:       { type: "number", default: 8,   min: 2,  max: 20, step: 0.25, unit: "vw" },
  fontWeight:     { type: "enum",   default: "700", values: ["300", "400", "700"] },
  textColor:      { type: "color",  default: "#ffffff" },
  textTransform:  { type: "enum",   default: "uppercase", values: ["none", "uppercase", "capitalize"] },
  letterSpacing:  { type: "number", default: 0.25, min: -0.1, max: 2, step: 0.05, unit: "rem" },
  lineHeight:     { type: "number", default: 1.167, min: 0.8, max: 3, step: 0.033 },

  // Page
  backgroundColor: { type: "color", default: "#2b404e" },
  padding:        { type: "number", default: 64, min: 0, max: 300, unit: "px" },
  align:          { type: "enum",   default: "center", values: ["left", "center", "right"] },
  verticalAlign:  { type: "enum",   default: "center", values: ["top", "center", "bottom"] },

  // Motion
  fadeMs:         { type: "number", default: 500, min: 0, max: 2000, step: 50, unit: "ms" },
};

const SECTIONS = { overlay: OVERLAY_FIELDS, screen: SCREEN_FIELDS };

// ---- Defaults ---------------------------------------------------------------

function defaultsFor(fields) {
  const out = {};
  for (const [key, spec] of Object.entries(fields)) out[key] = spec.default;
  return out;
}

/** The original design, exactly as it shipped. */
function defaultTheme() {
  return { overlay: defaultsFor(OVERLAY_FIELDS), screen: defaultsFor(SCREEN_FIELDS) };
}

// ---- Sanitizing -------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function sanitizeValue(spec, raw) {
  switch (spec.type) {
    case "color":
      return typeof raw === "string" && HEX_COLOR.test(raw) ? raw.toLowerCase() : spec.default;

    case "number": {
      const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
      if (!Number.isFinite(n)) return spec.default;
      // Clamp rather than reject: a slider that overshoots should land at the
      // limit, not silently snap back to the default.
      const clamped = Math.min(spec.max, Math.max(spec.min, n));
      return Math.round(clamped * 1000) / 1000;
    }

    case "enum":
      return spec.values.includes(String(raw)) ? String(raw) : spec.default;

    case "font":
      return FONT_IDS.includes(raw) ? raw : spec.default;

    case "bool":
      return Boolean(raw);

    default:
      return spec.default;
  }
}

/**
 * Coerce arbitrary input into a complete, valid theme. Missing sections and
 * keys fall back to the default, so a partial patch from the design page is
 * always safe to store.
 */
function sanitizeTheme(input) {
  const source = input && typeof input === "object" ? input : {};
  const out = {};

  for (const [section, fields] of Object.entries(SECTIONS)) {
    const given = source[section] && typeof source[section] === "object" ? source[section] : {};
    out[section] = {};
    for (const [key, spec] of Object.entries(fields)) {
      out[section][key] = sanitizeValue(spec, given[key]);
    }
  }

  return out;
}

/** True when a theme is identical to the shipped design. */
function isDefaultTheme(theme) {
  return JSON.stringify(sanitizeTheme(theme)) === JSON.stringify(defaultTheme());
}

/** Font metadata for one section's chosen family, for the client to load. */
function fontFor(id) {
  return FONTS.find((f) => f.id === id) || FONTS[0];
}

module.exports = {
  FONTS,
  SECTIONS,
  OVERLAY_FIELDS,
  SCREEN_FIELDS,
  defaultTheme,
  sanitizeTheme,
  isDefaultTheme,
  fontFor,
};
