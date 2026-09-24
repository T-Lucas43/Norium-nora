import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { ALL_EMOJIS, EMOJI_CATEGORIES } from "./emojiCatalog";

type TeamEmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
  title?: string;
};

export default function TeamEmojiPicker({ onSelect, onClose, title = "Escolher emoji" }: TeamEmojiPickerProps) {
  const [categoryId, setCategoryId] = useState(EMOJI_CATEGORIES[0].id);
  const [query, setQuery] = useState("");
  const selectedCategory = EMOJI_CATEGORIES.find((category) => category.id === categoryId) || EMOJI_CATEGORIES[0];
  const visibleEmojis = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return selectedCategory.emojis;
    const matchingCategories = EMOJI_CATEGORIES.filter((category) => category.label.toLocaleLowerCase("pt-BR").includes(normalized));
    if (matchingCategories.length) return matchingCategories.flatMap((category) => category.emojis);
    return ALL_EMOJIS.filter((emoji) => emoji.includes(query.trim()));
  }, [query, selectedCategory]);

  return (
    <section className="team-emoji-picker" role="dialog" aria-label={title}>
      <header>
        <strong>{title}</strong>
        {onClose && <button type="button" onClick={onClose} aria-label="Fechar emojis"><X size={16} /></button>}
      </header>
      <label className="team-emoji-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar categoria ou emoji" aria-label="Buscar emoji" />
      </label>
      <nav aria-label="Categorias de emojis">
        {EMOJI_CATEGORIES.map((category) => (
          <button key={category.id} type="button" className={category.id === categoryId && !query ? "is-active" : ""} onClick={() => { setCategoryId(category.id); setQuery(""); }} title={category.label} aria-label={category.label}>
            {category.icon}
          </button>
        ))}
      </nav>
      <div className="team-emoji-grid" role="listbox" aria-label={`${visibleEmojis.length} emojis disponíveis`}>
        {visibleEmojis.map((emoji, index) => (
          <button key={`${emoji}-${index}`} type="button" role="option" aria-label={`Emoji ${emoji}`} onClick={() => onSelect(emoji)}>{emoji}</button>
        ))}
        {!visibleEmojis.length && <p>Nenhum emoji encontrado.</p>}
      </div>
    </section>
  );
}
