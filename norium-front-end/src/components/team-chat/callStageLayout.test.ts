import { afterEach, describe, expect, it, vi } from "vitest";
import { orderCallParticipants, readCallLayout, resolveCallLayout, saveCallLayout, updateSpeakerCandidate } from "./callStageLayout";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("palco adaptativo da reunião", () => {
  it("prioriza apresentação no automático e respeita a escolha explícita", () => {
    expect(resolveCallLayout("auto", true, "speaker", true)).toBe("presentation");
    expect(resolveCallLayout("gallery", true, "speaker", false)).toBe("gallery");
    expect(resolveCallLayout("auto", false, "speaker", false)).toBe("spotlight");
    expect(resolveCallLayout("auto", false, null, false)).toBe("gallery");
  });
  it("guarda a preferência por usuário e tolera dados inválidos ou storage bloqueado", () => {
    saveCallLayout("owner", "spotlight");
    expect(readCallLayout("owner")).toBe("spotlight");
    expect(readCallLayout("other")).toBe("auto");
    localStorage.setItem("norium.team-call.layout.owner", "invalid");
    expect(readCallLayout("owner")).toBe("auto");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readCallLayout("owner")).toBe("auto");
    expect(() => saveCallLayout("owner", "gallery")).not.toThrow();
  });
  it("ordena fala recente, mãos em ordem e próprio usuário por último", () => {
    const ids = ["self", "later", "speaker", "earlier", "other"];
    expect(orderCallParticipants(ids, "self", ["speaker"], { self: "00", earlier: "01", later: "02" })).toEqual(["speaker", "earlier", "later", "other", "self"]);
    expect(ids).toEqual(["self", "later", "speaker", "earlier", "other"]);
  });
  it("reinicia a janela de 1,5 s quando troca a voz e tolera só pausas curtas", () => {
    let candidate = updateSpeakerCandidate(null, "a", 1000);
    candidate = updateSpeakerCandidate(candidate, "a", 2400);
    expect(candidate?.since).toBe(1000);
    candidate = updateSpeakerCandidate(candidate, "b", 2500);
    expect(candidate?.since).toBe(2500);
    expect(updateSpeakerCandidate(candidate, null, 2700)).toEqual(candidate);
    expect(updateSpeakerCandidate(candidate, null, 2801)).toBeNull();
  });
});
