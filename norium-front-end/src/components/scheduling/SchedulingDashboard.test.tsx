import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SchedulingDashboard from "./SchedulingDashboard";
import { schedulingApi, type Availability } from "../../features/scheduling/api";

vi.mock("../../features/scheduling/api", () => ({
  schedulingApi: {
    dashboard: vi.fn(),
    createService: vi.fn(),
    updateService: vi.fn(),
    archiveService: vi.fn(),
    getAvailability: vi.fn(),
    setAvailability: vi.fn(),
    createPage: vi.fn(),
    updatePage: vi.fn(),
    archivePage: vi.fn(),
    uploadLogo: vi.fn(),
    updateBookingStatus: vi.fn(),
    notifyPreview: vi.fn(),
    adminReschedule: vi.fn(),
  },
}));

const services = [
  { id: "service-1", name: "Consultoria", description: "", durations: [60], color: "#6d5dfc", buffer_before: 0, buffer_after: 0, capacity: 1, slot_interval: 15, active: true },
  { id: "service-2", name: "Retorno", description: "", durations: [30], color: "#6d5dfc", buffer_before: 0, buffer_after: 0, capacity: 1, slot_interval: 15, active: true },
];
const dashboard = {
  services,
  pages: [],
  bookings: [
    { id: "book-1", service_id: "service-1", attendee_name: "Maria", attendee_email: "maria@x.com", attendee_phone: "+5511999999999", start_at: "2026-09-28T11:00:00+00:00", end_at: "2026-09-28T12:00:00+00:00", timezone: "America/Sao_Paulo", status: "CONFIRMED" },
  ],
};
const emptyAvailability = { service_id: "service-1", timezone: "America/Sao_Paulo", weekly: {}, exceptions: {}, blocked: [] };

