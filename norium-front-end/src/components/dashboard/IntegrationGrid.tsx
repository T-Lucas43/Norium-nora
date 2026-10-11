import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDot, Download, ShieldCheck } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import IntegrationLogo from "../shared/IntegrationLogo";

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
    <section className="nx-card nxd-card">
      <div className="nx-card-h flex-wrap">
        <div className="nxd-card-h-col">
          <h2>Integrações</h2>
          <p className="nxd-card-sub">Canais e recursos conectados ao seu trabalho.</p>
        </div>

        <button type="button" className="nx-btn is-sm ml-auto" onClick={() => onNavigate("Mais")}>
          Gerenciar
        </button>
      </div>

      <div className="nx-card-b">
        <div className="nxd-integrations">
          {integrations.map((integration) => {
            const installation = integration.marketplaceId
              ? installationByCatalog.get(integration.marketplaceId)
              : undefined;
            const needsInstall = Boolean(integration.marketplaceId && !installation);
            const enabled = Boolean(installation?.enabled);
            const StatusIcon = needsInstall ? Download : integration.native ? ShieldCheck : enabled ? CheckCircle2 : CircleDot;
            const statusLabel = needsInstall ? "Instalar" : integration.native ? "Nativo" : enabled ? "Ativo" : "Disponível";
            const statusTone = needsInstall ? "is-install" : enabled || integration.native ? "is-on" : "";

            return (
              <button
                type="button"
                key={integration.name}
                onClick={() => onNavigate(needsInstall ? "Marketplace" : integration.tab)}
                className="nxd-integration"
                aria-label={`Abrir ${integration.name}`}
              >
                <span className="nxd-integration-logo">
                  <IntegrationLogo name={integration.name} size={22} />
                </span>
                <span className="nx-grow">
                  <span className="nx-row-t nx-ell block">{integration.name}</span>
                  <span className="nx-row-sub nx-ell block">{integration.subtitle}</span>
                  <span className={`nxd-integration-status ${statusTone}`}>
                    <StatusIcon size={12} strokeWidth={1.75} /> {statusLabel}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}