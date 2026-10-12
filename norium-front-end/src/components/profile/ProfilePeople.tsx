import { createContext, useContext, type ReactNode } from "react";

type PersonPhoto = { id: string; nome: string; fotoUrl?: string };
const PeopleContext = createContext<PersonPhoto[]>([]);

export function ProfilePeople({ people, children }: { people: PersonPhoto[]; children: ReactNode }) {
  return <PeopleContext.Provider value={people}>{children}</PeopleContext.Provider>;
}

export function usePersonPhoto(userId?: string, name?: string) {
  const people = useContext(PeopleContext);
  if (userId) return people.find((person) => person.id === userId)?.fotoUrl;
  // Legacy comments have only a name. Never guess between namesakes.
  const matches = people.filter((person) => person.nome.trim().toLocaleLowerCase("pt-BR") === name?.trim().toLocaleLowerCase("pt-BR"));
  return matches.length === 1 ? matches[0].fotoUrl : undefined;
}
