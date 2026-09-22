import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SchedulingDashboard from "./SchedulingDashboard";
import { schedulingApi } from "../../features/scheduling/api";

vi.mock("../../features/scheduling/api", () => ({
  schedulingApi: {
    dashboard: vi.fn(),
    createService: vi.fn(),
    setAvailability: vi.fn(),
    createPage: vi.fn(),
    uploadLogo: vi.fn(),
  },
}));

const dashboard = {
  services: [{ id: "service-1", name: "Consultoria", description: "", durations: [60], color: "#6d5dfc", buffer_before: 0, buffer_after: 0, capacity: 1, slot_interval: 15, active: true }],
  pages: [],
  bookings: [],
};

describe("SchedulingDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(schedulingApi.dashboard).mockResolvedValue(dashboard);
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
    expect(await screen.findByText("Nenhum agendamento ainda.")).toBeInTheDocument();
  });

  it("uploads the selected logo immediately after generating the public link", async () => {
    const user = userEvent.setup();
    render(<SchedulingDashboard />);
    await screen.findByText("Nenhum agendamento ainda.");
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
});
