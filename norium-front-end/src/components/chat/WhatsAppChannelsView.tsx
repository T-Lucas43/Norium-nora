import { BadgeCheck, FileText, RadioTower, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { MsgConteudo } from "./types";
import type { WhatsAppChannel } from "./whatsappApi";
import { useAuthenticatedMedia, useAuthenticatedMediaState } from "./useAuthenticatedMedia";

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

function ChannelMessageMedia({ message }: { message: MsgConteudo }) {
  const media = useAuthenticatedMediaState(message.viewOnce ? undefined : message.arquivoUrl);
  const [nativeError, setNativeError] = useState(false);
  const [nativeAttempt, setNativeAttempt] = useState(0);
  const retry = () => {
    setNativeError(false);
    setNativeAttempt((current) => current + 1);
    media.retry();
  };

  if (message.viewOnce) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] p-4 text-sm text-[var(--text-secondary)]">
        {"M\u00eddia de visualiza\u00e7\u00e3o \u00fanica indispon\u00edvel."}
      </div>
    );
  }
  if (!message.arquivoUrl) return null;
  if (media.loading) {
    return (
      <div className="rounded-xl bg-[var(--surface-hover)] p-4 text-sm text-[var(--text-secondary)]">
        {"Carregando m\u00eddia..."}
      </div>
    );
  }
  if (media.error || nativeError || !media.source) {
    return (
      <div className="rounded-lg bg-[var(--nx-danger-soft)] p-4 text-sm text-[var(--nx-danger)]">
        <p>{"M\u00eddia indispon\u00edvel."}</p>
        <button type="button" onClick={retry} className="mt-2 font-bold underline">
          Tentar novamente
        </button>
      </div>
    );
  }

  const mime = (message.arquivoMime || "").toLowerCase();
  const mediaType = String(message.midiaMeta?.type || "").toLowerCase();
  const label = message.texto || message.nomeArquivo || "M\u00eddia do canal";
  if (message.tipo === "audio" || mime.startsWith("audio/")) {
    return (
      <audio
        key={nativeAttempt}
        controls
        preload="metadata"
        src={media.source}
        className="w-full"
        aria-label={label}
        onError={() => setNativeError(true)}
      />
    );
  }
  if (mime.startsWith("video/") || mediaType.includes("video")) {
    return (
      <video
        key={nativeAttempt}
        controls
        preload="metadata"
        src={media.source}
        className="max-h-[520px] w-full rounded-xl bg-black"
        aria-label={label}
        onError={() => setNativeError(true)}
      />
    );
  }
  if (message.tipo === "sticker" || mime.startsWith("image/") || mediaType.includes("image")) {
    return (
      <img
        key={nativeAttempt}
        src={media.source}
        alt={label}
        className="max-h-[520px] w-full rounded-xl object-contain"
        onError={() => setNativeError(true)}
      />
    );
  }
  return (
    <a
      href={media.source}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] p-4 font-bold text-[var(--primary)]"
    >
      <FileText size={18} aria-hidden="true" />
      {message.nomeArquivo || "Abrir m\u00eddia"}
    </a>
  );
}

function ChannelMessage({ message }: { message: MsgConteudo }) {
  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <ChannelMessageMedia message={message} />
      {message.texto && (
        <p className={`${message.arquivoUrl ? "mt-3" : ""} whitespace-pre-wrap text-sm leading-6 text-[var(--text)]`}>
          {message.texto}
        </p>
      )}
      <time className="mt-2 block text-right text-[11px] text-[var(--text-secondary)]">
        {message.horario || formatChannelTimestamp(message.timestamp)}
      </time>
    </li>
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
  const selectedMessages = useMemo(
    () => [...(selected?.messages || [])].sort(
      (first, second) => Number(first.timestamp || 0) - Number(second.timestamp || 0),
    ),
    [selected],
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 bg-[var(--background)]" aria-label="Canais do WhatsApp">
      <aside className="flex w-[300px] min-w-[280px] flex-col border-r border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h1 className="text-[15px] font-semibold text-[var(--text)]">Canais</h1>
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
          <label className="nx-conv-search">
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
            <div role="alert" className="m-2 rounded-lg bg-[var(--nx-danger-soft)] p-3 text-sm text-[var(--nx-danger)]">
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
                        ? "bg-[var(--nx-primary-soft)]"
                        : "hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <ChannelAvatar channel={channel} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-bold text-[var(--text)]">{channel.name}</span>
                        {channel.verified && <BadgeCheck size={15} className="shrink-0 text-[var(--nx-primary)]" aria-label="Verificado" />}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">
                        {channel.description || "Canal do WhatsApp"}
                      </span>
                    </span>
                    {Boolean(channel.unreadCount) && (
                      <span className="nx-conv-count">
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

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selected ? (
          <article className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
              <ChannelAvatar channel={selected} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">{selected.name}</h2>
                  {selected.verified && <BadgeCheck size={18} className="shrink-0 text-[var(--nx-primary)]" aria-hidden="true" />}
                </div>
                {selected.verified && <p className="text-xs font-medium text-[var(--nx-primary-text)]">Canal verificado</p>}
                <p className="truncate text-xs text-[var(--text-secondary)]">
                  {selected.description || "Canal do WhatsApp"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2 text-xs text-[var(--text-secondary)]">
                {Boolean(selected.unreadCount) && (
                  <span className="rounded-full border border-[var(--border)] bg-[var(--background)] px-3 py-1.5">
                    {selected.unreadCount} {selected.unreadCount === 1 ? "n\u00e3o lida" : "n\u00e3o lidas"}
                  </span>
                )}
                {selected.timestamp && (
                  <span className="rounded-full border border-[var(--border)] bg-[var(--background)] px-3 py-1.5">
                    Atualizado em {formatChannelTimestamp(selected.timestamp)}
                  </span>
                )}
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--background)] px-6 py-6">
              {selectedMessages.length ? (
                <ol
                  className="mx-auto w-full max-w-2xl space-y-4"
                  aria-label={`Atualiza\u00e7\u00f5es de ${selected.name}`}
                >
                  {selectedMessages.map((message) => (
                    <ChannelMessage key={message.id} message={message} />
                  ))}
                </ol>
              ) : (
                <div className="grid h-full place-items-center text-center text-sm text-[var(--text-secondary)]">
                  <div>
                    <RadioTower size={28} className="mx-auto mb-3 text-[var(--primary)]" aria-hidden="true" />
                    <p>{"Nenhuma atualiza\u00e7\u00e3o dispon\u00edvel neste canal."}</p>
                  </div>
                </div>
              )}
            </div>
          </article>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center p-8">
            <div className="flex max-w-sm flex-col items-center text-center text-[var(--text-secondary)]">
              <span className="grid h-14 w-14 place-items-center rounded-xl bg-[var(--nx-primary-soft)] text-[var(--nx-primary-text)]">
                <RadioTower size={28} />
              </span>
              <h2 className="mt-4 text-lg font-semibold text-[var(--text)]">Selecione um canal</h2>
              <p className="mt-1 text-sm">Escolha um canal na lista para ver suas atualizações.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