describe("SchedulingDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(schedulingApi.dashboard).mockResolvedValue(dashboard);
    vi.mocked(schedulingApi.getAvailability).mockResolvedValue(emptyAvailability);
    vi.mocked(schedulingApi.setAvailability).mockImplementation(async (body): Promise<Availability> => ({
      service_id: (body as { serviceId: string }).serviceId,
      timezone: (body as { timezone: string }).timezone,
      weekly: (body as { weekly: Availability["weekly"] }).weekly,
      exceptions: {},
      blocked: [],
    }));
    vi.mocked(schedulingApi.createPage).mockResolvedValue({ id: "page-1", public_id: "public-1", service_id: "service-1", title: "Consultoria", description: "", fields: [], theme: {}, active: true });
    vi.mocked(schedulingApi.uploadLogo).mockResolvedValue({ logoUrl: "/logo" });
  });

  it("stops loading on an API error and offers a working retry", async () => {
    vi.mocked(schedulingApi.dashboard).mockRejectedValueOnce(new Error("Falha temporária"));
    const user = userEvent.setup();
    render(<SchedulingDashboard />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Falha temporária");
    expect(screen.queryByText("Carregando agendamentos...")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Maria")).toBeInTheDocument();
  });

  it("uploads the selected logo immediately after generating the public link", async () => {
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");
    await user.click(screen.getByRole("button", { name: "Páginas" }));

    await user.type(screen.getByLabelText("Título"), "Consultoria premium");
    const logo = new File([new Uint8Array([137, 80, 78, 71])], "marca.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Logo da página"), logo);
    expect(await screen.findByText("Selecionado: marca.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Gerar link com esta identidade" }));

    await waitFor(() => expect(schedulingApi.createPage).toHaveBeenCalledOnce());
    await waitFor(() => expect(schedulingApi.uploadLogo).toHaveBeenCalledWith("page-1", expect.any(String)));
    expect(vi.mocked(schedulingApi.uploadLogo).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(schedulingApi.createPage).mock.invocationCallOrder[0]);
  });

  it("reloads the saved availability when switching services", async () => {
    vi.mocked(schedulingApi.getAvailability).mockImplementation(async (serviceId: string | null) =>
      serviceId === "service-2"
        ? { service_id: "service-2", timezone: "America/Sao_Paulo", weekly: { "0": [{ start: "08:00", end: "12:00" }, { start: "14:00", end: "18:00" }] }, exceptions: {}, blocked: [] }
        : { service_id: "service-1", timezone: "America/Sao_Paulo", weekly: { "0": [{ start: "09:00", end: "17:00" }] }, exceptions: {}, blocked: [] },
    );
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");
    await user.click(screen.getByRole("button", { name: "Disponibilidade" }));

    await waitFor(() => expect(schedulingApi.getAvailability).toHaveBeenCalledWith("service-1"));
    expect(screen.getByLabelText("Seg início 1")).toHaveValue("09:00");
    expect(screen.queryByLabelText("Seg início 2")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Serviço"), "service-2");
    await waitFor(() => expect(schedulingApi.getAvailability).toHaveBeenCalledWith("service-2"));
    expect(screen.getByLabelText("Seg início 1")).toHaveValue("08:00");
    expect(screen.getByLabelText("Seg início 2")).toHaveValue("14:00");
  });

  it("shows a visible confirmation after saving availability", async () => {
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");
    await user.click(screen.getByRole("button", { name: "Disponibilidade" }));
    await waitFor(() => expect(schedulingApi.getAvailability).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Salvar disponibilidade" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/Disponibilidade salva às/);
    const payload = vi.mocked(schedulingApi.setAvailability).mock.calls[0][0] as { serviceId: string; weekly: Record<string, unknown[]> };
    expect(payload.serviceId).toBe("service-1");
    expect(Object.keys(payload.weekly)).toHaveLength(7);
  });

  it("reflects every new field in the live preview before publishing", async () => {
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");
    await user.click(screen.getByRole("button", { name: "Páginas" }));

    await user.type(screen.getByLabelText("Descrição"), "Atendimento premium");
    await user.click(screen.getByRole("button", { name: "Adicionar" }));

    expect(screen.getAllByText("Atendimento premium")).toHaveLength(2);
    expect(screen.getByText("CPF · obrigatório")).toBeInTheDocument();
  });

  it("archives a service only after a two-click confirmation", async () => {
    vi.mocked(schedulingApi.archiveService).mockResolvedValue({ service: services[0], activePages: 2, activeBookings: 1 });
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");
    await user.click(screen.getByRole("button", { name: "Serviços" }));

    const archiveButtons = screen.getAllByRole("button", { name: "Arquivar" });
    await user.click(archiveButtons[0]);
    expect(schedulingApi.archiveService).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirmar arquivamento" }));
    await waitFor(() => expect(schedulingApi.archiveService).toHaveBeenCalledWith("service-1"));
    expect(await screen.findByRole("status")).toHaveTextContent("2 página(s) e 1 agendamento(s)");
  });

  it("edits a service reusing the saved payload", async () => {
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");
    await user.click(screen.getByRole("button", { name: "Serviços" }));

    await user.click(screen.getAllByRole("button", { name: "Editar" })[0]);
    expect(screen.getByLabelText("Nome")).toHaveValue("Consultoria");
    await user.clear(screen.getByLabelText("Nome"));
    await user.type(screen.getByLabelText("Nome"), "Consultoria plus");
    await user.click(screen.getByRole("button", { name: "Atualizar serviço" }));

    await waitFor(() => expect(schedulingApi.updateService).toHaveBeenCalledWith("service-1", expect.objectContaining({ name: "Consultoria plus" })));
  });

  it("cancels a booking with confirmation and keeps history", async () => {
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(schedulingApi.updateBookingStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirmar cancelamento" }));

    await waitFor(() => expect(schedulingApi.updateBookingStatus).toHaveBeenCalledWith("book-1", "CANCELLED"));
  });

  it("opens the reschedule dialog from a booking", async () => {
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Maria");

    await user.click(screen.getByRole("button", { name: "Reagendar" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar prévia e canais" })).toBeInTheDocument();
  });
});
