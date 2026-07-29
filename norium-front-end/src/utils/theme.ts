import type { PerfilTema, TemaCores, TemaPersonalizado } from "../types/omnichannel";

export const defaultThemeCustomization: TemaPersonalizado = {
  enabled: false,
  claro: {
    primary: "#2563EB",
    primaryStrong: "#0284C7",
    primaryDeep: "#1D4ED8",
    onPrimary: "#FFFFFF",
    gradientStart: "#944AF7",
    gradientMiddle: "#2563EB",
    gradientEnd: "#0EA5E9",
    background: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceHover: "#FFFFFF",
    border: "#FFFFFF",
    text: "#0B234A",
    textSecondary: "#46607F",
    success: "#10B981",
    warning: "#F59E0B",
    danger: "#EF4444",
  },
  escuro: {
    primary: "#BAE6FD",
    primaryStrong: "#67E8F9",
    primaryDeep: "#1D4ED8",
    onPrimary: "#FFFFFF",
    gradientStart: "#2A0B5E",
    gradientMiddle: "#1D1B83",
    gradientEnd: "#0284C7",
    background: "#04123A",
    surface: "#082360",
    surfaceHover: "#124E9C",
    border: "#BAE6FD",
    text: "#FFFFFF",
    textSecondary: "#E2F2FF",
    success: "#34D399",
    warning: "#FBBF24",
    danger: "#FB7185",
  },
};

const CUSTOM_THEME_VARS = [
  "--app-background",
  "--app-overlay",
  "--background",
  "--screen-background",
  "--surface",
  "--surface-hover",
  "--border",
  "--primary",
  "--primary-strong",
  "--primary-deep",
  "--on-primary",
  "--text",
  "--text-primary",
  "--text-secondary",
  "--success",
  "--warning",
  "--danger",
  "--dashboard-hero-bg",
  "--dashboard-nora-bg",
  "--dashboard-panel-border",
  "--dashboard-chip-bg",
  "--dashboard-tile-bg",
  "--dashboard-tile-hover",
  "--dashboard-primary-action-bg",
  "--dashboard-primary-action-hover",
  "--dashboard-secondary-action-bg",
  "--dashboard-secondary-action-hover",
  "--dashboard-glow-cyan",
  "--dashboard-glow-blue",
  "--motion-stream",
  "--theme-gradient",
  "--theme-gradient-hover",
  "--theme-soft",
  "--theme-soft-hover",
  "--theme-border",
  "--theme-text",
  "--theme-text-soft",
  "--theme-on-primary",
  "--theme-success",
  "--theme-success-soft",
  "--theme-success-border",
  "--theme-warning",
  "--theme-warning-soft",
  "--theme-warning-border",
  "--theme-danger",
  "--theme-danger-soft",
  "--theme-danger-border",
];

function normalizeHex(value: string | undefined, fallback: string) {
  const raw = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : fallback;
}

