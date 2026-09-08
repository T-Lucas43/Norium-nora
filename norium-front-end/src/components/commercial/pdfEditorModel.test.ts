import { describe, expect, it } from "vitest";
import { moveLayer, newLayer, resizeLayer } from "./pdfEditorModel";

describe("PDF visual coordinates", () => {
  it("keeps dragged elements inside their page at every edge", () => {
    const layer = newLayer("signature", 1, { x: .3, y: .4, width: .2, height: .1 });
    expect(moveLayer(layer, -1, -1)).toMatchObject({ x: 0, y: 0 });
    expect(moveLayer(layer, 1, 1)).toMatchObject({ x: .8, y: .9, page: 1 });
    expect(layer).toMatchObject({ x: .3, y: .4 });
  });
  it("resizes signatures proportionally and constrains them to the page", () => {
    const layer = newLayer("signature", 0, { x: .2, y: .8, width: .2, height: .1 });
    const resized = resizeLayer(layer, .7, .5);
    expect(resized.height / resized.width).toBeCloseTo(.5);
    expect(resized.y + resized.height).toBeLessThanOrEqual(1);
    expect(resized.x + resized.width).toBeLessThanOrEqual(1);
  });
});
