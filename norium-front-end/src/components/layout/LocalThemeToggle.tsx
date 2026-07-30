import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { PerfilTema } from "../../types/omnichannel";
import { applyNoriumTheme } from "../../utils/theme";
import Button from "../shared/Button";

interface LocalThemeToggleProps {
  storageKey: string;
  label?: string;
  defaultTheme?: PerfilTema;
}

function readLocalTheme(storageKey: string, fallback: PerfilTema): PerfilTema {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "dark" || stored === "escuro") return "escuro";
    if (stored === "light" || stored === "claro") return "claro";
  } catch {
    // LocalStorage pode estar indisponivel em modo privado.
  }
  return fallback;
}

export default function LocalThemeToggle({ storageKey, label = "Tema", defaultTheme = "escuro" }: LocalThemeToggleProps) {
  const [theme, setTheme] = useState<PerfilTema>(() => readLocalTheme(storageKey, defaultTheme));
  const isDark = theme === "escuro";

  useEffect(() => {
    applyNoriumTheme(theme);
  }, [theme]);

  function toggleTheme() {
    const nextTheme: PerfilTema = isDark ? "claro" : "escuro";
    setTheme(nextTheme);
    localStorage.setItem(storageKey, nextTheme === "escuro" ? "dark" : "light");
  }

  return (
    <Button size="lg"
      onClick={toggleTheme}
      className="bg-[var(--background)] shadow-sm"
      aria-label={`Alternar ${label}`}
      title={`Alternar ${label}`}
    >
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-blue-500/16 text-[var(--primary)]">
        {isDark ? <Moon size={15} /> : <Sun size={15} />}
      </span>
      <span className="hidden sm:inline">{isDark ? "Escuro" : "Claro"}</span>
    </Button>
  );
}
