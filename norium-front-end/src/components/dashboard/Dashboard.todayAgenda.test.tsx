// Card "Agenda de hoje" na Dashboard: estados de lista, vazio, erro e retry.
// (Codex, rodada 1, item 5: erro + vazio exibiam duas caixas simultaneas.)
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "./Dashboard";
import type { EventSource, OmnichannelEvent } from "../../types/omnichannel";
import { getDayKeyInTimeZone } from "./todayAgenda";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("../../core/api/client", () => ({ apiRequest: apiJson }));

const TIME_ZONE = "America/Sao_Paulo";
const ERROR_TEXT = "Não foi possível atualizar a agenda.";

function todayAt(hour: string): string {
  return `${getDayKeyInTimeZone(Date.now(), TIME_ZONE)}T${hour}:00-03:00`;
}

function emptyEvents(): Record<EventSource, OmnichannelEvent[]> {
  return {
    gmail: [],
    whatsapp: [],
    calendar: [],
    kanban: [],
    financeiro: [],
    equipe: [],
    automacoes: [],
    brainstorm: [],
    relatorios: [],
    sistema: [],
  };
}

function feedEvent(id: string, title: string): OmnichannelEvent {
  return {
    id,
    source: "calendar",
    title,
    description: "",
    timestamp: new Date().toISOString(),
    metadata: { eventId: `feed-${id}`, inicio: todayAt("11:00"), fim: todayAt("11:30") },
  };
}

function renderDashboard(calendar: OmnichannelEvent[] = []) {
  return render(
    <Dashboard
      eventsBySource={{ ...emptyEvents(), calendar }}
      connected={false}
      profile={null}
      userId="user1"
      onNavigate={vi.fn()}
      onOpenNora={vi.fn()}
    />,
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  apiJson.mockReset();
  apiJson.mockResolvedValue({ eventos: [], timezone: TIME_ZONE });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("Dashboard / Agenda de hoje", () => {
  it("exibe o compromisso de hoje com horario real", async () => {
    apiJson.mockResolvedValue({
      eventos: [{ id: "a1", titulo: "Daily", descricao: "Sala 1", inicio: todayAt("09:00"), fim: todayAt("09:30") }],
      timezone: TIME_ZONE,
    });
    renderDashboard();

    expect(await screen.findByText("Daily")).toBeInTheDocument();
    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.queryByText("Nenhum compromisso hoje.")).toBeNull();
  });

  it("vazio sem erro mostra o estado especifico, sem retry", async () => {
    renderDashboard();

    expect(await screen.findByText("Nenhum compromisso hoje.")).toBeInTheDocument();
    expect(screen.queryByText("Tentar novamente")).toBeNull();
  });

  it("erro com lista vazia exibe caixa unica com retry", async () => {
    let agendaCalls = 0;
    apiJson.mockImplementation((path: string) => {
      if (!path.startsWith("/api/agenda/eventos")) return Promise.resolve({});
      agendaCalls += 1;
      return agendaCalls === 1
        ? Promise.reject(new Error("backend fora do ar"))
        : Promise.resolve({ eventos: [], timezone: TIME_ZONE });
    });
    renderDashboard();

    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByText("Tentar novamente")).toBeInTheDocument();
    // Sem a segunda caixa de "Nenhum compromisso hoje." simultanea.
    expect(screen.queryByText("Nenhum compromisso hoje.")).toBeNull();

    fireEvent.click(screen.getByText("Tentar novamente"));
    await waitFor(() => expect(agendaCalls).toBe(2));
    expect(await screen.findByText("Nenhum compromisso hoje.")).toBeInTheDocument();
  });

  it("erro com itens mantem a lista e mostra a nota sem vazio", async () => {
    apiJson.mockImplementation((path: string) => path.startsWith("/api/agenda/eventos")
      ? Promise.reject(new Error("backend fora do ar"))
      : Promise.resolve({}));
    const { container } = renderDashboard([feedEvent("f1", "Do feed")]);
    const card = container.querySelector(".nxd-agenda");
    expect(card).not.toBeNull();
    const cardQueries = within(card as HTMLElement);

    expect(await cardQueries.findByText("Do feed")).toBeInTheDocument();
    expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
    expect(screen.queryByText("Nenhum compromisso hoje.")).toBeNull();
  });
});
