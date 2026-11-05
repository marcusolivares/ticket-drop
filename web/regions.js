// The regions the page offers, and the Sesc units that belong to each.
//
// This is a fixed copy of /wp/v1/unidades-atividades. That route can't be relied
// on from a browser: see docs/sesc-api.md. A unit missing from this list still
// appears under "Todas as regiões", but gets no forecasts from the booklet.

export const REGIONS = {
  capital: "Capital e Grande SP",
  interior: "Interior",
  litoral: "Litoral",
};

export const UNITS = {
  "14-bis": { name: "14 Bis", region: "capital" },
  "24-de-maio": { name: "24 de Maio", region: "capital" },
  araraquara: { name: "Araraquara", region: "interior" },
  "avenida-paulista": { name: "Avenida Paulista", region: "capital" },
  bauru: { name: "Bauru", region: "interior" },
  belenzinho: { name: "Belenzinho", region: "capital" },
  bertioga: { name: "Bertioga", region: "litoral" },
  birigui: { name: "Birigui", region: "interior" },
  "bom-retiro": { name: "Bom Retiro", region: "capital" },
  campinas: { name: "Campinas", region: "interior" },
  "campo-limpo": { name: "Campo Limpo", region: "capital" },
  carmo: { name: "Carmo", region: "capital" },
  "casa-verde": { name: "Casa Verde", region: "capital" },
  catanduva: { name: "Catanduva", region: "interior" },
  "centro-de-pesquisa-e-formacao": { name: "Centro de Pesquisa e Formação", region: "capital" },
  cinesesc: { name: "CineSesc", region: "capital" },
  consolacao: { name: "Consolação", region: "capital" },
  franca: { name: "Franca", region: "interior" },
  guarulhos: { name: "Guarulhos", region: "capital" },
  interlagos: { name: "Interlagos", region: "capital" },
  ipiranga: { name: "Ipiranga", region: "capital" },
  itaquera: { name: "Itaquera", region: "capital" },
  jundiai: { name: "Jundiaí", region: "interior" },
  marilia: { name: "Marília", region: "interior" },
  "mogi-das-cruzes": { name: "Mogi das Cruzes", region: "capital" },
  osasco: { name: "Osasco", region: "capital" },
  pinheiros: { name: "Pinheiros", region: "capital" },
  piracicaba: { name: "Piracicaba", region: "interior" },
  pompeia: { name: "Pompeia", region: "capital" },
  "presidente-prudente": { name: "Presidente Prudente", region: "interior" },
  registro: { name: "Registro", region: "interior" },
  "ribeirao-preto": { name: "Ribeirão Preto", region: "interior" },
  "rio-preto": { name: "Rio Preto", region: "interior" },
  santana: { name: "Santana", region: "capital" },
  "santo-amaro": { name: "Santo Amaro", region: "capital" },
  "santo-andre": { name: "Santo André", region: "capital" },
  santos: { name: "Santos", region: "litoral" },
  "sao-bento": { name: "São Bento", region: "capital" },
  "sao-caetano": { name: "São Caetano", region: "capital" },
  "sao-carlos": { name: "São Carlos", region: "interior" },
  "sao-jose-dos-campos": { name: "São José dos Campos", region: "interior" },
  sorocaba: { name: "Sorocaba", region: "interior" },
  taubate: { name: "Taubaté", region: "interior" },
  "vila-mariana": { name: "Vila Mariana", region: "capital" },
};

export const UNIT_REGIONS = Object.fromEntries(Object.entries(UNITS).map(([slug, unit]) => [slug, unit.region]));
