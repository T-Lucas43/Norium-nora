interface EmailTabsProps {
  onSelectPhrase: (phrase: string) => void;
}

export default function EmailTabs({ onSelectPhrase }: EmailTabsProps) {
  const phrases = ["Obrigado, recebi!", "Tudo ótimo, vamos analisar.", "Pode me ligar mais tarde?"];

  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {phrases.map((phrase) => (
        <button
          key={phrase}
          onClick={() => onSelectPhrase(phrase)}
          className="text-xs font-semibold px-4 py-2 bg-[var(--card-background)] hover:bg-blue-500/10 border border-[var(--border)] hover:border-blue-500 text-[var(--secondary-foreground)] hover:text-blue-500 rounded-full transition shadow-sm"
        >
          {phrase}
        </button>
      ))}
    </div>
  );
}
