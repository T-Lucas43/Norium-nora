import { describe, expect, it } from "vitest";
import { meshVideoInterestForUser, videoSubscriptionInterest } from "./videoSubscriptionPolicy";

describe("interesse de vídeo por bloco visível", () => {
  it("prioriza a apresentação e não confunde o avatar do apresentador com câmera", () => {
    const interest = videoSubscriptionInterest([
      { userId: "presenter", kind: "camera", width: 160, height: 90 },
      { userId: "presenter", kind: "screen", width: 1000, height: 600 },
      { userId: "member", kind: "camera", width: 160, height: 90 },
    ], ["presenter"], false, true);
    expect(interest.cameras.map((tile) => tile.userId)).toEqual(["member"]);
    expect(meshVideoInterestForUser(interest, "presenter")).toEqual({ receiveVideo: true, quality: "high" });
    expect(meshVideoInterestForUser(interest, "member")).toEqual({ receiveVideo: true, quality: "low" });
    expect(meshVideoInterestForUser(interest, "offscreen")).toEqual({ receiveVideo: false, quality: "low" });
  });
  it("a aba oculta remove interesse de todos os vídeos", () => {
    const interest = videoSubscriptionInterest([{ userId: "member", kind: "camera", width: 640, height: 360 }], [], true, false);
    expect(interest.cameras).toEqual([]);
    expect(interest.screens).toEqual([]);
    expect(meshVideoInterestForUser(interest, "member").receiveVideo).toBe(false);
  });
  it("normaliza dimensões, remove duplicatas e rejeita blocos sem área", () => {
    const interest = videoSubscriptionInterest([
      { userId: "member", kind: "camera", width: 160, height: 90 },
      { userId: "member", kind: "camera", width: 640, height: 360 },
      { userId: "invalid", kind: "screen", width: NaN, height: 100 },
      { userId: "hidden", kind: "camera", width: 0, height: 100 },
    ], [], false, false);
    expect(interest.cameras).toEqual([{ userId: "member", width: 640, height: 360 }]);
    expect(interest.screens).toEqual([]);
  });
});