function hexToRgb(hex: string) {
  const normalized = normalizeHex(hex, "#2563EB").slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function normalizedPalette(theme: PerfilTema, customization: TemaPersonalizado): TemaCores {
  const fallback = defaultThemeCustomization[theme];
  const palette = customization[theme] || fallback;
  return {
    primary: normalizeHex(palette.primary, fallback.primary),
    primaryStrong: normalizeHex(palette.primaryStrong, fallback.primaryStrong),
    primaryDeep: normalizeHex(palette.primaryDeep, fallback.primaryDeep),
    onPrimary: normalizeHex(palette.onPrimary, fallback.onPrimary),
    gradientStart: normalizeHex(palette.gradientStart, fallback.gradientStart),
    gradientMiddle: normalizeHex(palette.gradientMiddle, fallback.gradientMiddle),
    gradientEnd: normalizeHex(palette.gradientEnd, fallback.gradientEnd),
    background: normalizeHex(palette.background, fallback.background),
    surface: normalizeHex(palette.surface, fallback.surface),
    surfaceHover: normalizeHex(palette.surfaceHover, fallback.surfaceHover),
    border: normalizeHex(palette.border, fallback.border),
    text: normalizeHex(palette.text, fallback.text),
    textSecondary: normalizeHex(palette.textSecondary, fallback.textSecondary),
    success: normalizeHex(palette.success, fallback.success),
    warning: normalizeHex(palette.warning, fallback.warning),
    danger: normalizeHex(palette.danger, fallback.danger),
  };
}

function clearCustomThemeVars() {
  const root = document.documentElement;
  CUSTOM_THEME_VARS.forEach((name) => root.style.removeProperty(name));
  root.removeAttribute("data-norium-custom-theme");
}

function applyCustomTheme(theme: PerfilTema, customization?: TemaPersonalizado | null) {
  clearCustomThemeVars();
  if (!customization?.enabled) return;

  const root = document.documentElement;
  const palette = normalizedPalette(theme, customization);
  const dark = theme === "escuro";
  const surface = palette.surface;
  const start = palette.gradientStart;
  const middle = palette.gradientMiddle;
  const end = palette.gradientEnd;

  root.setAttribute("data-norium-custom-theme", "true");
  root.style.setProperty("--primary", palette.primary);
  root.style.setProperty("--primary-strong", palette.primaryStrong);
  root.style.setProperty("--primary-deep", palette.primaryDeep);
  root.style.setProperty("--on-primary", palette.onPrimary);
  root.style.setProperty("--text", palette.text);
  root.style.setProperty("--text-primary", palette.text);
  root.style.setProperty("--text-secondary", rgba(palette.textSecondary, dark ? 0.84 : 0.76));
  root.style.setProperty("--success", palette.success);
  root.style.setProperty("--warning", palette.warning);
  root.style.setProperty("--danger", palette.danger);
  root.style.setProperty("--theme-gradient", `linear-gradient(135deg, ${start} 0%, ${middle} 56%, ${end} 100%)`);
  root.style.setProperty("--theme-gradient-hover", `linear-gradient(135deg, ${palette.primaryDeep} 0%, ${palette.primaryStrong} 58%, ${end} 100%)`);
  root.style.setProperty("--theme-soft", rgba(palette.primaryStrong, dark ? 0.16 : 0.14));
  root.style.setProperty("--theme-soft-hover", rgba(palette.primaryStrong, dark ? 0.24 : 0.22));
  root.style.setProperty("--theme-border", rgba(palette.border, dark ? 0.35 : 0.34));
  root.style.setProperty("--theme-text", dark ? palette.primary : palette.primaryDeep);
  root.style.setProperty("--theme-text-soft", dark ? palette.primaryStrong : palette.primaryDeep);
  root.style.setProperty("--theme-on-primary", palette.onPrimary);
  root.style.setProperty("--theme-success", palette.success);
  root.style.setProperty("--theme-success-soft", rgba(palette.success, dark ? 0.18 : 0.14));
  root.style.setProperty("--theme-success-border", rgba(palette.success, dark ? 0.38 : 0.32));
  root.style.setProperty("--theme-warning", palette.warning);
  root.style.setProperty("--theme-warning-soft", rgba(palette.warning, dark ? 0.18 : 0.14));
  root.style.setProperty("--theme-warning-border", rgba(palette.warning, dark ? 0.38 : 0.32));
  root.style.setProperty("--theme-danger", palette.danger);
  root.style.setProperty("--theme-danger-soft", rgba(palette.danger, dark ? 0.18 : 0.14));
  root.style.setProperty("--theme-danger-border", rgba(palette.danger, dark ? 0.38 : 0.32));
  root.style.setProperty(
    "--app-background",
    dark
      ? `radial-gradient(circle at 0% 0%, ${rgba(start, 0.58)} 0, ${rgba(start, 0.34)} 22%, transparent 48%), radial-gradient(circle at 100% 0%, ${rgba(end, 0.32)} 0, ${rgba(middle, 0.20)} 26%, transparent 44%), linear-gradient(135deg, ${start} 0%, ${middle} 42%, ${end} 100%)`
      : `radial-gradient(circle at 4% 0%, ${rgba(start, 0.72)} 0, ${rgba(start, 0.34)} 18%, transparent 42%), radial-gradient(circle at 100% 4%, ${rgba(end, 0.38)} 0, transparent 36%), linear-gradient(135deg, ${start} 0%, ${middle} 42%, ${end} 100%)`,
  );
  root.style.setProperty(
    "--app-overlay",
    dark
      ? `linear-gradient(180deg, rgba(0,0,0,.26), rgba(0,0,0,.08) 30%, rgba(0,0,0,.18)), radial-gradient(circle at 50% 110%, ${rgba(start, 0.22)}, transparent 54%)`
      : `linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,0) 22%), radial-gradient(circle at 50% 120%, ${rgba(middle, 0.24)}, transparent 48%)`,
  );
  root.style.setProperty("--background", rgba(palette.background, dark ? 0.58 : 0.28));
  root.style.setProperty(
    "--screen-background",
    `linear-gradient(180deg, ${rgba(palette.background, dark ? 0.16 : 0.10)}, ${rgba(palette.background, dark ? 0.30 : 0.18)})`,
  );
  root.style.setProperty("--surface", rgba(surface, dark ? 0.48 : 0.52));
  root.style.setProperty("--surface-hover", rgba(palette.surfaceHover, dark ? 0.58 : 0.66));
  root.style.setProperty("--border", rgba(palette.border, dark ? 0.27 : 0.62));
  root.style.setProperty(
    "--dashboard-hero-bg",
    dark
      ? `linear-gradient(135deg, ${rgba(start, 0.84)} 0%, ${rgba(middle, 0.70)} 52%, ${rgba(end, 0.58)} 100%)`
      : `linear-gradient(135deg, ${rgba(surface, 0.46)} 0%, ${rgba(surface, 0.34)} 52%, ${rgba(surface, 0.26)} 100%)`,
  );
  root.style.setProperty(
    "--dashboard-nora-bg",
    dark
      ? `linear-gradient(135deg, ${rgba(start, 0.82)} 0%, ${rgba(middle, 0.66)} 54%, ${rgba(end, 0.56)} 100%)`
      : `linear-gradient(135deg, ${rgba(surface, 0.48)} 0%, ${rgba(surface, 0.36)} 54%, ${rgba(surface, 0.28)} 100%)`,
  );
  root.style.setProperty("--dashboard-panel-border", rgba(dark ? palette.primary : surface, dark ? 0.16 : 0.64));
  root.style.setProperty("--dashboard-chip-bg", rgba(surface, dark ? 0.28 : 0.42));
  root.style.setProperty("--dashboard-tile-bg", rgba(surface, dark ? 0.32 : 0.44));
  root.style.setProperty("--dashboard-tile-hover", rgba(surface, dark ? 0.40 : 0.58));
  root.style.setProperty("--dashboard-primary-action-bg", rgba(palette.primaryDeep, dark ? 0.54 : 0.58));
  root.style.setProperty("--dashboard-primary-action-hover", rgba(palette.primaryDeep, dark ? 0.64 : 0.68));
  root.style.setProperty("--dashboard-secondary-action-bg", rgba(surface, dark ? 0.28 : 0.42));
  root.style.setProperty("--dashboard-secondary-action-hover", rgba(surface, dark ? 0.38 : 0.58));
  root.style.setProperty("--dashboard-glow-cyan", rgba(end, dark ? 0.12 : 0.20));
  root.style.setProperty("--dashboard-glow-blue", rgba(middle, dark ? 0.34 : 0.18));
  root.style.setProperty(
    "--motion-stream",
    `linear-gradient(112deg, transparent 0%, ${rgba(palette.primary, dark ? 0.20 : 0.30)} 18%, transparent 36%), linear-gradient(68deg, transparent 0%, ${rgba(end, dark ? 0.18 : 0.20)} 28%, transparent 54%)`,
  );
}

export function normalizeTheme(theme: string | null | undefined): PerfilTema {
  if (theme === "light" || theme === "claro") return "claro";
  return "escuro";
}

export function readStoredTheme(): PerfilTema {
  const stored = localStorage.getItem("norium-theme");
  if (stored === "dark" || stored === "escuro") return "escuro";
  if (stored === "light" || stored === "claro") return "claro";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "escuro" : "claro";
}

export function applyNoriumTheme(theme: PerfilTema, customization?: TemaPersonalizado | null) {
  const isDark = theme === "escuro";
  document.documentElement.classList.toggle("dark", isDark);
  applyCustomTheme(theme, customization);
  localStorage.setItem("norium-theme", isDark ? "dark" : "light");
  window.dispatchEvent(new CustomEvent("norium-theme-change", { detail: { theme, customization } }));
}

export function toggleNoriumTheme(current: PerfilTema): PerfilTema {
  const next = current === "escuro" ? "claro" : "escuro";
  applyNoriumTheme(next);
  return next;
}
