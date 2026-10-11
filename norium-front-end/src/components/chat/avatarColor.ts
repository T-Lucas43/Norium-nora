// Cores das iniciais nos avatares, as mesmas do layout aprovado. A cor é fixa
// por nome para a mesma pessoa manter sempre a mesma cor.
const AVATAR_COLORS = ["#2563EB", "#7141b8", "#08728a", "#08754d", "#b45309", "#be2446", "#475569"];

export function avatarColor(seed: string) {
  let hash = 0;
  for (const char of seed || "?") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
