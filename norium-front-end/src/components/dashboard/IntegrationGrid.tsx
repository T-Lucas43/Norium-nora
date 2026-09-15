import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDot, Download, ShieldCheck } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import IntegrationLogo from "../shared/IntegrationLogo";
import Button from "../shared/Button";

type Integration = {
  id: string;
  name: string;
  subtitle: string;
  tab: string;
  iconSurface: string;
  marketplaceId?: string;
  native?: boolean;
};

type MarketplaceOverview = {
  installations?: Array<{ catalogId: string; status: string; enabled: boolean }>;
};

const integrations: Integration[] = [
  {
    id: "gmail",
    name: "Gmail",
    subtitle: "E-mails e respostas",
    tab: "E-mails",
    iconSurface: "bg-red-500/10",
  },
  {
    id: "calendar",
    name: "Google Agenda",
    subtitle: "Eventos sincronizados",
    tab: "Agenda",
    iconSurface: "bg-blue-500/10",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    subtitle: "Conversas pela API privada Norium",
    tab: "Chat",
    iconSurface: "bg-emerald-500/10",
  },
  {
    id: "team-chat",
    name: "Chat da Equipe",
    subtitle: "Canais, membros e subequipes",
    tab: "Chat da Equipe",
    iconSurface: "bg-violet-500/10",
    native: true,
  },
  {
    id: "document-models",
    name: "Modelos de documentos",
    subtitle: "Currículos, propostas e contratos",
    tab: "Documentos",
    iconSurface: "bg-sky-500/10",
    marketplaceId: "document-models-pack",
  },
  {
    id: "knowledge-web",
    name: "Fontes web",
    subtitle: "Páginas autorizadas para a Nora",
    tab: "Conhecimento",
    iconSurface: "bg-fuchsia-500/10",
    marketplaceId: "web-source-connector",
  },
  {
    id: "client-nora",
    name: "Nora para Clientes",
    subtitle: "Assistência contextual no CRM",
    tab: "Clientes",
    iconSurface: "bg-cyan-500/10",
    marketplaceId: "client-nora-assistant",
  },
  {
    id: "automations",
    name: "Automações Norium",
    subtitle: "Fluxos entre canais e módulos",
    tab: "Automações",
    iconSurface: "bg-indigo-500/10",
    native: true,
  },
];

export default function IntegrationGrid({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [marketplace, setMarketplace] = useState<MarketplaceOverview>({});

  useEffect(() => {
    let active = true;
    void apiRequest<MarketplaceOverview>("/api/marketplace")
      .then((payload) => { if (active) setMarketplace(payload); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const installationByCatalog = useMemo(
    () => new Map(
      (marketplace.installations || [])
        .filter((item) => item.status === "installed")
        .map((item) => [item.catalogId, item]),
    ),
    [marketplace.installations],
  );

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[var(--text)]">Integrações</h2>
          <p className="mt-0.5 text-xs font-semibold text-[var(--text-secondary)]">Canais e recursos conectados ao seu trabalho.</p>
        </div>

        <Button
         
          onClick={() => onNavigate("Mais")}
          className="min-h-8 px-3 py-1.5 text-xs"
        >
          Gerenciar
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {integrations.map((integration) => {
          const installation = integration.marketplaceId
            ? installationByCatalog.get(integration.marketplaceId)
            : undefined;
          const needsInstall = Boolean(integration.marketplaceId && !installation);
          const enabled = Boolean(installation?.enabled);
          const StatusIcon = needsInstall ? Download : integration.native ? ShieldCheck : enabled ? CheckCircle2 : CircleDot;
          const statusLabel = needsInstall ? "Instalar" : integration.native ? "Nativo" : enabled ? "Ativo" : "Disponível";

          return (
            <button
              type="button"
              key={integration.name}
              onClick={() => onNavigate(needsInstall ? "Marketplace" : integration.tab)}
              className="group flex min-h-[88px] items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-left transition hover:-translate-y-0.5 hover:border-blue-500/55 hover:bg-[var(--surface-hover)]"
              aria-label={`Abrir ${integration.name}`}
            >
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${integration.iconSurface}`}>
                <IntegrationLogo name={integration.name} size={23} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-[var(--text)]">{integration.name}</span>
                <span className="mt-0.5 block truncate text-[11px] font-semibold text-[var(--text-secondary)]">{integration.subtitle}</span>
                <span className={`mt-1.5 inline-flex items-center gap-1.5 text-[10px] font-bold ${needsInstall ? "text-blue-400" : enabled || integration.native ? "text-emerald-500" : "text-[var(--text-secondary)]"}`}>
                  <StatusIcon size={12} /> {statusLabel}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
