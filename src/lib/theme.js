/* Paleta única do app — mesma referência do Atelier Flow */
export const COLORS = {
  bg: "#f4f3ef",         // off-white neutro — fundo base e cards
  surface: "#eeede8",    // superfície rebaixada / inputs
  ink: "#003049",        // Deep Space Blue — textos e ícones
  danger: "#c1121f",     // Brick Red — ações principais / atenção
  dangerDeep: "#780000", // Molten Lava — atenção intensa (termômetros)
  accent: "#669bbc",     // Steel Blue — secundário, hover, positivo
  highlight: "#fdf0d5",  // Papaya Whip — apenas badges e realces pontuais
  shadowDark: "rgba(120, 113, 95, 0.12)"
};

export const NATURE_COLOR = {
  attention: COLORS.danger,
  positive: COLORS.accent,
  neutral: COLORS.ink
};

/* Injeta as CSS vars usadas pelas classes .neu-* do index.css */
export const cssVars = {
  "--bg": COLORS.bg,
  "--surface": COLORS.surface,
  "--accent": COLORS.accent,
  "--shadow-dark": COLORS.shadowDark
};

export const brl = (v) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
