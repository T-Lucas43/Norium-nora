import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicSchedulingPage, { localDateKey } from "./PublicSchedulingPage";
import { schedulingApi, type SlotsResponse } from "../../features/scheduling/api";

vi.mock("../../features/scheduling/api", () => ({
  clearSlotsCache: vi.fn(),
  schedulingApi: { publicPage: vi.fn(), slotsCached: vi.fn(), book: vi.fn() },
}));
vi.mock("../../core/api/config", () => ({ apiBaseUrl: () => "http://test" }));

const page = {
  id: "page-1", public_id: "public-1", service_id: "service-1", title: "Consultoria",
  description: "", fields: [], theme: {}, active: true,
};
const service = {
  id: "service-1", name: "Consultoria", description: "", durations: [30, 60], color: "#6d5dfc",
  buffer_before: 0, buffer_after: 0, capacity: 1, slot_interval: 15, active: true,
};
const slotA = { startAt: "2026-10-01T12:00:00+00:00", endAt: "2026-10-01T12:30:00+00:00", remaining: 1 };
const slotB = { startAt: "2026-10-02T12:00:00+00:00", endAt: "2026-10-02T12:30:00+00:00", remaining: 2 };

describe("PublicSchedulingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(schedulingApi.publicPage).mockResolvedValue({ page, service });
    vi.mocked(schedulingApi.slotsCached).mockResolvedValue({ slots: [slotA], calendarVerified: true });
  });

  it("apresenta a identidade Norium e calendário com seleção acessível", async () => {
    render(<PublicSchedulingPage identifier="public-1"/>);
    expect(await screen.findByRole("group", { name: "Calendário de datas" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Etapas do agendamento" })).toBeInTheDocument();
    expect(screen.getAllByAltText("Norium")).toHaveLength(2);
    expect(screen.getByLabelText("Escolha a data")).toHaveAttribute("min", localDateKey(new Date()));
  });

  it("alterna tema sem alterar data e serviço", async () => {
    const user = userEvent.setup();
    render(<PublicSchedulingPage identifier="public-1"/>);
    await screen.findByRole("group", { name: "Calendário de datas" });
    const before = (screen.getByLabelText("Escolha a data") as HTMLInputElement).value;
    await user.click(screen.getByRole("button", { name: "Usar tema escuro" }));
    expect(screen.getByRole("main")).toHaveClass("booking-dark");
    expect(screen.getByLabelText("Escolha a data")).toHaveValue(before);
    await user.click(screen.getByRole("button", { name: "Usar tema claro" }));
    expect(screen.getByRole("main")).not.toHaveClass("booking-dark");
  });

  it("shows a skeleton while loading slots, then the times", async () => {
    let resolve!: (value: SlotsResponse | PromiseLike<SlotsResponse>) => void;
    vi.mocked(schedulingApi.slotsCached).mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<PublicSchedulingPage identifier="public-1" />);

    expect(await screen.findByLabelText("Carregando horários")).toBeInTheDocument();
    resolve({ slots: [slotA], calendarVerified: true });
    const labelA = new Date(slotA.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    expect(await screen.findByRole("button", { name: new RegExp(labelA.replace(":", "\\:")) })).toBeInTheDocument();
  });

  it("ignores stale responses when the day changes quickly", async () => {
    const resolvers: Array<(value: SlotsResponse | PromiseLike<SlotsResponse>) => void> = [];
    vi.mocked(schedulingApi.slotsCached).mockImplementation(
      () => new Promise((resolve) => { resolvers.push((v) => resolve(v)); }),
    );
    render(<PublicSchedulingPage identifier="public-1" />);
    await waitFor(() => expect(schedulingApi.slotsCached).toHaveBeenCalledTimes(1));

    const dateInput = screen.getByLabelText("Escolha a data");
    fireEvent.change(dateInput, { target: { value: "2026-10-01" } });
    fireEvent.change(dateInput, { target: { value: "2026-10-02" } });
    await waitFor(() => expect(schedulingApi.slotsCached).toHaveBeenCalledTimes(3));

    // resolve a mais nova primeiro e a antiga por último: a antiga não pode vencer
    resolvers[2]({ slots: [slotB], calendarVerified: true });
    expect(await screen.findByRole("button", { name: /2 vaga/ })).toBeInTheDocument();
    resolvers[1]({ slots: [slotA], calendarVerified: true });
    resolvers[0]({ slots: [slotA], calendarVerified: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("button", { name: /2 vaga/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1 vaga/ })).not.toBeInTheDocument();
  });

  it("warns when the external calendar could not be verified", async () => {
    vi.mocked(schedulingApi.slotsCached).mockResolvedValue({ slots: [], calendarVerified: false });
    render(<PublicSchedulingPage identifier="public-1" />);
    expect(await screen.findByRole("status")).toHaveTextContent(/Calendário externo indisponível/);
  });

  it("confirms a booking with the selected slot", async () => {
    vi.mocked(schedulingApi.book).mockResolvedValue({ booking: { public_id: "bk-1", status: "CONFIRMED" }, cancelToken: "c", rescheduleToken: "r" });
    const user = userEvent.setup();
    render(<PublicSchedulingPage identifier="public-1" />);

    const labelA = new Date(slotA.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    await user.click(await screen.findByRole("button", { name: new RegExp(labelA.replace(":", "\\:")) }));
    await user.type(screen.getByLabelText(/Nome completo/), "Maria");
    await user.type(screen.getByLabelText(/E-mail/), "maria@x.com");
    await user.click(screen.getByRole("button", { name: "Confirmar agendamento" }));

    await waitFor(() => expect(schedulingApi.book).toHaveBeenCalledOnce());
    expect(await screen.findByText("Agendamento confirmado")).toBeInTheDocument();
    expect(screen.getByText("bk-1")).toBeInTheDocument();
  });

  it("masks phone and CPF and blocks an invalid CPF before sending", async () => {
    vi.mocked(schedulingApi.publicPage).mockResolvedValue({
      page: {
        ...page,
        fields: [{ id: "cpf", type: "cpf", label: "CPF", required: true, maxLength: 14 }],
      },
      service,
    });
    vi.mocked(schedulingApi.book).mockResolvedValue({
      booking: { public_id: "bk-valid", status: "CONFIRMED" },
      cancelToken: "c",
      rescheduleToken: "r",
    });
    const user = userEvent.setup();
    render(<PublicSchedulingPage identifier="public-1" />);

    const labelA = new Date(slotA.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    await user.click(await screen.findByRole("button", { name: new RegExp(labelA.replace(":", "\\:")) }));
    await user.type(screen.getByLabelText(/Nome completo/), "Maria");
    await user.type(screen.getByLabelText(/E-mail/), "maria@x.com");
    await user.type(screen.getByLabelText(/WhatsApp/), "11987654321");
    expect(screen.getByLabelText(/WhatsApp/)).toHaveValue("(11) 98765-4321");

    await user.type(screen.getByLabelText(/CPF/), "11111111111");
    expect(screen.getByLabelText(/CPF/)).toHaveValue("111.111.111-11");
    await user.click(screen.getByRole("button", { name: "Confirmar agendamento" }));
    expect(await screen.findByText("Informe um CPF válido.")).toBeInTheDocument();
    expect(schedulingApi.book).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/CPF/));
    await user.type(screen.getByLabelText(/CPF/), "52998224725");
    expect(screen.getByLabelText(/CPF/)).toHaveValue("529.982.247-25");
    await user.click(screen.getByRole("button", { name: "Confirmar agendamento" }));
    await waitFor(() => expect(schedulingApi.book).toHaveBeenCalledOnce());
  });

  it("reuses the booking idempotency key when a retry follows a temporary failure", async () => {
    vi.mocked(schedulingApi.book)
      .mockRejectedValueOnce(new Error("Falha temporária."))
      .mockResolvedValueOnce({
        booking: { public_id: "bk-retry", status: "CONFIRMED" },
        cancelToken: "c",
        rescheduleToken: "r",
      });
    const user = userEvent.setup();
    render(<PublicSchedulingPage identifier="public-1" />);

    const labelA = new Date(slotA.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    await user.click(await screen.findByRole("button", { name: new RegExp(labelA.replace(":", "\\:")) }));
    await user.type(screen.getByLabelText(/Nome completo/), "Maria");
    await user.type(screen.getByLabelText(/E-mail/), "maria@x.com");

    await user.click(screen.getByRole("button", { name: "Confirmar agendamento" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha temporária.");
    const firstKey = (vi.mocked(schedulingApi.book).mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey;

    await user.click(screen.getByRole("button", { name: "Confirmar agendamento" }));
    await waitFor(() => expect(schedulingApi.book).toHaveBeenCalledTimes(2));
    const secondKey = (vi.mocked(schedulingApi.book).mock.calls[1][1] as { idempotencyKey: string }).idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });
});
