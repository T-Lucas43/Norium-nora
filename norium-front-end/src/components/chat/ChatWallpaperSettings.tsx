import { ImagePlus, RotateCcw } from "lucide-react";
import { useRef } from "react";

import Button from "../shared/Button";
import type { ChatWallpaperPreference } from "./chatWallpaper";

interface ChatWallpaperSettingsProps {
  preference: ChatWallpaperPreference | null;
  saving: boolean;
  error?: string | null;
  onSelect: (file: File) => void | Promise<void>;
  onRestoreDefault: () => void;
}

export default function ChatWallpaperSettings({
  preference,
  saving,
  error,
  onSelect,
  onRestoreDefault,
}: ChatWallpaperSettingsProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3" aria-labelledby="chat-wallpaper-title">
      <div className="flex items-start gap-3">
        <div
          className="h-20 w-24 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] bg-cover bg-center"
          style={preference ? { backgroundImage: `linear-gradient(rgba(3,7,12,.36), rgba(3,7,12,.36)), url("${preference.dataUrl}")` } : undefined}
          data-testid="chat-wallpaper-preview"
        >
          {!preference && <div className="grid h-full place-items-center text-[var(--text-secondary)]"><ImagePlus size={22} /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <h4 id="chat-wallpaper-title" className="font-extrabold text-[var(--text)]">Fundo das conversas</h4>
          <p className="mt-1 text-[11px] font-medium leading-4 text-[var(--text-secondary)]">
            Escolha uma imagem da galeria. Ela aparece somente atrás das mensagens e fica salva para este usuário neste navegador.
          </p>
          {preference && <p className="mt-1 truncate text-[10px] text-[var(--primary)]" title={preference.fileName}>{preference.fileName}</p>}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        className="hidden"
        aria-label="Escolher imagem de fundo"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onSelect(file);
        }}
      />

      {error && <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={saving} onClick={() => inputRef.current?.click()}>
          <ImagePlus size={14} /> {preference ? "Trocar imagem" : "Escolher da galeria"}
        </Button>
        {preference && (
          <Button size="sm" variant="ghost" onClick={onRestoreDefault} title="Remover a imagem e voltar ao fundo padrão do Norium">
            <RotateCcw size={14} /> Restaurar padrão
          </Button>
        )}
      </div>
    </section>
  );
}
