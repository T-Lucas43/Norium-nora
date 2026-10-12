import { defaultInterfacePreferences } from "../../utils/interfacePreferences";
import type { PerfilOperador, TemaPersonalizado } from "../../types/omnichannel";
import { apiBaseUrl } from "../../utils/api";
import { defaultThemeCustomization } from "../../utils/theme";

const API_URL = `${apiBaseUrl()}/api/perfil`;

function cloneThemeCustomization(): TemaPersonalizado {
  return JSON.parse(JSON.stringify(defaultThemeCustomization)) as TemaPersonalizado;
}

export function createDefaultProfile(): PerfilOperador {
  return {
    interface_preferences: { ...defaultInterfacePreferences },
    fotoUrl: "",
    nome: "Operador",
    cep: "",
    idioma: "pt-BR",
    tema: "escuro",
    tema_personalizado: cloneThemeCustomization(),
    configuracoes_nora: {
      sarcasmo: 65,
    },
  };
}

export function normalizeProfile(profile: PerfilOperador): PerfilOperador {
  const defaults = createDefaultProfile();
  const customDefaults = cloneThemeCustomization();
  const custom = profile.tema_personalizado || customDefaults;

  return {
    ...defaults,
    ...profile,
    interface_preferences: { ...defaultInterfacePreferences, ...profile.interface_preferences },
    tema_personalizado: {
      enabled: Boolean(custom.enabled),
      claro: { ...customDefaults.claro, ...(custom.claro || {}) },
      escuro: { ...customDefaults.escuro, ...(custom.escuro || {}) },
    },
    configuracoes_nora: {
      ...defaults.configuracoes_nora,
      ...(profile.configuracoes_nora || {}),
    },
  };
}

export async function loadOperatorProfile(userId: string): Promise<PerfilOperador> {
  const params = new URLSearchParams({ user_id: userId });
  const response = await fetch(`${API_URL}?${params.toString()}`);
  if (!response.ok) throw new Error("Não foi possível carregar os dados do operador.");
  return normalizeProfile((await response.json()) as PerfilOperador);
}

export async function saveOperatorProfile(
  userId: string,
  profile: PerfilOperador,
): Promise<PerfilOperador> {
  const params = new URLSearchParams({ user_id: userId });
  const response = await fetch(`${API_URL}?${params.toString()}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.detail || "Não foi possível salvar as alterações.");
  }

  return normalizeProfile((await response.json()) as PerfilOperador);
}

export function imageFileToProfileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Escolha uma imagem da galeria."));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Não foi possível abrir a imagem."));
      image.onload = () => {
        const maxSize = 720;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");

        if (!context) {
          reject(new Error("Não foi possível preparar a imagem."));
          return;
        }

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.94));
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}
