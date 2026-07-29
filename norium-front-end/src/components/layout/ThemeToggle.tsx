import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { applyNoriumTheme, readStoredTheme, toggleNoriumTheme } from "../../utils/theme";

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const initialTheme = readStoredTheme();
    applyNoriumTheme(initialTheme);
    setDark(initialTheme === "escuro");

    function syncThemeState() {
      setDark(readStoredTheme() === "escuro");
    }

    window.addEventListener("norium-theme-change", syncThemeState);
    window.addEventListener("storage", syncThemeState);
    return () => {
      window.removeEventListener("norium-theme-change", syncThemeState);
      window.removeEventListener("storage", syncThemeState);
    };
  }, []);

  function toggleTheme() {
    const nextTheme = toggleNoriumTheme(dark ? "escuro" : "claro");
    setDark(nextTheme === "escuro");
  }

  return (
    <button
      onClick={toggleTheme}
      aria-label="Alternar tema"
      className="
        relative
        flex
        h-11
        w-20
        items-center
        rounded-full
        border
        border-[var(--border)]
        bg-[var(--surface)]
        px-1
        transition-all
        duration-300
        hover:scale-105
        active:scale-95
      "
    >
      <div
        className={`
          absolute
          top-1
          h-9
          w-9
          rounded-full
          bg-gradient-to-r
          from-blue-700
          to-cyan-500
          shadow-lg
          transition-all
          duration-300

          ${dark ? "left-[38px]" : "left-1"}
        `}
      />

      <div className="relative z-10 flex w-full justify-between px-1">
        <Sun
          size={17}
          className={dark ? "opacity-40" : "text-white"}
        />

        <Moon
          size={17}
          className={!dark ? "opacity-40" : "text-white"}
        />
      </div>
    </button>
  );
}
