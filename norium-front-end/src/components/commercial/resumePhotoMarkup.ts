import type { Branding } from "../../features/commercial/types";

export function resumePhotoMarkup(branding: Branding) {
  if (!branding.logoUrl.startsWith("data:image/")) return "";
  const size = Math.max(30, Math.min(180, Number(branding.logoScale) || 100));
  const justifyContent = branding.logoAlignment === "left" ? "flex-start" : branding.logoAlignment === "center" ? "center" : "flex-end";
  return `<div data-document-decoration contenteditable="false" style="display:flex;justify-content:${justifyContent};margin-bottom:20px"><img src="${branding.logoUrl.replaceAll('"', "&quot;")}" alt="Foto do currículo" style="width:${size}px;height:${size}px;border-radius:999px;object-fit:cover;border:5px solid ${branding.secondaryColor}" /></div>`;
}
