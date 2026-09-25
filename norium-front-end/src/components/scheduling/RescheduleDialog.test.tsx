import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RescheduleDialog from "./RescheduleDialog";
import { schedulingApi } from "../../features/scheduling/api";

vi.mock("../../features/scheduling/api", () => ({
  schedulingApi: { notifyPreview: vi.fn(), adminReschedule: vi.fn() },
}));

const booking = {
  id: "book-1", service_id: "service-1", attendee_name: "Maria", attendee_email: "maria@x.com",
  attendee_phone: "+5511999999999", start_at: "2026-09-28T11:00:00+00:00", end_at: "2026-09-28T12:00:00+00:00",
  timezone: "America/Sao_Paulo", status: "CONFIRMED",
};
const services = [
  { id: "service-1", name: "Consultoria", description: "", durations: [30, 60], color: "#6d5dfc", buffer_before: 0, buffer_after: 0, capacity: 1, slot_interval: 15, active: true, professionalIds: ["pro-1", "pro-2"] },
];
const professionals = [
  { userId: "pro-1", name: "Ana", email: "ana@x.com", active: true, profession: "Advogada", position: "Sócia", color: "#2563eb" },
  { userId: "pro-2", name: "Bruno", email: "bruno@x.com", active: true, profession: "Consultor", position: "Especialista", color: "#16a34a" },
];
const preview = {
  bookingId: "book-1", serviceName: "Consultoria", timezone: "America/Sao_Paulo",
  oldStartAt: booking.start_at, oldEndAt: booking.end_at,
  newStartAt: "2026-10-05T13:00:00+00:00", newEndAt: "2026-10-05T14:00:00+00:00",
  attendeeName: "Maria", attendeeEmail: "maria@x.com", attendeePhone: "+5511999999999", phoneValid: true,
  gmailConnected: true, whatsappConnected: true,
  gmailSubject: "Reagendamento: Consultoria", gmailBody: "Ola Maria", whatsappMessage: "Ola Maria!",
};

