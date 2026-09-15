import { describe, expect, it } from "vitest";
import { defaultBranding } from "../../features/commercial/types";
import { resumePhotoMarkup } from "./resumePhotoMarkup";

describe("CommercialEditor resume photo", () => {
  it("applies the selected position and size to the editable preview", () => {
    const photo = "data:image/png;base64,cGhvdG8=";
    const rightLarge = resumePhotoMarkup({
      ...defaultBranding,
      logoUrl: photo,
      logoAlignment: "right",
      logoScale: 170,
    });
    const leftSmall = resumePhotoMarkup({
      ...defaultBranding,
      logoUrl: photo,
      logoAlignment: "left",
      logoScale: 45,
    });

    expect(rightLarge).toContain("justify-content:flex-end");
    expect(rightLarge).toContain("width:170px;height:170px");
    expect(leftSmall).toContain("justify-content:flex-start");
    expect(leftSmall).toContain("width:45px;height:45px");
  });
});
