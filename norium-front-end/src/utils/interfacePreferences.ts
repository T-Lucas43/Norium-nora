export type InterfacePreferences = {
  textSize: "normal" | "large" | "extra";
  reducedMotion: boolean;
  strongFocus: boolean;
  underlineLinks: boolean;
  showGuides: boolean;
  showToasts: boolean;
  toastPreview: boolean;
  toastPosition: "top" | "bottom";
};

export const defaultInterfacePreferences: InterfacePreferences = {
  textSize: "normal",
  reducedMotion: false,
  strongFocus: false,
  underlineLinks: false,
  showGuides: true,
  showToasts: true,
  toastPreview: true,
  toastPosition: "top",
};

export function applyInterfacePreferences(value?: Partial<InterfacePreferences>) {
  const preferences = { ...defaultInterfacePreferences, ...value };
  const root = document.documentElement;
  root.style.fontSize = { normal: "16px", large: "18px", extra: "20px" }[preferences.textSize] || "16px";
  root.dataset.reducedMotion = String(preferences.reducedMotion);
  root.dataset.strongFocus = String(preferences.strongFocus);
  root.dataset.underlineLinks = String(preferences.underlineLinks);
}
