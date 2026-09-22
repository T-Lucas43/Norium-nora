import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicSchedulingPage from "./PublicSchedulingPage";
import { schedulingApi, type SlotsResponse } from "../../features/scheduling/api";

vi.mock("../../features/scheduling/api", () => ({
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
});
