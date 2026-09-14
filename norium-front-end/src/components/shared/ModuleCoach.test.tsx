import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ModuleCoach from "./ModuleCoach";

describe("ModuleCoach", () => {
  it("uses the compact vector module icon in the contextual screen guide", () => {
    const { container } = render(<ModuleCoach module="Automacoes" onAskNora={vi.fn()} />);

    expect(container.querySelector("img.norium-module-coach__icon-image")).toBeNull();
    expect(container.querySelector(".norium-module-coach__icon svg")).not.toBeNull();
  });
});
