import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AvatarImage from "./AvatarImage";
import { ProfilePeople } from "./ProfilePeople";

describe("Fotos de perfil", () => {
  it("usa a foto pelo ID, mantém recorte suave e recupera as iniciais se falhar", () => {
    render(<ProfilePeople people={[{id:"u1",nome:"Ana Silva",fotoUrl:"/foto-original.png"}]}><AvatarImage userId="u1" name="Ana Silva" label="Ana Silva" size={24}/></ProfilePeople>);
    const avatar = screen.getByRole("img", { name: "Ana Silva" });
    const photo = avatar.querySelector("img")!;
    expect(photo).toHaveAttribute("src", "/foto-original.png");
    expect(photo).toHaveStyle({ imageRendering: "auto", objectFit: "cover" });
    fireEvent.error(photo);
    expect(avatar).toHaveTextContent("AS");
  });
  it("não usa a foto de um homônimo nem de outro ID", () => {
    render(<ProfilePeople people={[{id:"u1",nome:"Ana",fotoUrl:"/ana1.png"},{id:"u2",nome:"Ana",fotoUrl:"/ana2.png"}]}><AvatarImage name="Ana" label="Legado"/><AvatarImage userId="u3" name="Ana" label="Outro ID"/></ProfilePeople>);
    expect(screen.getByRole("img", {name:"Legado"}).querySelector("img")).toBeNull();
    expect(screen.getByRole("img", {name:"Outro ID"}).querySelector("img")).toBeNull();
  });
});
