import { BadgeCheck, RadioTower, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { WhatsAppChannel } from "./whatsappApi";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

export interface WhatsAppChannelsViewProps {
  items: WhatsAppChannel[];
  loading: boolean;
  error?: string | null;
  onRefresh: () => void;
}

function searchValue(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

function channelInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "C";
}

function formatChannelTimestamp(timestamp?: number) {
  if (!timestamp) return "";
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ChannelAvatar({ channel, size = "md" }: { channel: WhatsAppChannel; size?: "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const photoUrl = useAuthenticatedMedia(channel.photoUrl);
  const dimension = size === "lg" ? "h-24 w-24 text-2xl" : "h-12 w-12 text-sm";

  return (
    <div
      className={`${dimension} grid shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-hover)] font-black text-[var(--primary)]`}
    >
      {photoUrl && !failed ? (
        <img
          src={photoUrl}
          alt={channel.name}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{channelInitials(channel.name)}</span>
      )}
    </div>
  );
}

export default function WhatsAppChannelsView({
  items,
  loading,
  error,
  onRefresh,
}: WhatsAppChannelsViewProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const normalizedQuery = searchValue(query);
  const filteredItems = useMemo(
    () =>
      items.filter((item) =>
        searchValue(`${item.name} ${item.description || ""}`).includes(normalizedQuery),
      ),
    [items, normalizedQuery],
  );
  const selected = items.find((item) => item.id === selectedId) || null;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 bg-[var(--background)]" aria-label="Canais do WhatsApp">
      <aside className="flex w-[360px] min-w-[300px] flex-col border-r border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h1 className="text-lg font-black text-[var(--text)]">Canais</h1>
            <p className="text-xs text-[var(--text-secondary)]">{"Atualiza\u00e7\u00f5es que voc\u00ea acompanha"}</p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="grid h-9 w-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
            aria-label="Atualizar canais"
            title="Atualizar canais"
          >
            <RefreshCw size={17} className={loading ? "animate-spin" : ""} />
          </button>
        </header>

        <div className="border-b border-[var(--border)] p-3">
          <label className="flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 focus-within:border-[var(--primary)]">
            <Search size={16} className="text-[var(--text-secondary)]" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Pesquisar canais"
              aria-label="Pesquisar canais"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-secondary)]"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && (
            <div role="alert" className="m-2 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
              <p>{error}</p>
              <button type="button" onClick={onRefresh} className="mt-2 font-bold text-[var(--text)] underline">
                Tentar novamente
              </button>
            </div>
          )}

          {loading && items.length === 0 ? (
            <div role="status" className="grid h-40 place-items-center text-sm text-[var(--text-secondary)]">
              Carregando canais...
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="grid h-40 place-items-center px-6 text-center text-sm text-[var(--text-secondary)]">
              {normalizedQuery ? "Nenhum canal encontrado para esta busca." : "Nenhum canal dispon\u00edvel."}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredItems.map((channel) => {
                const active = selectedId === channel.id;
                return (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => setSelectedId(channel.id)}
                    aria-label={`Abrir canal ${channel.name}`}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-3 rounded-xl p-3 text-left transition ${
                      active
                        ? "bg-[color-mix(in_srgb,var(--primary)_15%,transparent)]"
                        : "hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <ChannelAvatar channel={channel} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-bold text-[var(--text)]">{channel.name}</span>
                        {channel.verified && <BadgeCheck size={15} className="shrink-0 text-sky-400" aria-label="Verificado" />}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">
                        {channel.description || "Canal do WhatsApp"}
                      </span>
                    </span>
                    {Boolean(channel.unreadCount) && (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--primary)] px-1.5 text-[10px] font-black text-white">
                        {channel.unreadCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <div className="grid min-w-0 flex-1 place-items-center overflow-y-auto p-8">
        {selected ? (
          <article className="flex w-full max-w-xl flex-col items-center text-center">
            <ChannelAvatar channel={selected} size="lg" />
            <div className="mt-5 flex items-center gap-2">
              <h2 className="text-2xl font-black text-[var(--text)]">{selected.name}</h2>
              {selected.verified && <BadgeCheck size={20} className="text-sky-400" aria-hidden="true" />}
            </div>
            {selected.verified && <p className="mt-1 text-xs font-semibold text-sky-400">Canal verificado</p>}
            <p className="mt-5 max-w-md text-sm leading-6 text-[var(--text-secondary)]">
              {selected.description || "Este canal ainda n\u00e3o possui descri\u00e7\u00e3o."}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2 text-xs text-[var(--text-secondary)]">
              {Boolean(selected.unreadCount) && (
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
                  {selected.unreadCount} {selected.unreadCount === 1 ? "n\u00e3o lida" : "n\u00e3o lidas"}
                </span>
              )}
              {selected.timestamp && (
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
                  Atualizado em {formatChannelTimestamp(selected.timestamp)}
                </span>
              )}
            </div>
          </article>
        ) : (
          <div className="flex max-w-sm flex-col items-center text-center text-[var(--text-secondary)]">
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-[var(--surface)] text-[var(--primary)]">
              <RadioTower size={28} />
            </span>
            <h2 className="mt-4 text-lg font-bold text-[var(--text)]">Selecione um canal</h2>
            <p className="mt-1 text-sm">Escolha um canal na lista para ver seus detalhes.</p>
          </div>
        )}
      </div>
    </section>
  );
}