describe("RescheduleDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(schedulingApi.notifyPreview).mockResolvedValue(preview);
  });

  async function openWithPreview() {
    const user = userEvent.setup();
    render(<RescheduleDialog booking={booking} services={services} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Nova data e hora"), { target: { value: "2026-10-05T10:00" } });
    await user.click(screen.getByRole("button", { name: "Gerar prévia e canais" }));
    await screen.findByText(/Para:/);
    return user;
  }

  it("shows old and new times with editable channel previews", async () => {
    const user = await openWithPreview();
    const expectedIso = new Date("2026-10-05T10:00").toISOString();
    expect(schedulingApi.notifyPreview).toHaveBeenCalledWith("book-1", expectedIso, 60, "", "team");
    const gmail = screen.getByRole("checkbox", { name: /Avisar por Gmail/ });
    const whatsapp = screen.getByRole("checkbox", { name: /Avisar por WhatsApp/ });
    expect(gmail).not.toBeChecked();
    expect(whatsapp).not.toBeChecked();
    await user.click(gmail);
    await user.click(whatsapp);
    expect(screen.getByLabelText("Assunto do e-mail")).toHaveValue("Reagendamento: Consultoria");
    expect(screen.getByLabelText("Mensagem do WhatsApp")).toHaveValue("Ola Maria!");
  });

  it("disables channels with a usable hint when not connected", async () => {
    vi.mocked(schedulingApi.notifyPreview).mockResolvedValue({ ...preview, gmailConnected: false, whatsappConnected: false });
    const user = userEvent.setup();
    render(<RescheduleDialog booking={booking} services={services} onClose={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Gerar prévia e canais" }));

    await screen.findByText(/Gmail não conectado/);
    expect(screen.getByText(/WhatsApp não conectado/)).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true);
  });

  it("confirms with edited content and shows per-channel receipts", async () => {
    const onSaved = vi.fn();
    vi.mocked(schedulingApi.adminReschedule).mockResolvedValue({
      booking, replay: false,
      receipts: { gmail: { sent: true, receipt: { messageId: "gmail-1" } }, whatsapp: { sent: false, error: "WhatsApp não conectado." } },
    });
    const user = userEvent.setup();
    render(<RescheduleDialog booking={booking} services={services} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Nova data e hora"), { target: { value: "2026-10-05T10:00" } });
    await user.click(screen.getByRole("button", { name: "Gerar prévia e canais" }));
    await screen.findByText(/Para:/);
    await user.click(screen.getByRole("checkbox", { name: /Avisar por Gmail/ }));
    await user.click(screen.getByRole("checkbox", { name: /Avisar por WhatsApp/ }));

    await user.clear(screen.getByLabelText("Assunto do e-mail"));
    await user.type(screen.getByLabelText("Assunto do e-mail"), "Novo assunto");
    await user.click(screen.getByRole("button", { name: "Confirmar reagendamento" }));

    await waitFor(() => expect(schedulingApi.adminReschedule).toHaveBeenCalledOnce());
    const payload = vi.mocked(schedulingApi.adminReschedule).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.gmailSubject).toBe("Novo assunto");
    expect(typeof payload.operationKey).toBe("string");
    expect((payload.operationKey as string).length).toBeGreaterThanOrEqual(8);
    expect(onSaved).toHaveBeenCalled();
    expect(await screen.findByText(/Gmail enviado/)).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp não enviado/)).toBeInTheDocument();
    expect(screen.getByText(/reagendamento foi mantido/i)).toBeInTheDocument();
  });

  it("reuses the same operation key when retrying failed channels", async () => {
    vi.mocked(schedulingApi.adminReschedule)
      .mockResolvedValueOnce({ booking, replay: false, receipts: { gmail: { sent: true, receipt: { messageId: "gmail-1" } }, whatsapp: { sent: false, error: "falha temporária" } } })
      .mockResolvedValueOnce({ booking, replay: true, receipts: { gmail: { sent: true, replay: true, receipt: { messageId: "gmail-1" } }, whatsapp: { sent: true, receipt: { messageId: "wa-2" } } } });
    const user = userEvent.setup();
    render(<RescheduleDialog booking={booking} services={services} onClose={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Gerar prévia e canais" }));
    await screen.findByText(/Para:/);
    await user.click(screen.getByRole("checkbox", { name: /Avisar por Gmail/ }));
    await user.click(screen.getByRole("checkbox", { name: /Avisar por WhatsApp/ }));
    await user.click(screen.getByRole("button", { name: "Confirmar reagendamento" }));
    await screen.findByText(/WhatsApp não enviado/);

    await user.click(screen.getByRole("button", { name: "Tentar canais com falha" }));
    await waitFor(() => expect(schedulingApi.adminReschedule).toHaveBeenCalledTimes(2));
    const first = vi.mocked(schedulingApi.adminReschedule).mock.calls[0][1] as Record<string, unknown>;
    const second = vi.mocked(schedulingApi.adminReschedule).mock.calls[1][1] as Record<string, unknown>;
    expect(second.operationKey).toBe(first.operationKey);
    expect(await screen.findByText(/recibo reaproveitado/)).toBeInTheDocument();
  });

  it("does not offer an automatic retry for an uncertain external effect", async () => {
    vi.mocked(schedulingApi.adminReschedule).mockResolvedValue({
      booking, replay: false,
      receipts: { gmail: { sent: false, uncertain: true, error: "resultado incerto" }, whatsapp: null },
    });
    const user = await openWithPreview();
    await user.click(screen.getByRole("checkbox", { name: /Avisar por Gmail/ }));
    await user.click(screen.getByRole("button", { name: "Confirmar reagendamento" }));

    expect(await screen.findByText(/Não reenvie antes de conferir o canal/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tentar canais com falha" })).not.toBeInTheDocument();
  });

  it("uses a new operation key for a genuinely different reschedule", async () => {
    vi.mocked(schedulingApi.adminReschedule).mockResolvedValue({ booking, replay: false, receipts: { gmail: null, whatsapp: null } });
    const user = await openWithPreview();
    await user.click(screen.getByRole("button", { name: "Confirmar reagendamento" }));
    await waitFor(() => expect(schedulingApi.adminReschedule).toHaveBeenCalledTimes(1));
    const firstKey = vi.mocked(schedulingApi.adminReschedule).mock.calls[0][1].operationKey;

    fireEvent.change(screen.getByLabelText("Nova data e hora"), { target: { value: "2026-10-05T11:00" } });
    await user.click(screen.getByRole("button", { name: "Gerar prévia e canais" }));
    await screen.findByText(/Para:/);
    await user.click(screen.getByRole("button", { name: "Confirmar reagendamento" }));
    await waitFor(() => expect(schedulingApi.adminReschedule).toHaveBeenCalledTimes(2));
    expect(vi.mocked(schedulingApi.adminReschedule).mock.calls[1][1].operationKey).not.toBe(firstKey);
  });

  it("allows changing the linked professional while rescheduling", async () => {
    vi.mocked(schedulingApi.adminReschedule).mockResolvedValue({ booking, replay: false, receipts: { gmail: null, whatsapp: null } });
    const user = userEvent.setup();
    render(<RescheduleDialog booking={{ ...booking, responsible_id: "pro-1" }} services={services} professionals={professionals} onClose={() => {}} onSaved={() => {}} />);

    await user.selectOptions(screen.getByLabelText("Profissional"), "pro-2");
    await user.click(screen.getByRole("button", { name: "Gerar prévia e canais" }));
    await screen.findByText(/Para:/);
    await user.click(screen.getByRole("button", { name: "Confirmar reagendamento" }));

    await waitFor(() => expect(schedulingApi.adminReschedule).toHaveBeenCalledWith("book-1", expect.objectContaining({ responsibleId: "pro-2" })));
  });
});
