import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { TextDecoder } from "node:util";

function loadLocalEnv() {
  const envPath = resolve(".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3333);
const ROOT = resolve(".");
const DATA_DIR = resolve(ROOT, "data");
const DB_PATH = resolve(process.env.DATABASE_PATH || join(DATA_DIR, "autoclass.sqlite"));
const FRONT_DIST_DIR = resolve(process.env.FRONT_DIST_DIR || join(ROOT, "..", "AutoFront", "dist"));
const RESET_PASSWORD = process.env.RESET_PASSWORD || "223340";
const NCM_JSON_URL =
  process.env.NCM_JSON_URL ||
  "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json";
const NCM_WEB_EVIDENCE_PROVIDER = String(process.env.NCM_WEB_EVIDENCE_PROVIDER || "auto").toLowerCase();
const NCM_WEB_EVIDENCE_LIMIT = Math.min(Math.max(Number(process.env.NCM_WEB_EVIDENCE_LIMIT || 5), 1), 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_NCM_MODEL = process.env.OPENAI_NCM_MODEL || "gpt-5-mini";
const OPENAI_NCM_API_URL = process.env.OPENAI_NCM_API_URL || "https://api.openai.com/v1/responses";
const OPENAI_NCM_APPLY_THRESHOLD = Math.min(Math.max(Number(process.env.OPENAI_NCM_APPLY_THRESHOLD || 0.9), 0.9), 0.99);
const OPENAI_NCM_TIMEOUT_MS = Math.min(Math.max(Number(process.env.OPENAI_NCM_TIMEOUT_MS || 30000), 8000), 90000);
const OPENAI_NCM_MAX_OUTPUT_TOKENS_INPUT = Number(process.env.OPENAI_NCM_MAX_OUTPUT_TOKENS || 3500);
const OPENAI_NCM_MAX_OUTPUT_TOKENS = Math.min(
  Math.max(Number.isFinite(OPENAI_NCM_MAX_OUTPUT_TOKENS_INPUT) ? OPENAI_NCM_MAX_OUTPUT_TOKENS_INPUT : 3500, 3500),
  5000
);
const OPENAI_NCM_WEB_SEARCH_ENABLED = String(process.env.OPENAI_NCM_WEB_SEARCH_ENABLED || "true").toLowerCase() !== "false";
// O classificador processa ate cinco produtos por vez para equilibrar
// velocidade, limite de saida e estabilidade das pesquisas web.
const OPENAI_NCM_CONCURRENCY = 5;
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || "";
const AI_BILLING_PRICE_CENTS = Math.min(Math.max(Number(process.env.AI_BILLING_PRICE_CENTS || 15), 1), 100000);
const AI_BILLING_DEFAULT_ENABLED = true;
const AI_BILLING_TRUST_PAYMENT_UPDATED_WEBHOOK =
  String(process.env.AI_BILLING_TRUST_PAYMENT_UPDATED_WEBHOOK || "true").toLowerCase() !== "false";
const AI_BILLING_PROCESSING_LOCK_MS = Math.min(
  Math.max(Number(process.env.AI_BILLING_PROCESSING_LOCK_MS || 30 * 60 * 1000), 5 * 60 * 1000),
  4 * 60 * 60 * 1000
);
const MERCADO_PAGO_API_URL = process.env.MERCADO_PAGO_API_URL || "https://api.mercadopago.com";
const AI_BILLING_DEFAULT_PAYER_EMAIL = "narutoeterno136@gmail.com";

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const now = () => new Date().toISOString();
const asJson = (value, fallback = null) => {
  if (value === undefined) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(fallback);
  }
};
const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const staticMime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const curatedNcmRows = [
  ["04061010", "Mozarela", ["mozarela", "mucarela", "mussarela", "queijo mozarela", "queijo mussarela"]],
  [
    "04061090",
    "Queijos frescos exceto mozarela, incluindo queijo Minas frescal",
    [
      "minas",
      "frescal",
      "queijo minas",
      "queijo minas frescal",
      "fresco",
      "frescos",
      "requeijao",
      "requeijao cremoso"
    ]
  ],
  [
    "04069090",
    "Outros queijos",
    [
      "queijo",
      "queijos",
      "curado",
      "meia cura",
      "trufado",
      "queijo trufado",
      "queijo trufado doce",
      "queijo trufado doce de leite",
      "queijo trufado goiabada",
      "artesanal",
      "outros",
      "generico"
    ]
  ],
  [
    "04069020",
    "Queijo prato",
    ["queijo prato", "prato", "queijo fatiado prato", "queijo tipo prato", "laticinio", "laticinios"]
  ],
  ["04012010", "Leite UHT integral", ["leite", "leite integral", "integral", "uht"]],
  ["04015021", "Creme de leite UHT", ["creme de leite", "creme leite", "nata", "uht"]],
  ["04032000", "Iogurte", ["iogurte", "yogurte", "iogurte natural", "iogurte morango"]],
  ["04051000", "Manteiga", ["manteiga", "manteiga artesanal"]],
  ["04090000", "Mel natural", ["mel", "mel puro", "mel natural"]],
  ["03061610", "Camaroes de agua fria", ["camarao", "camaroes", "agua", "fria", "crustaceo"]],
  ["03061790", "Outros camaroes", ["camarao", "camaroes", "outros", "crustaceo", "generico"]],
  ["10063021", "Arroz semibranqueado ou branqueado, polido ou brunido", ["arroz", "arroz tipo 1", "agulhinha", "parboilizado", "grao"]],
  ["07133319", "Feijao comum, exceto preto ou branco, nao destinado a semeadura", ["feijao", "feijao carioca", "carioca"]],
  ["09012100", "Cafe torrado nao descafeinado", ["cafe", "cafe torrado", "cafe moido", "torrado", "moido"]],
  ["11010010", "Farinha de trigo", ["farinha", "farinha trigo", "trigo"]],
  ["15079011", "Oleo de soja refinado em recipientes ate 5 l", ["oleo", "oleo soja", "soja", "oleo refinado"]],
  ["17019900", "Outros acucares de cana ou beterraba", ["acucar", "acucares", "refinado", "cristal", "demerara"]],
  ["19012090", "Outras massas e pastas para produtos de padaria ou pastelaria", ["massa pastel", "massa de pastel", "pastel"]],
  ["19019020", "Doce de leite", ["doce leite", "doce de leite"]],
  ["19021900", "Massas alimenticias nao cozidas, nao recheadas, outras", ["macarrao", "espaguete", "massa alimenticia"]],
  [
    "19059090",
    "Outros produtos de padaria, pastelaria ou industria de bolachas",
    [
      "pizza",
      "pizzas",
      "pizza mussarela",
      "pizza mozarela",
      "pizza mucarela",
      "pizza queijo",
      "pizza congelada",
      "pizza mussarela congelada",
      "pizza mozarela congelada",
      "pizza calabresa",
      "pizza frango",
      "pizza pronta",
      "pizza brotinho",
      "biscoito",
      "biscoitos",
      "bolacha",
      "bolachas",
      "paes",
      "pao",
      "pao frances",
      "pao queijo",
      "pao de queijo",
      "salgado",
      "salgado assado",
      "broa",
      "broa milho",
      "rosca",
      "rosca caseira",
      "bolo",
      "bolo chocolate",
      "bolo cenoura"
    ]
  ],
  ["19054000", "Torradas, pao torrado e produtos semelhantes torrados", ["torrada", "torradas", "torrada integral", "pao torrado"]],
  ["20058000", "Milho doce preparado ou conservado", ["milho", "milho verde", "milho lata", "lata milho"]],
  ["20079910", "Geleias e marmelades", ["geleia", "geleia morango", "goiabada", "goiabada cascao", "marmelada"]],
  ["20096900", "Suco de uva", ["suco uva", "suco de uva", "uva integral", "suco integral"]],
  ["21032010", "Ketchup e outros molhos de tomate em embalagem ate 1 kg", ["molho tomate", "molho de tomate", "tomate", "ketchup"]],
  [
    "21050010",
    "Sorvetes e outros gelados comestiveis em embalagens imediatas ate 2 kg",
    [
      "sorvete",
      "sorvetes",
      "sorvete creme",
      "sorvete de creme",
      "sorvete chocolate",
      "sorvete morango",
      "picole",
      "picoles",
      "gelado comestivel",
      "gelados comestiveis",
      "pote sorvete",
      "sorvete pote"
    ]
  ],
  ["22011000", "Aguas minerais e aguas gaseificadas", ["agua mineral", "agua com gas", "agua sem gas", "mineral", "gaseificada"]],
  ["22021000", "Aguas adicionadas de acucar ou aromatizadas", ["refrigerante", "refrigerante cola", "cola", "guarana", "bebida gaseificada"]],
  ["22029900", "Outras bebidas nao alcoolicas", ["energetico", "energetica", "bebida energetica"]],
  [
    "23091000",
    "Alimentos para caes ou gatos, acondicionados para venda a retalho",
    [
      "racao",
      "racoes",
      "racao gato",
      "racao gatos",
      "racao para gato",
      "racao para gatos",
      "racao gato adulto",
      "racao gatos filhote",
      "racao cachorro",
      "racao cachorros",
      "racao para cachorro",
      "racao para cachorros",
      "racao cao",
      "racao caes",
      "racao para cao",
      "racao para caes",
      "alimento gato",
      "alimento para gatos",
      "alimento cachorro",
      "alimento para cachorros",
      "alimento pet",
      "pet food",
      "gato",
      "gatos",
      "cachorro",
      "cachorros",
      "cao",
      "caes",
      "pet"
    ]
  ],
  ["25010020", "Sal de mesa", ["sal", "sal refinado", "sal mesa"]],
  ["33051000", "Xampus", ["shampoo", "shampoos", "xampu", "xampus", "anticaspa", "capilar", "cabelo"]],
  ["33061000", "Dentifricios", ["creme dental", "pasta dental", "dental", "dente", "dentifricio", "dentifricios"]],
  [
    "33042010",
    "Produtos de maquiagem para os olhos",
    [
      "sombra",
      "delineador",
      "rimel",
      "mascara cilios",
      "maquiagem olhos",
      "maquiagem",
      "sobrancelha",
      "sobrancelhas",
      "lapis maquiagem",
      "lapis de maquiagem",
      "lapis para maquiagem",
      "lapis sobrancelha",
      "lapis para sobrancelha",
      "lapis para sobrancelhas",
      "lapis de sobrancelha",
      "lapis olho",
      "lapis de olho",
      "lapis para olhos"
    ]
  ],
  ["33049910", "Cremes de beleza e preparacoes para pele", ["hidratante", "creme beleza", "creme pele", "cosmetico", "cosmeticos", "locao", "locao corporal"]],
  ["34025000", "Preparacoes de limpeza acondicionadas para venda a retalho", ["detergente", "detergente neutro", "sabao", "sabao po", "sabao em po", "limpeza", "lavagem"]],
  ["48181000", "Papel higienico", ["papel higienico", "higienico", "papel banheiro", "papel sanitario"]],
  ["61091000", "Camisetas de malha de algodao", ["camiseta", "camisetas", "camisa", "malha", "algodao", "roupa"]],
  [
    "84851000",
    "Maquinas para fabricacao aditiva por deposito de metal",
    [
      "impressora 3d metal",
      "impressora 3d metalica",
      "fabricacao aditiva metal",
      "fabricacao aditiva metalica",
      "deposito de metal",
      "sinterizacao metal",
      "impressao 3d metal"
    ]
  ],
  [
    "84852000",
    "Maquinas para fabricacao aditiva por deposito de plastico ou borracha",
    [
      "impressora 3d plastico",
      "impressora 3d filamento",
      "impressora 3d fdm",
      "impressora 3d pla",
      "impressora 3d abs",
      "impressora 3d petg",
      "fabricacao aditiva plastico",
      "fabricacao aditiva borracha",
      "deposito de plastico",
      "deposito de borracha",
      "impressao 3d plastico"
    ]
  ],
  [
    "84853000",
    "Maquinas para fabricacao aditiva por deposito de gesso, cimento, ceramica ou vidro",
    [
      "impressora 3d ceramica",
      "impressora 3d gesso",
      "impressora 3d cimento",
      "impressora 3d vidro",
      "fabricacao aditiva ceramica",
      "fabricacao aditiva gesso",
      "fabricacao aditiva cimento",
      "fabricacao aditiva vidro"
    ]
  ],
  [
    "84858000",
    "Outras maquinas para fabricacao aditiva",
    [
      "impressora 3d",
      "impressoras 3d",
      "maquina fabricacao aditiva",
      "maquinas fabricacao aditiva",
      "fabricacao aditiva",
      "impressao 3d",
      "manufatura aditiva",
      "3d printer",
      "generico"
    ]
  ],
  ["85171231", "Telefones inteligentes", ["smartphone", "smartphones", "celular", "telefone", "android", "iphone"]],
  ["94036000", "Outros moveis de madeira", ["mesa", "movel", "moveis", "armario", "madeira", "cadeira"]],
  [
    "96091000",
    "Lapis",
    [
      "lapis",
      "lapis preto",
      "lapis grafite",
      "lapis escolar",
      "lapis escrever",
      "lapis de escrever",
      "lapis desenho",
      "lapis para desenho",
      "lapis numero",
      "lapis numero 2",
      "lapis hb",
      "lapis de cor",
      "lapis colorido",
      "lapis coloridos",
      "grafite"
    ]
  ],
  [
    "96034010",
    "Rolos para pintura",
    [
      "rolo",
      "rolos",
      "rolo pintura",
      "rolo de pintura",
      "rolos pintura",
      "rolos de pintura",
      "rolo pintura la",
      "rolo de pintura la",
      "rolo de la",
      "rolos de la",
      "rolo espuma",
      "rolo de espuma",
      "rolo sintetico",
      "rolo pintura sintetico",
      "rolo antirrespingo",
      "rolo parede",
      "rolo tinta",
      "rolo para tinta",
      "pintura",
      "pintar",
      "la"
    ]
  ],
  ["00000000", "Nao identificado - revisar com contador", []]
];

function upsertCuratedNcmRows(source = "seed_mvp") {
  const upsertNcm = db.prepare(`
    INSERT INTO ncm_oficial (codigo, descricao, data_inicio, data_fim, ativo, keywords_json, source)
    VALUES (?, ?, ?, NULL, 1, ?, ?)
    ON CONFLICT(codigo) DO UPDATE SET
      descricao = excluded.descricao,
      data_inicio = excluded.data_inicio,
      data_fim = NULL,
      ativo = 1,
      keywords_json = excluded.keywords_json,
      source = excluded.source
  `);
  for (const [codigo, descricao, keywords] of curatedNcmRows) {
    upsertNcm.run(codigo, descricao, "2022-04-01", asJson(keywords, []), source);
  }
}

function parseFiscalDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const brDate = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brDate) {
    const [, day, month, year] = brDate;
    return new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function isFiscalRowActive(dataFim) {
  const text = String(dataFim || "").trim();
  if (!text || text === "31/12/9999" || text === "9999-12-31") return 1;
  const timestamp = parseFiscalDate(text);
  if (!timestamp) return 1;
  return timestamp >= Date.now() ? 1 : 0;
}

function ensureTableColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const column of columns) {
    if (existing.has(column.name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type};`);
  }
}

function setupDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      razao_social TEXT,
      cnpj TEXT,
      inscricao_estadual TEXT,
      inscricao_municipal TEXT,
      crt TEXT NOT NULL DEFAULT '1',
      regime_tributario TEXT NOT NULL DEFAULT 'simples_nacional',
      mei INTEGER NOT NULL DEFAULT 0,
      cnae_principal TEXT,
      cnaes_secundarios TEXT,
      uf TEXT NOT NULL DEFAULT 'SP',
      municipio TEXT,
      codigo_municipio_ibge TEXT,
      contribuinte_icms INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      source_type TEXT NOT NULL,
      operation_type TEXT NOT NULL DEFAULT 'venda',
      uf TEXT NOT NULL DEFAULT 'SP',
      imported_by TEXT NOT NULL DEFAULT 'sistema',
      row_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processed',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER,
      codigo_produto TEXT,
      descricao_original TEXT NOT NULL,
      descricao_tratada TEXT NOT NULL,
      unidade TEXT,
      preco REAL,
      codigo_barras TEXT,
      peso TEXT,
      marca TEXT,
      categoria TEXT,
      ncm_importado TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES import_batches(id)
    );

    CREATE TABLE IF NOT EXISTS classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL UNIQUE,
      operation_type TEXT NOT NULL DEFAULT 'venda',
      uf TEXT NOT NULL DEFAULT 'SP',
      sku TEXT,
      ean TEXT,
      ncm TEXT,
      cest TEXT,
      cfop_interno TEXT,
      cfop_interestadual TEXT,
      cst_icms TEXT,
      aliquota_icms REAL,
      icms_st TEXT,
      csosn TEXT,
      origem TEXT NOT NULL DEFAULT '0',
      cst_pis TEXT,
      aliquota_pis REAL,
      cst_cofins TEXT,
      aliquota_cofins REAL,
      aliquota_fcp REAL,
      ibs_cbs_cst TEXT,
      cclass_trib TEXT,
      aliquota_ibs_uf REAL,
      aliquota_ibs_municipio REAL,
      aliquota_cbs REAL,
      cst_ipi TEXT,
      ipi REAL,
      ex_tipi TEXT,
      cenq TEXT,
      cbenef TEXT,
      vtottrib REAL,
      confianca REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_review',
      observacao TEXT,
      sugestao_json TEXT,
      approved_by TEXT,
      approved_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_billing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classification_id INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'BRL',
      status TEXT NOT NULL DEFAULT 'disabled',
      provider TEXT,
      provider_reference TEXT,
      checkout_url TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (classification_id) REFERENCES classifications(id)
    );

    CREATE TABLE IF NOT EXISTS validated_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao_base TEXT NOT NULL,
      palavras_chave TEXT NOT NULL,
      empresa_id INTEGER NOT NULL DEFAULT 1,
      segmento TEXT,
      ncm TEXT,
      cfop_padrao_interno TEXT,
      cfop_padrao_interestadual TEXT,
      csosn TEXT,
      cst_icms TEXT,
      aliquota_icms REAL,
      pis TEXT,
      aliquota_pis REAL,
      cofins TEXT,
      aliquota_cofins REAL,
      cest TEXT,
      aliquota_fcp REAL,
      ibs_cbs_cst TEXT,
      cclass_trib TEXT,
      contador_id TEXT,
      data_validacao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'sistema',
      previous_json TEXT,
      next_json TEXT,
      source_table TEXT,
      table_version TEXT,
      effective_date TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ncm_oficial (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL,
      data_inicio TEXT,
      data_fim TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      keywords_json TEXT,
      source TEXT NOT NULL DEFAULT 'seed'
    );

    CREATE TABLE IF NOT EXISTS tipi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ncm TEXT NOT NULL,
      descricao TEXT,
      aliquota_ipi REAL,
      ex_tipi TEXT,
      vigencia TEXT
    );

    CREATE TABLE IF NOT EXISTS cfop_oficial (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL,
      tipo TEXT NOT NULL,
      entrada_saida TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS regras_cfop (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_operacao TEXT NOT NULL,
      uf_origem TEXT,
      uf_destino TEXT,
      origem_mercadoria TEXT,
      destinatario_contribuinte INTEGER,
      cfop TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS origem_mercadoria (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cst_icms (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS csosn (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crt (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cest (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_cest TEXT NOT NULL,
      ncm TEXT,
      descricao TEXT,
      segmento TEXT,
      item_segmento TEXT
    );

    CREATE TABLE IF NOT EXISTS cst_pis (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cst_cofins (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS regras_pis_cofins_por_ncm (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ncm TEXT NOT NULL,
      aliquota_pis REAL,
      aliquota_cofins REAL,
      tipo_incidencia TEXT
    );

    CREATE TABLE IF NOT EXISTS ibs_cbs_cst (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ibs_cbs_classificacao (
      cclass_trib TEXT PRIMARY KEY,
      descricao TEXT NOT NULL,
      cst_permitido TEXT,
      indicadores TEXT,
      vigencia TEXT
    );

    CREATE TABLE IF NOT EXISTS cbenef_uf (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uf TEXT NOT NULL,
      codigo_beneficio TEXT NOT NULL,
      cst TEXT,
      descricao TEXT,
      ncm TEXT,
      vigencia TEXT
    );

    CREATE TABLE IF NOT EXISTS ibge_municipios (
      codigo_municipio_ibge TEXT PRIMARY KEY,
      nome_municipio TEXT NOT NULL,
      uf TEXT NOT NULL,
      codigo_uf TEXT
    );

    CREATE TABLE IF NOT EXISTS ibpt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ncm TEXT NOT NULL,
      uf TEXT NOT NULL,
      aliquota_federal REAL,
      aliquota_estadual REAL,
      aliquota_municipal REAL,
      vigencia_inicio TEXT,
      vigencia_fim TEXT,
      fonte TEXT,
      chave TEXT
    );
  `);

  ensureTableColumns("import_batches", [
    { name: "uf", type: "TEXT NOT NULL DEFAULT 'SP'" }
  ]);
  ensureTableColumns("classifications", [
    { name: "operation_type", type: "TEXT NOT NULL DEFAULT 'venda'" },
    { name: "uf", type: "TEXT NOT NULL DEFAULT 'SP'" },
    { name: "sku", type: "TEXT" },
    { name: "ean", type: "TEXT" },
    { name: "aliquota_icms", type: "REAL" },
    { name: "icms_st", type: "TEXT" },
    { name: "aliquota_fcp", type: "REAL" },
    { name: "aliquota_ibs_uf", type: "REAL" },
    { name: "aliquota_ibs_municipio", type: "REAL" },
    { name: "aliquota_cbs", type: "REAL" },
    { name: "cst_ipi", type: "TEXT" },
    { name: "ex_tipi", type: "TEXT" },
    { name: "cenq", type: "TEXT" }
  ]);
  ensureTableColumns("validated_rules", [
    { name: "tipo_operacao", type: "TEXT" },
    { name: "aliquota_icms", type: "REAL" },
    { name: "aliquota_pis", type: "REAL" },
    { name: "aliquota_cofins", type: "REAL" },
    { name: "aliquota_fcp", type: "REAL" }
  ]);

  const companyExists = db.prepare("SELECT COUNT(*) AS total FROM companies").get().total > 0;
  if (!companyExists) {
    db.prepare(`
      INSERT INTO companies (
        id, razao_social, cnpj, crt, regime_tributario, uf, municipio,
        contribuinte_icms, updated_at
      ) VALUES (1, 'Empresa modelo Aikkie', '', '1', 'simples_nacional', 'SP', 'Sao Paulo', 1, ?)
    `).run(now());
  }

  db.exec(`
    DELETE FROM validated_rules;
    DELETE FROM sqlite_sequence WHERE name = 'validated_rules';
  `);

  seedCatalogs();
}

function seedCatalogs() {
  db.prepare("UPDATE ncm_oficial SET ativo = 1 WHERE data_fim IS NULL OR data_fim IN ('31/12/9999', '9999-12-31')").run();
  upsertCuratedNcmRows("seed_mvp");

  if (db.prepare("SELECT COUNT(*) AS total FROM cfop_oficial").get().total === 0) {
    const rows = [
      ["5102", "Venda de mercadoria adquirida ou recebida de terceiros", "venda", "saida"],
      ["6102", "Venda de mercadoria adquirida ou recebida de terceiros para outro estado", "venda", "saida"],
      ["1102", "Compra para comercializacao dentro do estado", "compra", "entrada"],
      ["2102", "Compra para comercializacao de outro estado", "compra", "entrada"],
      ["5202", "Devolucao de compra para comercializacao", "devolucao", "saida"],
      ["6202", "Devolucao de compra para comercializacao para outro estado", "devolucao", "saida"],
      ["5949", "Outra saida de mercadoria ou prestacao de servico nao especificado", "remessa", "saida"],
      ["6949", "Outra saida interestadual nao especificada", "remessa", "saida"]
    ];
    const insert = db.prepare("INSERT INTO cfop_oficial (codigo, descricao, tipo, entrada_saida) VALUES (?, ?, ?, ?)");
    for (const row of rows) insert.run(...row);
  }

  if (db.prepare("SELECT COUNT(*) AS total FROM regras_cfop").get().total === 0) {
    const insert = db.prepare(`
      INSERT INTO regras_cfop (
        tipo_operacao, uf_origem, uf_destino, origem_mercadoria, destinatario_contribuinte, cfop
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const rows = [
      ["venda", "SP", "SP", "0", 1, "5102"],
      ["venda", "SP", "*", "0", 1, "6102"],
      ["compra", "SP", "SP", "0", 1, "1102"],
      ["compra", "*", "SP", "0", 1, "2102"],
      ["devolucao", "SP", "SP", "0", 1, "5202"],
      ["devolucao", "SP", "*", "0", 1, "6202"],
      ["remessa", "SP", "SP", "0", 1, "5949"],
      ["remessa", "SP", "*", "0", 1, "6949"]
    ];
    for (const row of rows) insert.run(...row);
  }

  seedSimpleTable("origem_mercadoria", [
    ["0", "Nacional"],
    ["1", "Estrangeira - importacao direta"],
    ["2", "Estrangeira - adquirida no mercado interno"],
    ["3", "Nacional com conteudo de importacao superior a 40%"]
  ]);

  seedSimpleTable("cst_icms", [
    ["00", "Tributada integralmente"],
    ["20", "Com reducao de base de calculo"],
    ["40", "Isenta"],
    ["41", "Nao tributada"],
    ["60", "ICMS cobrado anteriormente por substituicao tributaria"],
    ["90", "Outras"]
  ]);

  seedSimpleTable("csosn", [
    ["101", "Tributada pelo Simples Nacional com permissao de credito"],
    ["102", "Tributada pelo Simples Nacional sem permissao de credito"],
    ["400", "Nao tributada pelo Simples Nacional"],
    ["500", "ICMS cobrado anteriormente por substituicao tributaria"],
    ["900", "Outros"]
  ]);

  seedSimpleTable("crt", [
    ["1", "Simples Nacional"],
    ["2", "Simples Nacional - excesso de sublimite"],
    ["3", "Regime Normal"],
    ["4", "MEI"]
  ]);

  seedSimpleTable("cst_pis", [
    ["01", "Operacao tributavel com aliquota basica"],
    ["04", "Operacao tributavel monofasica"],
    ["06", "Operacao tributavel a aliquota zero"],
    ["49", "Outras operacoes de saida"]
  ]);

  seedSimpleTable("cst_cofins", [
    ["01", "Operacao tributavel com aliquota basica"],
    ["04", "Operacao tributavel monofasica"],
    ["06", "Operacao tributavel a aliquota zero"],
    ["49", "Outras operacoes de saida"]
  ]);

  seedSimpleTable("ibs_cbs_cst", [
    ["000", "Tributacao integral"],
    ["200", "Aliquota reduzida"],
    ["400", "Isencao"],
    ["510", "Diferimento"],
    ["620", "Tributacao monofasica"]
  ]);

  if (db.prepare("SELECT COUNT(*) AS total FROM ibs_cbs_classificacao").get().total === 0) {
    const insert = db.prepare(`
      INSERT INTO ibs_cbs_classificacao (cclass_trib, descricao, cst_permitido, indicadores, vigencia)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run("000001", "Classificacao geral para bens e mercadorias", "000", "{}", "2026-01-01");
    insert.run("200001", "Bens com reducao indicada por legislacao especifica", "200", "{}", "2026-01-01");
  }

  if (db.prepare("SELECT COUNT(*) AS total FROM regras_pis_cofins_por_ncm").get().total === 0) {
    const insert = db.prepare(`
      INSERT INTO regras_pis_cofins_por_ncm (ncm, aliquota_pis, aliquota_cofins, tipo_incidencia)
      VALUES (?, ?, ?, ?)
    `);
    insert.run("00000000", 1.65, 7.6, "basica");
    insert.run("04061010", 1.65, 7.6, "basica");
    insert.run("04061090", 1.65, 7.6, "basica");
    insert.run("10063021", 0, 0, "verificar_alíquota_zero");
  }
  db.prepare(`
    INSERT INTO regras_pis_cofins_por_ncm (ncm, aliquota_pis, aliquota_cofins, tipo_incidencia)
    SELECT ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM regras_pis_cofins_por_ncm WHERE ncm = ?)
  `).run("04061090", 1.65, 7.6, "basica", "04061090");
}

function seedSimpleTable(table, rows) {
  const count = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  if (count > 0) return;
  const insert = db.prepare(`INSERT INTO ${table} (codigo, descricao) VALUES (?, ?)`);
  for (const row of rows) insert.run(...row);
}

setupDatabase();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8", filename = null) {
  const headers = {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  };
  if (filename) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers);
  res.end(body);
}

function sendBuffer(res, status, buffer, contentType, filename) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(buffer);
}

function sendOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end();
}

function sendStaticFile(res, filePath) {
  const contentType = staticMime[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(res);
}

function tryServeFront(url, res) {
  if (!existsSync(FRONT_DIST_DIR)) return false;
  const requested = normalize(decodeURIComponent(url.pathname || "/")).replace(/^([/\\])+/, "");
  let filePath = resolve(join(FRONT_DIST_DIR, requested));
  if (!filePath.startsWith(FRONT_DIST_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return true;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(FRONT_DIST_DIR, "index.html");
  }
  if (!existsSync(filePath)) return false;
  sendStaticFile(res, filePath);
  return true;
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function decodeText(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const badChars = (utf8.match(/\uFFFD/g) || []).length;
  if (badChars <= 2) return utf8.replace(/^\uFEFF/, "");
  return buffer.toString("latin1").replace(/^\uFEFF/, "");
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b\d+([,.]\d+)?\s?(kg|g|mg|l|lt|ml|un|und|pct|pc|cx|m|cm|mm)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOperationType(value = "venda") {
  const normalized = normalizeText(value);
  if (["compra", "compras", "entrada"].includes(normalized)) return "compra";
  return "venda";
}

const BRAZIL_UFS = new Set([
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO"
]);

function normalizeUf(value, fallback = "SP") {
  const clean = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
  if (BRAZIL_UFS.has(clean)) return clean;
  const fallbackClean = String(fallback ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
  if (BRAZIL_UFS.has(fallbackClean)) return fallbackClean;
  return fallback === "" ? "" : "SP";
}

function extractSearchCode(value = "") {
  const candidates = String(value || "").match(/(?:\d[\s./-]*){4,8}/g) || [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 4 && digits.length <= 8) return digits;
  }
  return "";
}

function extractTokens(value = "") {
  const stop = new Set([
    "de",
    "da",
    "do",
    "das",
    "dos",
    "com",
    "sem",
    "para",
    "por",
    "em",
    "a",
    "o",
    "e",
    "que",
    "mesmo",
    "conteudo",
    "inferior",
    "igual",
    "superior",
    "sabor",
    "linha",
    "item",
    "tipo",
    "unidade",
    "caseiro",
    "caseira",
    "artesanal",
    "natural",
    "integral",
    "puro",
    "pura"
  ]);
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 2 && !/^\d+$/.test(token) && !stop.has(token))
    .slice(0, 12);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal : Math.min(previous[j - 1], previous[j], diagonal) + 1;
      diagonal = temp;
    }
  }
  return previous[b.length];
}

function singularizeToken(token) {
  if (token.length > 5 && token.endsWith("oes")) return `${token.slice(0, -3)}ao`;
  if (token.length > 5 && token.endsWith("aes")) return `${token.slice(0, -3)}ao`;
  if (token.length > 5 && token.endsWith("ais")) return `${token.slice(0, -3)}al`;
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function pluralizeToken(token) {
  const normalized = normalizeText(token);
  if (!normalized || normalized.endsWith("s")) return normalized;
  if (normalized.endsWith("ao")) return `${normalized.slice(0, -2)}oes`;
  if (normalized.endsWith("m")) return `${normalized.slice(0, -1)}ns`;
  if (normalized.endsWith("r") || normalized.endsWith("z")) return `${normalized}es`;
  if (normalized.endsWith("l")) return `${normalized.slice(0, -1)}is`;
  return `${normalized}s`;
}

function tokenVariants(token) {
  const normalized = normalizeText(token);
  return [...new Set([normalized, singularizeToken(normalized), pluralizeToken(normalized)].filter(Boolean))];
}

function commonPrefixLength(a, b) {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

function bigrams(value) {
  if (value.length < 2) return [value];
  const items = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    items.push(value.slice(index, index + 2));
  }
  return items;
}

function diceCoefficient(a, b) {
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  const used = new Set();
  let hits = 0;
  for (const bigram of aBigrams) {
    const index = bBigrams.findIndex((candidate, candidateIndex) => candidate === bigram && !used.has(candidateIndex));
    if (index >= 0) {
      used.add(index);
      hits += 1;
    }
  }
  return (2 * hits) / Math.max(aBigrams.length + bBigrams.length, 1);
}

function tokenSimilarity(token, keyword) {
  let best = 0;
  for (const normalizedToken of tokenVariants(token)) {
    for (const normalizedKeyword of tokenVariants(keyword)) {
      if (!normalizedToken || !normalizedKeyword) continue;
      if (normalizedToken === normalizedKeyword) best = Math.max(best, 1);
      const minLength = Math.min(normalizedToken.length, normalizedKeyword.length);
      const maxLength = Math.max(normalizedToken.length, normalizedKeyword.length);
      const lengthRatio = minLength / Math.max(maxLength, 1);
      if (normalizedToken.includes(" ") || normalizedKeyword.includes(" ")) continue;
      if (
        (normalizedToken.startsWith(normalizedKeyword) || normalizedKeyword.startsWith(normalizedToken)) &&
        lengthRatio >= 0.75
      ) {
        best = Math.max(best, 0.95);
      }
      if (minLength < 4) continue;

      const distance = editDistance(normalizedToken, normalizedKeyword);
      const editScore = distance === 99 ? 0 : 1 - distance / Math.max(normalizedToken.length, normalizedKeyword.length);
      const prefixScore = commonPrefixLength(normalizedToken, normalizedKeyword) / minLength;
      const diceScore = diceCoefficient(normalizedToken, normalizedKeyword);
      best = Math.max(best, editScore, prefixScore >= 0.82 && minLength >= 5 && lengthRatio >= 0.75 ? prefixScore : 0, diceScore);
    }
  }
  return best;
}

function tokenMatchesKeyword(token, keyword) {
  return tokenSimilarity(token, keyword) >= 0.72;
}

function countWordOccurrences(text, token) {
  const normalizedText = ` ${normalizeText(text)} `;
  let count = 0;
  for (const variant of tokenVariants(token)) {
    if (!variant) continue;
    const matches = normalizedText.match(new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"));
    count += matches ? matches.length : 0;
  }
  return count;
}

function isGenericNcmRow(row) {
  const text = normalizeText(`${row.descricao} ${parseJson(row.keywords_json, []).join(" ")}`);
  const parts = text.split(" ");
  return parts.includes("outro") || parts.includes("outros") || parts.includes("generico");
}

function isCuratedGenericNcmRow(keywords = []) {
  return keywords.some((keyword) => normalizeText(keyword) === "generico");
}

function isGenericHitTerm(term) {
  const normalized = normalizeText(term);
  return [
    "outro",
    "outros",
    "outra",
    "outras",
    "generico",
    "generica",
    "vivo",
    "viva",
    "vivos",
    "vivas",
    "tipo",
    "unidade",
    "natural",
    "naturais",
    "integral",
    "puro",
    "pura",
    "caseiro",
    "caseira",
    "artesanal"
  ].includes(normalized);
}

function primaryProductToken(tokens = []) {
  return tokens.find((token) => !isGenericHitTerm(token)) || tokens[0] || "";
}

function tokensContainInOrder(needles = [], haystack = []) {
  if (!needles.length) return false;
  let cursor = 0;
  for (const token of haystack) {
    if (token === needles[cursor] || tokenMatchesKeyword(token, needles[cursor])) {
      cursor += 1;
      if (cursor >= needles.length) return true;
    }
  }
  return false;
}

function phraseKeywordMatchesRaw(keyword, normalizedRaw, rawTokens = []) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword.includes(" ")) return false;
  if (normalizedRaw.includes(normalizedKeyword)) return true;
  const phraseTokens = extractTokens(normalizedKeyword);
  return phraseTokens.length >= 2 && tokensContainInOrder(phraseTokens, rawTokens);
}

function getNcmCandidateRows(tokens, rawQuery = "", limit = 800) {
  const rawDigits = extractSearchCode(rawQuery);
  const variants = [...new Set(tokens.flatMap((token) => tokenVariants(token)).filter((token) => token.length > 2))].slice(0, 36);
  const conditions = [];
  const values = [];
  for (const variant of variants) {
    conditions.push("(keywords_json LIKE ? OR descricao LIKE ?)");
    values.push(`%${variant}%`, `%${variant}%`);
  }
  if (rawDigits.length >= 4) {
    conditions.push("codigo LIKE ?");
    values.push(`%${rawDigits}%`);
  }
  if (!conditions.length) return [];
  values.push(limit);
  return db
    .prepare(
      `
      SELECT *
      FROM ncm_oficial
      WHERE ativo = 1 AND LENGTH(codigo) = 8 AND (${conditions.join(" OR ")})
      ORDER BY
        CASE WHEN source IN ('seed_mvp', 'siscomex_json_curated') THEN 0 ELSE 1 END,
        codigo
      LIMIT ?
    `
    )
    .all(...values);
}

function pickValue(row, names) {
  const keys = Object.keys(row || {});
  for (const name of names) {
    const normalized = normalizeText(name).replace(/\s/g, "");
    const key = keys.find((candidate) => normalizeText(candidate).replace(/\s/g, "") === normalized);
    if (key && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") return row[key];
  }
  return "";
}

function rowFallbackDescription(row) {
  return Object.entries(row || {})
    .filter(([key]) => !String(key).startsWith("__"))
    .map(([, value]) => String(value ?? "").trim())
    .filter(Boolean)
    .filter((value) => !/^\d+([,.]\d+)?$/.test(value))
    .join(" ")
    .trim();
}

function inferUnitFromDescription(description) {
  const text = String(description || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/\b\d+(?:[,.]\d+)?\s*(kg|kgs|quilo|quilos)\b/.test(text)) return "KG";
  if (/\b\d+(?:[,.]\d+)?\s*(g|gr|grama|gramas)\b/.test(text)) return "G";
  if (/\b\d+(?:[,.]\d+)?\s*(l|lt|litro|litros)\b/.test(text)) return "L";
  if (/\b\d+(?:[,.]\d+)?\s*(ml|mililitro|mililitros)\b/.test(text)) return "ML";
  if (/\b(un|und|unid|unidade|unidades|pc|pcs|peca|pecas)\b/.test(text)) return "UN";
  return "";
}

function mapProductRow(row, index = 0) {
  const descricao =
    pickValue(row, ["descricao", "descrição", "produto", "nome", "xprod", "descricao_produto"]) ||
    row.descricao ||
    row.descricao_original ||
    row.description ||
    rowFallbackDescription(row);
  const unidade = String(pickValue(row, ["unidade", "un", "ucom", "und"]) || "").trim();
  return {
    codigo_produto: String(pickValue(row, ["codigo_produto", "codigo", "código", "cod", "cprod"]) || index + 1),
    descricao_original: String(descricao || "").trim(),
    unidade: unidade || inferUnitFromDescription(descricao),
    preco: toNumber(pickValue(row, ["preco", "preço", "valor", "vuncom", "price"])),
    codigo_barras: String(pickValue(row, ["codigo_barras", "código_barras", "ean", "cean", "gtin"]) || "").trim(),
    peso: String(pickValue(row, ["peso", "weight"]) || "").trim(),
    marca: String(pickValue(row, ["marca", "brand"]) || "").trim(),
    categoria: String(pickValue(row, ["categoria", "category", "grupo"]) || "").trim(),
    ncm_importado: String(pickValue(row, ["ncm"]) || "").replace(/\D/g, "").slice(0, 8)
  };
}

function looksLikeHeader(cells) {
  const keys = cells.map((cell) => normalizeText(cell).replace(/\s/g, ""));
  return keys.some((key) =>
    [
      "descricao",
      "descricaoproduto",
      "produto",
      "nome",
      "xprod",
      "codigo",
      "codigoproduto",
      "cod",
      "cprod",
      "preco",
      "valor",
      "unidade",
      "ncm",
      "ean",
      "gtin"
    ].includes(key)
  );
}

function rowFromCells(cells, index, headers = null) {
  if (headers) {
    return Object.fromEntries(headers.map((header, headerIndex) => [header || `coluna_${headerIndex + 1}`, cells[headerIndex] || ""]));
  }
  const clean = cells.map((cell) => String(cell ?? "").trim()).filter(Boolean);
  return {
    codigo_produto: String(index + 1),
    descricao: clean.join(" "),
    __raw_values: clean
  };
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsvLine(line, delimiter) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function parseCsv(buffer) {
  const text = decodeText(buffer).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const sample = lines[0];
  const delimiters = [";", ",", "\t"];
  const delimiter = delimiters
    .map((candidate) => ({ candidate, count: sample.split(candidate).length }))
    .sort((a, b) => b.count - a.count)[0].candidate;

  const headers = parseCsvLine(lines[0], delimiter);
  const hasHeader = headers.some((header) => /descri|produto|codigo|preco|ncm/i.test(header));
  const rows = [];
  const start = hasHeader ? 1 : 0;
  for (let index = start; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index], delimiter);
    const row = {};
    if (hasHeader) {
      headers.forEach((header, headerIndex) => {
        row[header] = values[headerIndex] || "";
      });
    } else {
      row.descricao = values.join(" ").trim();
      row.codigo_produto = index + 1;
    }
    const product = mapProductRow(row, index);
    if (product.descricao_original) rows.push(product);
  }
  return rows;
}

function parseTxt(buffer) {
  const text = decodeText(buffer).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return text
    .split("\n")
    .map((line, index) => ({ codigo_produto: String(index + 1), descricao_original: line.trim() }))
    .filter((row) => row.descricao_original)
    .map((row, index) => ({ ...mapProductRow(row, index), descricao_original: row.descricao_original }));
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return decodeXml(match[1].trim());
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseXml(buffer) {
  const text = decodeText(buffer);
  const matches = [...text.matchAll(/<prod[^>]*>([\s\S]*?)<\/prod>/gi)];
  return matches
    .map((match, index) => {
      const xml = match[1];
      return mapProductRow(
        {
          cProd: tagValue(xml, "cProd"),
          xProd: tagValue(xml, "xProd"),
          uCom: tagValue(xml, "uCom"),
          vUnCom: tagValue(xml, "vUnCom"),
          cEAN: tagValue(xml, "cEAN"),
          NCM: tagValue(xml, "NCM"),
          CEST: tagValue(xml, "CEST")
        },
        index
      );
    })
    .filter((row) => row.descricao_original);
}

async function parseXlsx(buffer) {
  let XLSX;
  try {
    XLSX = await import("xlsx");
  } catch {
    const error = new Error("Para importar Excel instale as dependencias do backend com npm install.");
    error.status = 422;
    throw error;
  }
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return [];
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
    header: 1,
    defval: "",
    blankrows: false
  });
  if (!matrix.length) return [];
  const headers = looksLikeHeader(matrix[0])
    ? matrix[0].map((cell, index) => String(cell || `coluna_${index + 1}`).trim())
    : null;
  const rows = (headers ? matrix.slice(1) : matrix).map((cells, index) => rowFromCells(cells, index, headers));
  return rows.map(mapProductRow).filter((row) => row.descricao_original);
}

async function parseProductsFromFile(filename, buffer) {
  const extension = extname(filename || "").toLowerCase();
  if ([".xlsx", ".xls"].includes(extension)) return parseXlsx(buffer);
  if (extension === ".csv") return parseCsv(buffer);
  if (extension === ".txt") return parseTxt(buffer);
  if (extension === ".xml") return parseXml(buffer);
  return parseCsv(buffer);
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return { fields: {}, files: [] };
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const fields = {};
  const files = [];
  for (const rawPart of splitBuffer(buffer, boundary)) {
    let part = rawPart;
    if (part.length === 0) continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(0, 2).toString() === "--") continue;
    const separator = Buffer.from("\r\n\r\n");
    const headerEnd = part.indexOf(separator);
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    let content = part.subarray(headerEnd + separator.length);
    if (content.subarray(content.length - 2).toString() === "\r\n") {
      content = content.subarray(0, content.length - 2);
    }
    const name = /name="([^"]+)"/i.exec(headerText)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headerText)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] || "application/octet-stream";
    if (!name) continue;
    if (filename) files.push({ name, filename, type, buffer: content });
    else fields[name] = decodeText(content);
  }
  return { fields, files };
}

function getCompany() {
  return db.prepare("SELECT * FROM companies WHERE id = 1").get();
}

function getCompanyForFiscalUf(uf) {
  const company = getCompany();
  return {
    ...company,
    uf: normalizeUf(uf || company?.uf, "SP")
  };
}

function getFiscalUfForClassification(classification) {
  const company = getCompany();
  return normalizeUf(classification?.uf || classification?.batch_uf || company?.uf, "SP");
}

function upsertCompany(input) {
  const current = getCompany();
  const next = {
    razao_social: input.razao_social ?? current.razao_social ?? "",
    cnpj: input.cnpj ?? current.cnpj ?? "",
    inscricao_estadual: input.inscricao_estadual ?? current.inscricao_estadual ?? "",
    inscricao_municipal: input.inscricao_municipal ?? current.inscricao_municipal ?? "",
    crt: input.crt ?? current.crt ?? "1",
    regime_tributario: input.regime_tributario ?? current.regime_tributario ?? "simples_nacional",
    mei: input.mei ? 1 : 0,
    cnae_principal: input.cnae_principal ?? current.cnae_principal ?? "",
    cnaes_secundarios: input.cnaes_secundarios ?? current.cnaes_secundarios ?? "",
    uf: normalizeUf(input.uf ?? current.uf ?? "SP"),
    municipio: input.municipio ?? current.municipio ?? "",
    codigo_municipio_ibge: input.codigo_municipio_ibge ?? current.codigo_municipio_ibge ?? "",
    contribuinte_icms: input.contribuinte_icms === false ? 0 : 1
  };
  db.prepare(`
    UPDATE companies SET
      razao_social = ?, cnpj = ?, inscricao_estadual = ?, inscricao_municipal = ?,
      crt = ?, regime_tributario = ?, mei = ?, cnae_principal = ?, cnaes_secundarios = ?,
      uf = ?, municipio = ?, codigo_municipio_ibge = ?, contribuinte_icms = ?, updated_at = ?
    WHERE id = 1
  `).run(
    next.razao_social,
    next.cnpj,
    next.inscricao_estadual,
    next.inscricao_municipal,
    next.crt,
    next.regime_tributario,
    next.mei,
    next.cnae_principal,
    next.cnaes_secundarios,
    next.uf,
    next.municipio,
    next.codigo_municipio_ibge,
    next.contribuinte_icms,
    now()
  );
  logAudit("company", 1, "update", input.actor || "contador", current, getCompany());
  return getCompany();
}

function logAudit(entityType, entityId, action, actor, previous, next, meta = {}) {
  db.prepare(`
    INSERT INTO audit_logs (
      entity_type, entity_id, action, actor, previous_json, next_json,
      source_table, table_version, effective_date, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entityType,
    entityId || null,
    action,
    actor || "sistema",
    asJson(previous),
    asJson(next),
    meta.source_table || null,
    meta.table_version || null,
    meta.effective_date || null,
    now()
  );
}

function assertResetPassword(payload = {}) {
  if (String(payload.reset_password || "") !== RESET_PASSWORD) {
    const error = new Error("Senha de reset invalida.");
    error.status = 403;
    throw error;
  }
}

function scoreNcmCandidate(row, tokens, rawQuery = "") {
  const keywords = parseJson(row.keywords_json, []);
  const terms = [...new Set([...keywords, ...extractTokens(row.descricao)])].filter(Boolean);
  const searchableText = `${row.descricao} ${keywords.join(" ")}`;
  const normalizedRaw = normalizeText(rawQuery);
  const normalizedDescription = normalizeText(row.descricao);
  const descriptionExactHit = Boolean(normalizedRaw && normalizedDescription && normalizedRaw === normalizedDescription);
  const descriptionPrefixHit = Boolean(
    !descriptionExactHit &&
      normalizedRaw &&
      normalizedDescription &&
      tokens.length > 1 &&
      normalizedRaw.startsWith(`${normalizedDescription} `)
  );
  const rawDigits = extractSearchCode(rawQuery);
  const phraseHits = keywords
    .map((keyword) => normalizeText(keyword))
    .filter((keyword) => phraseKeywordMatchesRaw(keyword, normalizedRaw, tokens));
  const tokenScores = tokens.map((token) => {
    let bestTerm = "";
    let bestScore = 0;
    let occurrences = 0;
    for (const term of terms) {
      const score = tokenSimilarity(token, term);
      if (score > bestScore) {
        bestScore = score;
        bestTerm = term;
      }
    }
    occurrences = countWordOccurrences(searchableText, token);
    return { token, term: bestTerm, score: bestScore, occurrences };
  });
  const hits = tokenScores.filter((item) => item.score >= 0.82);
  const meaningfulHits = hits.filter((hit) => !isGenericHitTerm(hit.term));
  const primaryToken = primaryProductToken(tokens);
  const primaryScore = tokenScores.find((item) => item.token === primaryToken);
  const phrasePrimaryHit = Boolean(
    primaryToken && phraseHits.some((phrase) => phrase.split(" ").includes(primaryToken) || phrase.includes(primaryToken))
  );
  const primaryHit = !primaryToken || phrasePrimaryHit || (primaryScore?.score >= 0.82 && !isGenericHitTerm(primaryScore.term));
  const average = tokenScores.reduce((sum, item) => sum + item.score, 0) / Math.max(tokens.length, 1);
  const matchedTokens = Math.min(tokens.length, meaningfulHits.length + phraseHits.length) / Math.max(tokens.length, 1);
  const occurrenceScore = Math.min(0.18, meaningfulHits.reduce((sum, item) => sum + item.occurrences, 0) * 0.03);
  const exactBonus = meaningfulHits.some((hit) => hit.score >= 0.95) ? 0.12 : 0;
  const descriptionBonus = descriptionExactHit ? 0.24 : descriptionPrefixHit ? 0.14 : 0;
  const codeBonus = rawDigits.length >= 4 && row.codigo.includes(rawDigits) ? 0.5 : 0;
  const phraseBonus = Math.min(0.3, phraseHits.length * 0.15);
  const curatedGeneric = isCuratedGenericNcmRow(keywords);
  const curatedSource = ["seed_mvp", "siscomex_json_curated"].includes(row.source);
  const curatedSourceBonus = curatedSource ? 0.08 : 0;
  const primaryBonus = primaryHit ? 0.18 : 0;
  const missingPrimaryPenalty = primaryToken && !primaryHit && tokens.length > 1 ? 0.35 : 0;
  const maxScore = curatedSource ? 1.35 : 1.25;
  return {
    score: Math.max(
      0,
      Math.min(
        maxScore,
        average +
          matchedTokens * 0.35 +
          occurrenceScore +
          exactBonus +
          descriptionBonus +
          codeBonus +
          phraseBonus +
          curatedSourceBonus +
          primaryBonus -
          missingPrimaryPenalty
      )
    ),
    hits: [...new Set([...meaningfulHits.map((hit) => hit.term), ...phraseHits])],
    token_scores: tokenScores,
    keywords,
    occurrence_count: tokenScores.reduce((sum, item) => sum + item.occurrences, 0),
    meaningful_hit_count: meaningfulHits.length + phraseHits.length,
    primary_token: primaryToken,
    primary_hit: primaryHit,
    phrase_hits: phraseHits,
    description_exact_hit: descriptionExactHit,
    description_prefix_hit: descriptionPrefixHit,
    curated_source: curatedSource,
    curated_generic: curatedGeneric
  };
}

function findNcmMatch(product, tokens, options = {}) {
  const useImportedNcm = options.useImportedNcm !== false;
  if (useImportedNcm && product.ncm_importado) {
    const existing = db.prepare("SELECT * FROM ncm_oficial WHERE codigo = ?").get(product.ncm_importado);
    return {
      codigo: product.ncm_importado,
      descricao: existing?.descricao || "NCM importado do XML/planilha",
      score: 0.92,
      source: "arquivo_importado"
    };
  }

  const catalog = getNcmCandidateRows(tokens, product.descricao_original || "");
  const scoredCandidates = catalog
    .map((item) => {
    const scored = scoreNcmCandidate(item, tokens, product.descricao_original || "");
      return {
        codigo: item.codigo,
        descricao: item.descricao,
        score: scored.score,
        source: "ncm_similarity",
        hits: scored.hits,
        token_scores: scored.token_scores,
        occurrence_count: scored.occurrence_count,
        meaningful_hit_count: scored.meaningful_hit_count,
        primary_token: scored.primary_token,
        primary_hit: scored.primary_hit,
        phrase_hits: scored.phrase_hits,
        description_exact_hit: scored.description_exact_hit,
        description_prefix_hit: scored.description_prefix_hit,
        curated_source: scored.curated_source,
        curated_generic: scored.curated_generic
      };
    })
    .filter((item) => item.score >= 0.45 && item.meaningful_hit_count > 0);
  const primaryCandidates = scoredCandidates.some((item) => item.primary_hit)
    ? scoredCandidates.filter((item) => item.primary_hit)
    : scoredCandidates;
  const preferredCandidates = primaryCandidates.some((item) => item.curated_source)
    ? primaryCandidates.filter((item) => item.curated_source)
    : primaryCandidates;
  const best = preferredCandidates.sort(
    (a, b) => ncmSearchRank(b, tokens.length) - ncmSearchRank(a, tokens.length) || a.codigo.localeCompare(b.codigo)
  )[0];
  if (best && best.score >= 0.45 && best.meaningful_hit_count > 0) return best;
  return {
    codigo: "00000000",
    descricao: "Nao identificado - revisar com contador",
    score: 0.2,
    source: "fallback_revisao"
  };
}

function scoreNcmSearchRow(row, tokens, rawQuery) {
  const scored = scoreNcmCandidate(row, tokens, rawQuery);
  return {
    score: scored.score,
    hits: scored.hits,
    keywords: scored.keywords,
    token_scores: scored.token_scores,
    occurrence_count: scored.occurrence_count,
    meaningful_hit_count: scored.meaningful_hit_count,
    primary_token: scored.primary_token,
    primary_hit: scored.primary_hit,
    phrase_hits: scored.phrase_hits,
    description_exact_hit: scored.description_exact_hit,
    description_prefix_hit: scored.description_prefix_hit,
    curated_source: scored.curated_source,
    curated_generic: scored.curated_generic
  };
}

function isCloseNcmScore(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.18;
}

function shouldPreferNcmCandidate(scored, best) {
  if (!best) return true;
  if (scored.score > best.score + 0.18) return true;
  if (isCloseNcmScore(scored.score, best.score)) {
    if (scored.description_exact_hit && !best.description_exact_hit) return true;
    if (scored.description_prefix_hit && !best.description_prefix_hit) return true;
    if (scored.curated_source && !best.curated_source) return true;
    if ((scored.meaningful_hit_count || 0) > (best.meaningful_hit_count || 0)) return true;
  }
  return scored.score > best.score;
}

function compareDescValue(a, b) {
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}

function compareNcmRows(a, b, tokenCount) {
  if (tokenCount <= 1) {
    return (
      compareDescValue(Number(a.description_exact_hit), Number(b.description_exact_hit)) ||
      compareDescValue(Number(a.description_prefix_hit), Number(b.description_prefix_hit)) ||
      compareDescValue(Number(a.curated_source), Number(b.curated_source)) ||
      compareDescValue(a.meaningful_hit_count || 0, b.meaningful_hit_count || 0) ||
      compareDescValue(a.score, b.score) ||
      a.codigo.localeCompare(b.codigo)
    );
  }

  const scoreDelta = b.score - a.score;
  if (Math.abs(scoreDelta) > 0.18) return compareDescValue(a.score, b.score);
  return (
    compareDescValue(Number(a.description_exact_hit), Number(b.description_exact_hit)) ||
    compareDescValue(Number(a.description_prefix_hit), Number(b.description_prefix_hit)) ||
    compareDescValue(Number(a.curated_source), Number(b.curated_source)) ||
    compareDescValue(a.meaningful_hit_count || 0, b.meaningful_hit_count || 0) ||
    compareDescValue(a.score, b.score) ||
    a.codigo.localeCompare(b.codigo)
  );
}

function ncmSearchRank(row, tokenCount) {
  return (
    (row.primary_hit ? 220 : 0) +
    (row.phrase_hits?.length || 0) * 170 +
    (row.description_exact_hit ? 260 : 0) +
    (row.description_prefix_hit ? 120 : 0) +
    (row.curated_source ? 100 : 0) +
    (row.meaningful_hit_count || 0) * 10 +
    Number(row.score || 0)
  );
}

function getFiscalTablesForNcm(ncm) {
  const ncmPrefix = `${String(ncm || "").slice(0, 4)}%`;
  const exactNcm = String(ncm || "");
  return {
    cest: db.prepare("SELECT * FROM cest WHERE ncm = ? OR ncm LIKE ? ORDER BY codigo_cest LIMIT 20").all(exactNcm, ncmPrefix),
    tipi: db.prepare("SELECT * FROM tipi WHERE ncm = ? OR ncm LIKE ? ORDER BY vigencia DESC LIMIT 20").all(exactNcm, ncmPrefix),
    pis_cofins: db.prepare("SELECT * FROM regras_pis_cofins_por_ncm WHERE ncm = ? ORDER BY ncm DESC LIMIT 10").all(exactNcm),
    cbenef: db.prepare("SELECT * FROM cbenef_uf WHERE ncm = ? OR ncm LIKE ? ORDER BY uf, codigo_beneficio LIMIT 20").all(exactNcm, ncmPrefix),
    ibs_cbs_cst: db.prepare("SELECT * FROM ibs_cbs_cst ORDER BY codigo LIMIT 20").all(),
    ibs_cbs_classificacao: db.prepare("SELECT * FROM ibs_cbs_classificacao ORDER BY cclass_trib LIMIT 20").all()
  };
}

function scoreTextSearch(text, tokens, rawQuery = "") {
  const normalizedText = normalizeText(text);
  const rawDigits = extractSearchCode(rawQuery);
  const terms = extractTokens(text);
  const hits = tokens.filter((token) => normalizedText.includes(token) || terms.some((term) => tokenMatchesKeyword(token, term)));
  const codeHit = rawDigits && normalizedText.replace(/\D/g, "").includes(rawDigits);
  return {
    score: hits.length + (codeHit ? 4 : 0),
    hits: [...new Set(hits)]
  };
}

function searchRowsInBase({ key, label, table, fields, tokens, rawQuery, limit = 25 }) {
  const rows = db.prepare(`SELECT * FROM ${table} LIMIT 1000`).all();
  const items = rows
    .map((row) => {
      const searchable = fields.map((field) => row[field] ?? "").join(" ");
      const scored = scoreTextSearch(searchable, tokens, rawQuery);
      return { ...row, score: scored.score, hits: scored.hits };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { key, label, count: items.length, items };
}

function searchAllBases(rawQuery, tokens) {
  const definitions = [
    { key: "ncm_oficial", label: "NCM oficial", table: "ncm_oficial", fields: ["codigo", "descricao"] },
    { key: "cfop_oficial", label: "CFOP oficial", table: "cfop_oficial", fields: ["codigo", "descricao", "tipo", "entrada_saida"] },
    { key: "regras_cfop", label: "CFOP por operacao", table: "regras_cfop", fields: ["tipo_operacao", "uf_origem", "uf_destino", "origem_mercadoria", "cfop"] },
    { key: "origem_mercadoria", label: "Origem da mercadoria", table: "origem_mercadoria", fields: ["codigo", "descricao"] },
    { key: "cst_icms", label: "CST ICMS", table: "cst_icms", fields: ["codigo", "descricao"] },
    { key: "csosn", label: "CSOSN", table: "csosn", fields: ["codigo", "descricao"] },
    { key: "cst_pis", label: "CST PIS", table: "cst_pis", fields: ["codigo", "descricao"] },
    { key: "cst_cofins", label: "CST COFINS", table: "cst_cofins", fields: ["codigo", "descricao"] },
    { key: "ibs_cbs_cst", label: "CST IBS/CBS", table: "ibs_cbs_cst", fields: ["codigo", "descricao"] },
    { key: "ibs_cbs_classificacao", label: "cClassTrib IBS/CBS", table: "ibs_cbs_classificacao", fields: ["cclass_trib", "descricao", "cst_permitido", "indicadores"] },
    { key: "cest", label: "CEST/ST", table: "cest", fields: ["codigo_cest", "ncm", "descricao", "segmento", "item_segmento"] },
    { key: "tipi", label: "TIPI/IPI", table: "tipi", fields: ["ncm", "descricao", "ex_tipi", "vigencia"] },
    { key: "regras_pis_cofins_por_ncm", label: "PIS/COFINS por NCM", table: "regras_pis_cofins_por_ncm", fields: ["ncm", "tipo_incidencia"] },
    { key: "cbenef_uf", label: "cBenef por UF", table: "cbenef_uf", fields: ["uf", "codigo_beneficio", "cst", "descricao", "ncm"] },
    { key: "ibge_municipios", label: "IBGE municípios", table: "ibge_municipios", fields: ["codigo_municipio_ibge", "nome_municipio", "uf", "codigo_uf"] },
    { key: "ibpt", label: "IBPT", table: "ibpt", fields: ["ncm", "uf", "fonte", "chave"] }
  ];

  return definitions
    .map((definition) => searchRowsInBase({ ...definition, tokens, rawQuery }))
    .filter((base) => base.items.length > 0);
}

function searchFiscal(query, limit = 20) {
  const rawQuery = String(query || "").trim();
  const tokens = extractTokens(rawQuery);
  const rawDigits = extractSearchCode(rawQuery);
  if (!rawQuery || (tokens.length === 0 && !rawDigits)) {
    return { query: rawQuery, ncm: [], base_results: [] };
  }

  const catalog = getNcmCandidateRows(tokens, rawQuery, 1000);
  const scoredNcm = catalog
    .map((row) => {
      const scored = scoreNcmSearchRow(row, tokens, rawQuery);
      return {
        codigo: row.codigo,
        descricao: row.descricao,
        data_inicio: row.data_inicio,
        data_fim: row.data_fim,
        ativo: Boolean(row.ativo),
        source: row.source,
        score: scored.score,
        hits: scored.hits,
        keywords: scored.keywords,
        token_scores: scored.token_scores,
        occurrence_count: scored.occurrence_count,
        meaningful_hit_count: scored.meaningful_hit_count,
        primary_token: scored.primary_token,
        primary_hit: scored.primary_hit,
        phrase_hits: scored.phrase_hits,
        curated_source: scored.curated_source,
        curated_generic: scored.curated_generic,
        tabelas: getFiscalTablesForNcm(row.codigo)
      };
    })
    .filter((row) => row.score > 0 && (row.meaningful_hit_count > 0 || (rawDigits.length >= 4 && String(row.codigo).includes(rawDigits))));
  const primaryNcm = scoredNcm.some((row) => row.primary_hit)
    ? scoredNcm.filter((row) => row.primary_hit || (rawDigits.length >= 4 && String(row.codigo).includes(rawDigits)))
    : scoredNcm;
  const preferredNcm = primaryNcm.some((row) => row.curated_source) ? primaryNcm.filter((row) => row.curated_source) : primaryNcm;
  const ncm = preferredNcm
    .sort((a, b) => ncmSearchRank(b, tokens.length) - ncmSearchRank(a, tokens.length) || a.codigo.localeCompare(b.codigo))
    .slice(0, Math.min(Number(limit || 20), 50));

  return { query: rawQuery, ncm, base_results: searchAllBases(rawQuery, tokens) };
}

function normalizeNcmCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function getOfficialNcmRow(codigo) {
  const clean = normalizeNcmCode(codigo);
  if (!clean || clean === "00000000") return null;
  return db.prepare("SELECT * FROM ncm_oficial WHERE codigo = ? AND ativo = 1 AND LENGTH(codigo) = 8").get(clean) || null;
}

function ncmRobotConfig() {
  const hasBrave = Boolean(process.env.BRAVE_SEARCH_API_KEY);
  const hasSerpApi = Boolean(process.env.SERPAPI_KEY);
  const hasGoogle = Boolean(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX);
  let provider = null;
  if ((NCM_WEB_EVIDENCE_PROVIDER === "auto" || NCM_WEB_EVIDENCE_PROVIDER === "brave") && hasBrave) provider = "brave";
  else if ((NCM_WEB_EVIDENCE_PROVIDER === "auto" || NCM_WEB_EVIDENCE_PROVIDER === "serpapi") && hasSerpApi) provider = "serpapi";
  else if ((NCM_WEB_EVIDENCE_PROVIDER === "auto" || NCM_WEB_EVIDENCE_PROVIDER === "google") && hasGoogle) provider = "google";
  return {
    official_source: NCM_JSON_URL,
    local_search_cost: "R$ 0 por consulta. Usa SQLite e a tabela oficial baixada.",
    sync_cost: "R$ 0. Baixa a base publica do Siscomex quando voce clicar em sincronizar.",
    hosting_cost_note: "Se rodar nesse PC, o custo e so energia/internet. Em nuvem, depende do provedor.",
    web_evidence: {
      configured: Boolean(provider),
      provider,
      requested_provider: NCM_WEB_EVIDENCE_PROVIDER,
      limit: NCM_WEB_EVIDENCE_LIMIT,
      required_env: [
        "BRAVE_SEARCH_API_KEY",
        "SERPAPI_KEY",
        "GOOGLE_CSE_KEY + GOOGLE_CSE_CX"
      ],
      policy: "A web e a fonte principal do classificador automatico; a base local entra apenas como apoio de contexto."
    },
    openai: aiNcmConfig(),
    external_ai_cost: OPENAI_API_KEY
      ? "Classificador automatico configurado. Cada consulta usa creditos conforme o modelo escolhido."
      : "Classificador automatico nao configurado. Coloque a chave no AutoBack/.env para ativar."
  };
}

function aiNcmConfig() {
  return {
    configured: Boolean(OPENAI_API_KEY),
    model: OPENAI_NCM_MODEL,
    apply_threshold: OPENAI_NCM_APPLY_THRESHOLD,
    max_output_tokens: OPENAI_NCM_MAX_OUTPUT_TOKENS,
    concurrency: OPENAI_NCM_CONCURRENCY,
    api_url: OPENAI_NCM_API_URL.replace(/\/v1\/responses.*/, "/v1/responses"),
    web_search_enabled: OPENAI_NCM_WEB_SEARCH_ENABLED,
    key_hint: OPENAI_API_KEY ? `${OPENAI_API_KEY.slice(0, 7)}...${OPENAI_API_KEY.slice(-4)}` : null,
    billing: aiBillingConfig(),
    engine: "aikkie_fiscal_2_0",
    layers: ["produto", "empresa", "operacao"],
    policy: "Web-first: o classificador pesquisa os dados fiscais do produto e aplica o retorno quando o NCM tem 8 digitos validos, sem depender de referencias locais ou aprendizado."
  };
}

function getAppSetting(key, fallback = null) {
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key);
  if (!row) return fallback;
  return parseJson(row.value_json, fallback);
}

function setAppSetting(key, value) {
  db.prepare(
    `
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `
  ).run(key, asJson(value), now());
  return value;
}

function billingEnabled() {
  return AI_BILLING_DEFAULT_ENABLED;
}

function moneyFromCents(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

function normalizeMercadoPagoPaymentId(value) {
  const clean = String(value ?? "").trim();
  const match = clean.match(/^(\d+)\.0+$/);
  return match ? match[1] : clean;
}

function aiBillingConfig() {
  const enabled = billingEnabled();
  const activeProcessing = getActiveAiProcessingEvent();
  return {
    enabled,
    mode: "mercado_pago_pix_qr",
    price_cents: AI_BILLING_PRICE_CENTS,
    price_brl: moneyFromCents(AI_BILLING_PRICE_CENTS),
    currency: "BRL",
    mercado_pago_configured: Boolean(MERCADO_PAGO_ACCESS_TOKEN),
    mercado_pago_token_hint: MERCADO_PAGO_ACCESS_TOKEN ? `${MERCADO_PAGO_ACCESS_TOKEN.slice(0, 8)}...${MERCADO_PAGO_ACCESS_TOKEN.slice(-4)}` : null,
    processing_locked: Boolean(activeProcessing),
    active_processing: activeProcessing ? publicBillingFromEvent(activeProcessing) : null,
    note: "Pagamento do classificador sempre ligado: cada uso gera Pix Mercado Pago antes de processar."
  };
}

function billingPayerEmail() {
  const configured = String(process.env.AI_BILLING_PAYER_EMAIL || "").trim();
  const email = configured || AI_BILLING_DEFAULT_PAYER_EMAIL;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : AI_BILLING_DEFAULT_PAYER_EMAIL;
}

function setAiBillingEnabled(enabled, actor = "contador") {
  const next = aiBillingConfig();
  logAudit("settings", null, "billing_always_enabled", actor, { requested_enabled: Boolean(enabled) }, next);
  return next;
}

async function createMercadoPagoPixPayment({ description, amountCents, quantity, metadata }) {
  if (!MERCADO_PAGO_ACCESS_TOKEN) {
    const error = new Error("Mercado Pago nao configurado. Coloque MERCADO_PAGO_ACCESS_TOKEN no AutoBack/.env.");
    error.status = 422;
    throw error;
  }
  const externalReference = `ai-ncm-${randomUUID()}`;
  const idempotencyKey = randomUUID();
  const response = await fetch(`${MERCADO_PAGO_API_URL}/v1/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      transaction_amount: moneyFromCents(amountCents),
      description,
      payment_method_id: "pix",
      external_reference: externalReference,
      payer: {
        email: billingPayerEmail(),
        first_name: "Cliente",
        last_name: "Aikkie"
      },
      metadata: {
        ...metadata,
        quantity,
        unit_price_cents: AI_BILLING_PRICE_CENTS,
        amount_cents: amountCents,
        source: "aikkie_autoclass_ai_ncm"
      }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Mercado Pago HTTP ${response.status}`;
    const error = new Error(`Falha no Mercado Pago: ${message}`);
    error.status = 502;
    throw error;
  }
  const transactionData = payload.point_of_interaction?.transaction_data || {};
  if (!transactionData.qr_code && !transactionData.qr_code_base64) {
    const error = new Error("Mercado Pago nao retornou QR Code Pix.");
    error.status = 502;
    error.details = {
      status: payload?.status,
      payment_id: payload?.id
    };
    throw error;
  }
  return {
    provider: "mercado_pago",
    external_reference: externalReference,
    payment_id: normalizeMercadoPagoPaymentId(payload.id || ""),
    payment_status: payload.status || "pending",
    status_detail: payload.status_detail || null,
    qr_code_base64: transactionData.qr_code_base64 || null,
    qr_code: transactionData.qr_code || null,
    ticket_url: transactionData.ticket_url || null,
    checkout_url: transactionData.ticket_url || null,
    idempotency_key: idempotencyKey,
    status: "pix_qr_created"
  };
}

async function prepareAiBilling({ classificationId = null, quantity = 1, actor = "contador", context = "item" } = {}) {
  const config = aiBillingConfig();
  const cleanQuantity = Math.max(1, Number(quantity || 1));
  const amountCents = AI_BILLING_PRICE_CENTS * cleanQuantity;
  if (!config.enabled) {
    return {
      enabled: false,
      status: "disabled",
      quantity: cleanQuantity,
      amount_cents: 0,
      amount_brl: 0,
      message: "Pagamento do classificador obrigatorio."
    };
  }
  assertAiProcessingUnlocked();

  const insert = db.prepare(
    `
    INSERT INTO ai_billing_events (
      classification_id, quantity, amount_cents, currency, status, provider,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'BRL', 'pending', 'mercado_pago', ?, ?, ?)
  `
  ).run(
    classificationId,
    cleanQuantity,
    amountCents,
    asJson({ actor, context, unit_price_cents: AI_BILLING_PRICE_CENTS }),
    now(),
    now()
  );
  const eventId = Number(insert.lastInsertRowid);
  try {
    const payment = await createMercadoPagoPixPayment({
      description: "Conferencia e sugestao de NCM no Aikkie AutoClass Fiscal",
      amountCents,
      quantity: cleanQuantity,
      metadata: { billing_event_id: eventId, classification_id: classificationId, actor, context }
    });
    db.prepare(
      `
      UPDATE ai_billing_events
      SET status = ?, provider_reference = ?, checkout_url = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(
      payment.status,
      payment.payment_id || payment.external_reference,
      payment.ticket_url,
      asJson({ actor, context, unit_price_cents: AI_BILLING_PRICE_CENTS, payment }),
      now(),
      eventId
    );
    return {
      enabled: true,
      event_id: eventId,
      context,
      classification_id: classificationId,
      status: payment.status,
      paid: false,
      requires_payment: true,
      quantity: cleanQuantity,
      amount_cents: amountCents,
      amount_brl: moneyFromCents(amountCents),
      payment_id: payment.payment_id,
      payment_status: payment.payment_status,
      qr_code_base64: payment.qr_code_base64,
      qr_code: payment.qr_code,
      ticket_url: payment.ticket_url,
      checkout_url: payment.ticket_url,
      message: `Pix Mercado Pago gerado: R$ ${moneyFromCents(amountCents).toFixed(2)}. Pague para iniciar a auto classificacao.`
    };
  } catch (error) {
    db.prepare("UPDATE ai_billing_events SET status = 'error', metadata_json = ?, updated_at = ? WHERE id = ?").run(
      asJson({ actor, context, error: error.message }),
      now(),
      eventId
    );
    throw error;
  }
}

function rowToAiBillingEvent(row) {
  return row ? { ...row, metadata: parseJson(row.metadata_json, {}) } : null;
}

function getAiBillingEvent(id) {
  const eventId = Number(id || 0);
  if (!eventId) return null;
  const row = db.prepare("SELECT * FROM ai_billing_events WHERE id = ?").get(eventId);
  return rowToAiBillingEvent(row);
}

function getAiBillingEventByProviderReference(reference) {
  const cleanReference = String(reference || "").trim();
  if (!cleanReference) return null;
  const normalized = normalizeMercadoPagoPaymentId(cleanReference);
  const variants = [cleanReference, normalized];
  if (/^\d+$/.test(normalized)) variants.push(`${normalized}.0`);
  for (const value of [...new Set(variants)]) {
    const row = db
      .prepare("SELECT * FROM ai_billing_events WHERE provider = 'mercado_pago' AND provider_reference = ? ORDER BY id DESC LIMIT 1")
      .get(value);
    if (row) return rowToAiBillingEvent(row);
  }
  return null;
}

function getAiBillingEventByPaymentId(paymentId) {
  return getAiBillingEventByProviderReference(paymentId);
}

function clampProgressPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function normalizeAiNcmConcurrency(value = OPENAI_NCM_CONCURRENCY) {
  return OPENAI_NCM_CONCURRENCY;
}

function buildAiBillingProgress(progress = {}, defaults = {}) {
  const rawTotal = Number(progress.total ?? defaults.total ?? 0);
  const total = Number.isFinite(rawTotal) ? Math.max(0, Math.round(rawTotal)) : 0;
  const rawProcessed = Number(progress.processed ?? defaults.processed ?? 0);
  const processed = Number.isFinite(rawProcessed)
    ? Math.min(total || Math.max(0, Math.round(rawProcessed)), Math.max(0, Math.round(rawProcessed)))
    : 0;
  const percent = total > 0
    ? clampProgressPercent((processed / total) * 100)
    : clampProgressPercent(progress.percent ?? defaults.percent ?? (progress.status === "completed" ? 100 : 0));
  const concurrency = normalizeAiNcmConcurrency(progress.concurrency ?? defaults.concurrency ?? OPENAI_NCM_CONCURRENCY);
  const rawActiveWorkers = Number(progress.active_workers ?? defaults.active_workers ?? 0);
  const activeWorkers = Number.isFinite(rawActiveWorkers) ? Math.min(concurrency, Math.max(0, Math.round(rawActiveWorkers))) : 0;
  const rawFailed = Number(progress.failed ?? defaults.failed ?? 0);
  const failed = Number.isFinite(rawFailed) ? Math.max(0, Math.round(rawFailed)) : 0;
  const runningItems = Array.isArray(progress.running_items)
    ? progress.running_items.slice(0, concurrency)
    : Array.isArray(defaults.running_items)
      ? defaults.running_items.slice(0, concurrency)
      : [];

  return {
    status: progress.status || defaults.status || "waiting",
    total,
    processed,
    percent,
    concurrency,
    active_workers: activeWorkers,
    failed,
    message: progress.message || defaults.message || null,
    current_item: progress.current_item ?? defaults.current_item ?? null,
    running_items: runningItems,
    started_at: progress.started_at || defaults.started_at || null,
    updated_at: progress.updated_at || defaults.updated_at || null,
    completed_at: progress.completed_at || defaults.completed_at || null
  };
}

function updateBillingAiProgress(eventId, patch = {}) {
  const event = getAiBillingEvent(eventId);
  if (!event) return null;
  const metadata = event.metadata || {};
  const previousProgress = metadata.ai_progress || {};
  const nextProgress = buildAiBillingProgress(
    {
      ...previousProgress,
      ...patch,
      updated_at: now()
    },
    {
      total: event.quantity || 1,
      processed: 0,
      status: "processing"
    }
  );
  db.prepare("UPDATE ai_billing_events SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
    asJson({ ...metadata, ai_progress: nextProgress }),
    now(),
    event.id
  );
  return nextProgress;
}

function getAiBillingEventFromPaymentPayload(paymentPayload = {}) {
  const metadata = paymentPayload.metadata || {};
  const metadataEvent = getAiBillingEvent(metadata.billing_event_id || metadata.billingEventId);
  if (metadataEvent) return metadataEvent;

  const direct =
    getAiBillingEventByProviderReference(paymentPayload.id) ||
    getAiBillingEventByProviderReference(paymentPayload.external_reference);
  if (direct) return direct;

  const references = new Set(
    [paymentPayload.id, paymentPayload.external_reference]
      .map((value) => normalizeMercadoPagoPaymentId(value))
      .filter(Boolean)
  );
  if (!references.size) return null;

  const rows = db
    .prepare("SELECT * FROM ai_billing_events WHERE provider = 'mercado_pago' ORDER BY id DESC LIMIT 100")
    .all();
  for (const row of rows) {
    const event = rowToAiBillingEvent(row);
    const payment = event?.metadata?.payment || {};
    const eventReferences = [payment.payment_id, payment.external_reference, payment.id, event.provider_reference]
      .map((value) => normalizeMercadoPagoPaymentId(value))
      .filter(Boolean);
    if (eventReferences.some((reference) => references.has(reference))) return event;
  }
  return null;
}

function publicBillingFromEvent(event, overrides = {}) {
  const metadata = event?.metadata || parseJson(event?.metadata_json, {});
  const payment = metadata?.payment || {};
  const paymentStatus = overrides.payment_status || payment.payment_status || event?.status || "pending";
  const paid = paymentStatus === "approved" || overrides.status === "paid" || event?.status === "paid";
  const publicStatus = paid && event?.status === "processing_ai" ? "processing_ai" : paid ? "paid" : overrides.status || event?.status || "pending";
  const aiError = metadata?.ai_processing_error?.message || null;
  const quantity = Number(event?.quantity || overrides.quantity || 1);
  const progress = buildAiBillingProgress(metadata?.ai_progress || {}, {
    total: quantity,
    processed: metadata?.ai_processed_at ? quantity : 0,
    percent: metadata?.ai_processed_at ? 100 : 0,
    status: aiError ? "error" : metadata?.ai_processed_at ? "completed" : metadata?.ai_processing_started_at ? "processing" : paid ? "paid" : "waiting",
    message: aiError
      ? `Falha na auto classificacao: ${aiError}`
      : metadata?.ai_processed_at
        ? "Completo."
        : metadata?.ai_processing_started_at
          ? "Auto classificacao em andamento. Nao feche o navegador."
          : paid
            ? "Pagamento confirmado. Iniciando auto classificacao."
            : "Aguardando pagamento."
  });
  return {
    enabled: true,
    event_id: event?.id || overrides.event_id || null,
    context: metadata?.context || overrides.context || null,
    classification_id: event?.classification_id || overrides.classification_id || null,
    status: publicStatus,
    paid,
    requires_payment: !paid,
    ai_processing: Boolean(metadata?.ai_processing_started_at && !metadata?.ai_processed_at),
    ai_processed: Boolean(metadata?.ai_processed_at),
    ai_error: aiError,
    quantity,
    amount_cents: Number(event?.amount_cents || overrides.amount_cents || 0),
    amount_brl: moneyFromCents(event?.amount_cents || overrides.amount_cents || 0),
    progress,
    progress_percent: progress.percent,
    progress_processed: progress.processed,
    progress_total: progress.total,
    payment_id: overrides.payment_id || payment.payment_id || event?.provider_reference || null,
    payment_status: paymentStatus,
    status_detail: overrides.status_detail || payment.status_detail || null,
    qr_code_base64: overrides.qr_code_base64 || payment.qr_code_base64 || null,
    qr_code: overrides.qr_code || payment.qr_code || null,
    ticket_url: overrides.ticket_url || payment.ticket_url || event?.checkout_url || null,
    checkout_url: overrides.checkout_url || payment.ticket_url || event?.checkout_url || null,
    message: aiError
      ? `Pagamento confirmado, mas a auto classificacao falhou: ${aiError}`
      : publicStatus === "processing_ai"
        ? "Pagamento confirmado. Auto classificacao em andamento."
        : paid
          ? "Pagamento confirmado. Auto classificacao liberada."
          : "Pagamento ainda nao confirmado."
  };
}

function isAiBillingProcessingEvent(event) {
  const metadata = event?.metadata || {};
  if (!event || metadata.ai_processed_at || metadata.ai_processing_error) return false;
  if (event.status !== "processing_ai" && !metadata.ai_processing_started_at) return false;
  const startedAt = metadata.ai_processing_started_at ? Date.parse(metadata.ai_processing_started_at) : 0;
  if (!startedAt) return event.status === "processing_ai";
  return Date.now() - startedAt < AI_BILLING_PROCESSING_LOCK_MS;
}

function getActiveAiProcessingEvent() {
  const rows = db
    .prepare("SELECT * FROM ai_billing_events WHERE status = 'processing_ai' ORDER BY updated_at DESC LIMIT 10")
    .all();
  for (const row of rows) {
    const event = rowToAiBillingEvent(row);
    if (isAiBillingProcessingEvent(event)) return event;
  }
  return null;
}

function assertAiProcessingUnlocked(allowedEventId = null) {
  const active = getActiveAiProcessingEvent();
  if (!active || Number(active.id) === Number(allowedEventId || 0)) return;
  const error = new Error("A auto classificacao esta processando os produtos agora. Aguarde finalizar antes de alterar a tabela ou gerar outro pagamento.");
  error.status = 409;
  error.active_billing = publicBillingFromEvent(active);
  throw error;
}

async function refreshMercadoPagoBillingEvent(event) {
  if (!event) {
    const error = new Error("Cobrança nao encontrada.");
    error.status = 404;
    throw error;
  }
  if (!MERCADO_PAGO_ACCESS_TOKEN) {
    const error = new Error("Mercado Pago nao configurado. Coloque MERCADO_PAGO_ACCESS_TOKEN no AutoBack/.env.");
    error.status = 422;
    throw error;
  }
  const paymentId = normalizeMercadoPagoPaymentId(event.metadata?.payment?.payment_id || event.provider_reference);
  if (!/^\d+$/.test(paymentId)) return publicBillingFromEvent(event);
  if (!paymentId) return publicBillingFromEvent(event);

  const response = await fetch(`${MERCADO_PAGO_API_URL}/v1/payments/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Mercado Pago HTTP ${response.status}`;
    const error = new Error(`Falha ao consultar Mercado Pago: ${message}`);
    error.status = 502;
    throw error;
  }

  const metadata = event.metadata || {};
  const transactionData = payload.point_of_interaction?.transaction_data || {};
  const nextPayment = {
    ...(metadata.payment || {}),
    payment_id: normalizeMercadoPagoPaymentId(payload.id || paymentId),
    payment_status: payload.status || "pending",
    status_detail: payload.status_detail || null,
    qr_code_base64: transactionData.qr_code_base64 || metadata.payment?.qr_code_base64 || null,
    qr_code: transactionData.qr_code || metadata.payment?.qr_code || null,
    ticket_url: transactionData.ticket_url || metadata.payment?.ticket_url || event.checkout_url || null
  };
  const paid = nextPayment.payment_status === "approved";
  const nextStatus = paid ? "paid" : "pending_payment";
  db.prepare("UPDATE ai_billing_events SET status = ?, checkout_url = ?, metadata_json = ?, updated_at = ? WHERE id = ?").run(
    nextStatus,
    nextPayment.ticket_url,
    asJson({ ...metadata, payment: nextPayment, last_payment_status_payload: { status: payload.status, status_detail: payload.status_detail } }),
    now(),
    event.id
  );
  return publicBillingFromEvent({ ...event, status: nextStatus, checkout_url: nextPayment.ticket_url, metadata: { ...metadata, payment: nextPayment } });
}

async function fetchMercadoPagoPaymentById(paymentId) {
  if (!MERCADO_PAGO_ACCESS_TOKEN) {
    const error = new Error("Mercado Pago nao configurado. Coloque MERCADO_PAGO_ACCESS_TOKEN no AutoBack/.env.");
    error.status = 422;
    throw error;
  }
  const cleanPaymentId = normalizeMercadoPagoPaymentId(paymentId);
  const response = await fetch(`${MERCADO_PAGO_API_URL}/v1/payments/${encodeURIComponent(cleanPaymentId)}`, {
    headers: {
      Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Mercado Pago HTTP ${response.status}`;
    const error = new Error(`Falha ao consultar Mercado Pago: ${message}`);
    error.status = 502;
    throw error;
  }
  return payload;
}

function updateBillingEventWithPaymentPayload(event, paymentPayload = {}) {
  const metadata = event.metadata || {};
  const transactionData = paymentPayload.point_of_interaction?.transaction_data || {};
  const nextPayment = {
    ...(metadata.payment || {}),
    payment_id: normalizeMercadoPagoPaymentId(paymentPayload.id || event.provider_reference),
    payment_status: paymentPayload.status || "pending",
    status_detail: paymentPayload.status_detail || null,
    qr_code_base64: transactionData.qr_code_base64 || metadata.payment?.qr_code_base64 || null,
    qr_code: transactionData.qr_code || metadata.payment?.qr_code || null,
    ticket_url: transactionData.ticket_url || metadata.payment?.ticket_url || event.checkout_url || null
  };
  const paid = nextPayment.payment_status === "approved";
  const nextStatus = paid ? "paid" : "pending_payment";
  const nextMetadata = {
    ...metadata,
    payment: nextPayment,
    last_webhook_payment_payload: {
      status: paymentPayload.status,
      status_detail: paymentPayload.status_detail,
      external_reference: paymentPayload.external_reference || null
    }
  };
  db.prepare("UPDATE ai_billing_events SET status = ?, checkout_url = ?, metadata_json = ?, updated_at = ? WHERE id = ?").run(
    nextStatus,
    nextPayment.ticket_url,
    asJson(nextMetadata),
    now(),
    event.id
  );
  return { ...event, status: nextStatus, checkout_url: nextPayment.ticket_url, metadata: nextMetadata };
}

async function resolveAiBillingForUse({ classificationId = null, quantity = 1, actor = "contador", context = "item", options = {} } = {}) {
  if (!billingEnabled()) {
    return {
      enabled: false,
      status: "disabled",
      paid: true,
      requires_payment: false,
      quantity,
      amount_cents: 0,
      amount_brl: 0,
      message: "Pagamento do classificador obrigatorio."
    };
  }

  const eventId = Number(options.billing_event_id || options.billingEventId || 0);
  if (eventId) {
    const event = getAiBillingEvent(eventId);
    if (!event) {
      const error = new Error("Cobrança nao encontrada.");
      error.status = 404;
      throw error;
    }
    if (context && event.metadata?.context && event.metadata.context !== context) {
      const error = new Error("Esta cobrança pertence a outro fluxo de auto classificacao.");
      error.status = 409;
      throw error;
    }
    if (classificationId && event.classification_id && Number(event.classification_id) !== Number(classificationId)) {
      const error = new Error("Esta cobrança pertence a outro item.");
      error.status = 409;
      throw error;
    }
    const paymentStatus = event.metadata?.payment?.payment_status;
    if (options.skip_payment_refresh && (paymentStatus === "approved" || event.status === "paid" || event.status === "processing_ai")) {
      return publicBillingFromEvent(event);
    }
    return await refreshMercadoPagoBillingEvent(event);
  }

  return await prepareAiBilling({ classificationId, quantity, actor, context });
}

function formatNcm(code) {
  const clean = normalizeNcmCode(code);
  if (clean.length !== 8) return clean || "-";
  return `${clean.slice(0, 4)}.${clean.slice(4, 6)}.${clean.slice(6, 8)}`;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function mapWebEvidenceItem(item, provider) {
  const title = item.title || item.name || item.displayed_link || item.link || item.url || "Fonte web";
  const url = item.link || item.url || item.displayed_link || "";
  const snippet = item.snippet || item.description || item.htmlSnippet || item.body || "";
  return { provider, title, url, snippet };
}

function buildNcmSearchQuery(productName) {
  const cleanProduct = String(productName || "").replace(/\s+/g, " ").trim();
  return `${cleanProduct || "produto"} NCM`;
}

function buildFiscalSearchQueries(productName, uf = "") {
  const cleanProduct = String(productName || "").replace(/\s+/g, " ").trim() || "produto";
  const fiscalUf = normalizeUf(uf, "");
  const ufSuffix = fiscalUf ? ` ${fiscalUf}` : "";
  return {
    ncm: `${cleanProduct} NCM`,
    cest: `${cleanProduct} CEST ICMS ST${ufSuffix}`,
    cest_required: `${cleanProduct} CEST obrigatorio${ufSuffix}`,
    ncm_cest: `${cleanProduct} NCM CEST${ufSuffix}`,
    ex_tipi: `${cleanProduct} NCM EX TIPI TIPI IPI`,
    unidade: `${cleanProduct} unidade comercial unidade tributavel NCM`,
    cfop: `${cleanProduct} CFOP venda compra dentro fora do estado origem${ufSuffix}`,
    icms_st_fcp: `${cleanProduct} ICMS ST FCP CEST aliquota${ufSuffix}`,
    pis_cofins: `${cleanProduct} PIS COFINS CST aliquota NCM`,
    ibs_cbs: `${cleanProduct} IBS CBS CST cClassTrib aliquota IBS UF aliquota IBS municipio aliquota CBS LC 214 2025 reducao beneficio fiscal`,
    fiscal_full: `${cleanProduct} NCM CEST Unidade Origem CFOP CST ICMS CSOSN aliquota ICMS ICMS-ST FCP CST PIS aliquota PIS CST COFINS aliquota COFINS CST IPI aliquota IPI EX TIPI cEnq IBS CBS cClassTrib aliquota IBS UF aliquota IBS municipio aliquota CBS cBenef vTotTrib${ufSuffix}`
  };
}

async function fetchWebEvidence(productName, options = {}) {
  const query = buildFiscalSearchQueries(productName, options.uf).fiscal_full;
  if (!options.useWeb) {
    return { status: "not_requested", query, items: [] };
  }

  const config = ncmRobotConfig();
  const provider = config.web_evidence.provider;
  if (!provider) {
    return {
      status: "not_configured",
      query,
      items: [],
      message: "Configure BRAVE_SEARCH_API_KEY, SERPAPI_KEY ou GOOGLE_CSE_KEY/GOOGLE_CSE_CX para usar evidencia web."
    };
  }

  try {
    if (provider === "brave") {
      const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
        q: query,
        count: String(NCM_WEB_EVIDENCE_LIMIT),
        country: "BR",
        search_lang: "pt-br"
      }).toString()}`;
      const payload = await fetchJsonWithTimeout(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY
        }
      });
      const items = (payload.web?.results || []).slice(0, NCM_WEB_EVIDENCE_LIMIT).map((item) => mapWebEvidenceItem(item, provider));
      return { status: "ok", provider, query, items };
    }

    if (provider === "serpapi") {
      const url = `https://serpapi.com/search.json?${new URLSearchParams({
        engine: "google",
        q: query,
        api_key: process.env.SERPAPI_KEY,
        hl: "pt-br",
        gl: "br",
        num: String(NCM_WEB_EVIDENCE_LIMIT)
      }).toString()}`;
      const payload = await fetchJsonWithTimeout(url);
      const items = (payload.organic_results || []).slice(0, NCM_WEB_EVIDENCE_LIMIT).map((item) => mapWebEvidenceItem(item, provider));
      return { status: "ok", provider, query, items };
    }

    if (provider === "google") {
      const url = `https://customsearch.googleapis.com/customsearch/v1?${new URLSearchParams({
        key: process.env.GOOGLE_CSE_KEY,
        cx: process.env.GOOGLE_CSE_CX,
        q: query,
        num: String(NCM_WEB_EVIDENCE_LIMIT),
        gl: "br",
        hl: "pt-BR"
      }).toString()}`;
      const payload = await fetchJsonWithTimeout(url);
      const items = (payload.items || []).slice(0, NCM_WEB_EVIDENCE_LIMIT).map((item) => mapWebEvidenceItem(item, provider));
      return { status: "ok", provider, query, items };
    }
  } catch (error) {
    return { status: "error", provider, query, items: [], message: error.message };
  }

  return { status: "not_configured", query, items: [] };
}

const AI_NCM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "request_id",
    "sku",
    "descricao_original",
    "ncm",
    "confianca_ncm",
    "cest_possivel",
    "confianca_cest",
    "dados_fiscais",
    "justificativa_curta",
    "status",
    "fontes",
    "avisos"
  ],
  properties: {
    request_id: { type: "string" },
    sku: { type: "string" },
    descricao_original: { type: "string" },
    ncm: { type: "string" },
    confianca_ncm: { type: "number" },
    cest_possivel: { type: "string" },
    confianca_cest: { type: "number" },
    dados_fiscais: {
      type: "object",
      additionalProperties: false,
      required: [
        "sku",
        "ean_gtin",
        "descricao",
        "ncm",
        "cest",
        "unidade",
        "origem",
        "cfop_interno",
        "cfop_interestadual",
        "cst_icms",
        "csosn",
        "aliquota_icms",
        "icms_st",
        "aliquota_fcp",
        "cst_pis",
        "aliquota_pis",
        "cst_cofins",
        "aliquota_cofins",
        "cst_ipi",
        "aliquota_ipi",
        "ex_tipi",
        "cenq",
        "ibs_cbs_cst",
        "cclass_trib",
        "aliquota_ibs_uf",
        "aliquota_ibs_municipio",
        "aliquota_cbs",
        "cbenef",
        "vtottrib",
        "observacao"
      ],
      properties: {
        sku: { type: "string" },
        ean_gtin: { type: "string" },
        descricao: { type: "string" },
        ncm: { type: "string" },
        cest: { type: "string" },
        unidade: { type: "string" },
        origem: { type: "string" },
        cfop_interno: { type: "string" },
        cfop_interestadual: { type: "string" },
        cst_icms: { type: "string" },
        csosn: { type: "string" },
        aliquota_icms: { type: "string" },
        icms_st: { type: "string" },
        aliquota_fcp: { type: "string" },
        cst_pis: { type: "string" },
        aliquota_pis: { type: "string" },
        cst_cofins: { type: "string" },
        aliquota_cofins: { type: "string" },
        cst_ipi: { type: "string" },
        aliquota_ipi: { type: "string" },
        ex_tipi: { type: "string" },
        cenq: { type: "string" },
        ibs_cbs_cst: { type: "string" },
        cclass_trib: { type: "string" },
        aliquota_ibs_uf: { type: "string" },
        aliquota_ibs_municipio: { type: "string" },
        aliquota_cbs: { type: "string" },
        cbenef: { type: "string" },
        vtottrib: { type: "string" },
        observacao: { type: "string" }
      }
    },
    justificativa_curta: { type: "string" },
    status: {
      type: "string",
      enum: ["CLASSIFICADO", "REVISAO_MANUAL", "ERRO_BASE_FISCAL", "ERRO_OPENAI", "ERRO_VALIDACAO"]
    },
    fontes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "code", "description", "url", "confidence"],
        properties: {
          type: { type: "string" },
          code: { type: "string" },
          description: { type: "string" },
          url: { type: "string" },
          confidence: { type: "number" }
        }
      }
    },
    avisos: { type: "array", items: { type: "string" } }
  }
};

function assertOpenAiConfigured() {
  if (OPENAI_API_KEY) return;
  const error = new Error("Classificador automatico nao configurado. Coloque a chave no arquivo AutoBack/.env e reinicie o backend.");
  error.status = 422;
  throw error;
}

function aiNcmInstructions() {
  return [
    "Voce e o classificador fiscal web-first da Aikkie para produtos vendidos no Brasil.",
    "Cada requisicao e independente. Use request_id e sku recebidos no contexto e devolva exatamente os mesmos valores; nao use memoria, conversa anterior, produto anterior ou inferencia de outro item.",
    "Pesquise na web usando search_queries.fiscal_full e consultas equivalentes ao estilo: '<descricao do produto> ncm UF <UF> SKU EAN GTIN Descricao NCM CEST Unidade Origem CFOP CST ICMS CSOSN aliquota ICMS ICMS-ST FCP PIS COFINS IPI EX TIPI cEnq IBS CBS cClassTrib cBenef vTotTrib'.",
    "A ferramenta de busca web nao acessa o widget 'Visao geral criada por IA' do Google (ele so existe renderizado por JavaScript na pagina do Google, fora do alcance de qualquer API de busca). Use o resultado web mais direto e estruturado encontrado (paginas de classificacao fiscal, tabelas NCM/CEST, portais contabeis) e extraia os codigos/campos fiscais retornados para dados_fiscais.",
    "Nao use candidatos locais, ocorrencias, regras antigas, memoria ou aprendizado para escolher o resultado; a pesquisa web desta requisicao define a resposta.",
    "Use a descricao recebida como verdade de entrada. Nao interrompa o fluxo e nao deixe pendente por descricao generica; pesquise e classifique pelo retorno web mais direto.",
    "Preencha todos os campos de dados_fiscais. Quando a web disser que nao possui CEST/cBenef/EX TIPI obrigatorio, use 'SEM CEST OBRIGATORIO', 'SEM CBENEF' ou string vazia conforme o campo.",
    "Nao invente EAN/GTIN. Se a fonte mostrar EAN generico, exemplo, 7890000000000, 0000000000000 ou placeholder, retorne ean_gtin vazio.",
    "Para CFOP, use operation.cfop_interno_default e operation.cfop_interestadual_default quando a busca nao trouxer valor melhor.",
    "Para UF, considere tax_scope.uf como UF fiscal da pesquisa, principalmente para ICMS, ICMS-ST, FCP, CEST e cBenef.",
    "Para NCM, retorne sempre 8 digitos sem ponto em ncm e dados_fiscais.ncm. Para CEST, retorne 7 digitos sem ponto quando houver codigo.",
    "Para percentuais, retorne apenas o numero como texto, sem o simbolo %, usando ponto ou virgula decimal.",
    "Se algum campo realmente nao aparecer em nenhuma evidencia, deixe string vazia e explique em dados_fiscais.observacao/avisos.",
    "A justificativa_curta deve ser curta, objetiva e baseada no que a busca retornou. Nada de resposta longa.",
    "Retorne apenas JSON no formato do schema."
  ].join(" ");
}

function buildAiRequestId(classification = {}) {
  const stablePart = classification.id || classification.product_id || "item";
  return `req_${stablePart}_${randomUUID().slice(0, 8)}`;
}

async function buildAiNcmContext(classification, options = {}) {
  const productText = `${classification.descricao_original || ""} ${classification.marca || ""} ${classification.categoria || ""}`.trim();
  const requestId = asCleanString(options.request_id || options.requestId, buildAiRequestId(classification));
  const fiscalUf = getFiscalUfForClassification(classification);
  const searchQueries = buildFiscalSearchQueries(productText, fiscalUf);
  const currentCode = normalizeNcmCode(classification.ncm);
  const currentRow = getOfficialNcmRow(currentCode);
  const company = getCompanyForFiscalUf(fiscalUf);
  const operation = getOperationForClassification(classification);
  const cfops = getCfopPair(operation, company);
  const useWeb = Boolean(options.use_web || options.useWeb);
  const web = await fetchWebEvidence(productText, { useWeb, uf: fiscalUf });
  return {
    request_id: requestId,
    generated_at: now(),
    official_ncm_source: NCM_JSON_URL,
    search_query: searchQueries.ncm,
    search_queries: searchQueries,
    product: {
      id: classification.product_id,
      classification_id: classification.id,
      descricao: classification.descricao_original,
      unidade: classification.unidade || null,
      codigo_produto: classification.codigo_produto || null,
      sku: classification.sku || classification.codigo_produto || null,
      codigo_barras: classification.codigo_barras || null,
      ean: classification.ean || classification.codigo_barras || null,
      marca: classification.marca || null,
      categoria: classification.categoria || null,
      uf: fiscalUf
    },
    company: {
      nome: company.nome_fantasia || company.razao_social || "",
      cnpj: company.cnpj || "",
      uf: fiscalUf,
      municipio: company.municipio || "",
      regime_tributario: company.regime_tributario || "",
      crt: company.crt || "",
      contribuinte_icms: Boolean(company.contribuinte_icms)
    },
    tax_scope: {
      uf: fiscalUf,
      source: classification.uf ? "classification" : classification.batch_uf ? "import_batch" : "company",
      uf_deve_ser_usada_para: ["ICMS", "ICMS-ST", "FCP", "CEST", "cBenef", "beneficios estaduais"]
    },
    operation: {
      type: operation,
      uf_origem: fiscalUf,
      cfop_interno_default: cfops.interno,
      cfop_interestadual_default: cfops.interestadual,
      missing_context: ["destinatario", "uf_destino", "consumidor_final", "finalidade_da_operacao"]
    },
    current: {
      ncm: currentCode || "00000000",
      exists_in_official: Boolean(currentRow),
      descricao: currentRow?.descricao || null
    },
    web_evidence: web
  };
}

function extractOpenAiOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
      else if (typeof content.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("\n").trim();
}

function parseOpenAiJsonOutput(outputText) {
  const text = String(outputText || "").trim();
  const direct = parseJson(text, null);
  if (direct) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = parseJson(fenced[1].trim(), null);
    if (parsed) return parsed;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return parseJson(text.slice(start, end + 1), null);
  }
  return null;
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFiscalLabelValue(text, labels = []) {
  const normalized = normalizeText(text).replace(/\r/g, "");
  const pattern = labels
    .map((label) => normalizeText(label))
    .filter(Boolean)
    .map(escapeRegex)
    .join("|");
  if (!pattern) return "";
  const match = new RegExp(
    `(?:^|\\n)\\s*(?:[*#-]+\\s*)?(?:${pattern})\\s*[^\\n:]{0,100}?\\s*:\\s*([^\\n]+)`,
    "im"
  ).exec(normalized);
  return match?.[1]?.replace(/\*+/g, "").trim() || "";
}

function extractFiscalDigits(value, minLength = 1, maxLength = 8) {
  const candidates = String(value || "").match(/\d[\d./-]*/g) || [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= minLength && digits.length <= maxLength) return digits;
  }
  return "";
}

function extractFiscalPercent(value) {
  const match = String(value || "").match(/-?\d+(?:[.,]\d+)?/);
  return match ? match[0].replace(",", ".") : "";
}

function parseOpenAiFiscalText(outputText, context = {}) {
  const text = String(outputText || "").trim();
  if (!text) return null;

  const ncmLine = extractFiscalLabelValue(text, ["NCM"]);
  const ncm = extractNcmCodesFromText(ncmLine || text)[0] || "";
  if (!ncm || ncm === "00000000") return null;

  const cestLine = extractFiscalLabelValue(text, ["CEST"]);
  const cest = extractCestCodesFromText(cestLine)[0] ||
    (isNoCestSignal(cestLine || text) ? "SEM CEST OBRIGATORIO" : "");
  const description = extractFiscalLabelValue(text, ["Descricao", "Descricao fiscal"]) || context.product?.descricao || "";
  const eanLine = extractFiscalLabelValue(text, ["EAN/GTIN", "EAN", "GTIN"]);
  const eanIsSynthetic = /exemplo|generico|simulad|placeholder|padrao|utilize o codigo/.test(normalizeText(eanLine));
  const ean = eanIsSynthetic ? "" : extractFiscalDigits(eanLine, 8, 14);
  const sku = context.product?.sku || context.product?.codigo_produto || extractFiscalLabelValue(text, ["SKU"]);
  const unidade = extractFiscalLabelValue(text, ["Unidade"]) || context.product?.unidade || "";
  const origem = extractFiscalDigits(extractFiscalLabelValue(text, ["Origem da mercadoria", "Origem"]), 1, 1);
  const cfopInterno = extractFiscalDigits(extractFiscalLabelValue(text, ["CFOP interno", "CFOP Interno"]), 4, 4);
  const cfopInterestadual = extractFiscalDigits(extractFiscalLabelValue(text, ["CFOP interestadual", "CFOP Interestadual"]), 4, 4);
  const cstIcms = extractFiscalDigits(extractFiscalLabelValue(text, ["CST ICMS"]), 2, 3);
  const csosn = extractFiscalDigits(extractFiscalLabelValue(text, ["CSOSN"]), 3, 3);
  const aliquotaIcms = extractFiscalPercent(extractFiscalLabelValue(text, ["Aliquota ICMS"]));
  const icmsSt = extractFiscalLabelValue(text, ["ICMS-ST", "ICMS/ST"]);
  const aliquotaFcp = extractFiscalPercent(extractFiscalLabelValue(text, ["FCP", "Aliquota FCP"]));
  const cstPis = extractFiscalDigits(extractFiscalLabelValue(text, ["CST PIS"]), 2, 2);
  const aliquotaPis = extractFiscalPercent(extractFiscalLabelValue(text, ["Aliquota PIS"]));
  const cstCofins = extractFiscalDigits(extractFiscalLabelValue(text, ["CST COFINS"]), 2, 2);
  const aliquotaCofins = extractFiscalPercent(extractFiscalLabelValue(text, ["Aliquota COFINS"]));
  const cstIpi = extractFiscalDigits(extractFiscalLabelValue(text, ["CST IPI"]), 2, 2);
  const aliquotaIpi = extractFiscalPercent(extractFiscalLabelValue(text, ["Aliquota IPI"]));
  const exTipi = extractFiscalLabelValue(text, ["EX TIPI"]);
  const cenq = extractFiscalDigits(extractFiscalLabelValue(text, ["cEnq", "Enquadramento do IPI"]), 3, 3);
  const ibsCbsCst = extractFiscalDigits(extractFiscalLabelValue(text, ["CST IBS/CBS", "CST IBS CBS"]), 2, 3);
  const cclassTrib = extractFiscalDigits(extractFiscalLabelValue(text, ["cClassTrib", "CClassTrib"]), 6, 6);
  const aliquotaIbsUf = extractFiscalPercent(extractFiscalLabelValue(text, ["Aliquota IBS UF"]));
  const aliquotaIbsMunicipio = extractFiscalPercent(extractFiscalLabelValue(text, ["Aliquota IBS Municipio"]));
  const aliquotaCbs = extractFiscalPercent(extractFiscalLabelValue(text, ["Aliquota CBS"]));
  const cbenefLine = extractFiscalLabelValue(text, ["cBenef", "CBenef"]);
  const cbenef = /nao aplicavel|nao se aplica|sem beneficio|sem benef/.test(normalizeText(cbenefLine)) ? "SEM CBENEF" : cbenefLine;
  const vtottrib = extractFiscalPercent(extractFiscalLabelValue(text, ["vTotTrib", "Valor Total dos Tributos"]));
  const confidence = extractFiscalPercent(extractFiscalLabelValue(text, ["Confianca", "Confianca NCM"]));

  return {
    request_id: context.request_id || "",
    sku,
    descricao_original: context.product?.descricao || description,
    ncm,
    confianca_ncm: confidence ? Number(confidence) / 100 : 0.9,
    cest_possivel: cest,
    confianca_cest: cest ? 0.85 : 0.35,
    dados_fiscais: {
      sku,
      ean_gtin: ean,
      descricao: description,
      ncm,
      cest,
      unidade,
      origem,
      cfop_interno: cfopInterno,
      cfop_interestadual: cfopInterestadual,
      cst_icms: cstIcms,
      csosn,
      aliquota_icms: aliquotaIcms,
      icms_st: icmsSt,
      aliquota_fcp: aliquotaFcp,
      cst_pis: cstPis,
      aliquota_pis: aliquotaPis,
      cst_cofins: cstCofins,
      aliquota_cofins: aliquotaCofins,
      cst_ipi: cstIpi,
      aliquota_ipi: aliquotaIpi,
      ex_tipi: exTipi,
      cenq,
      ibs_cbs_cst: ibsCbsCst,
      cclass_trib: cclassTrib,
      aliquota_ibs_uf: aliquotaIbsUf,
      aliquota_ibs_municipio: aliquotaIbsMunicipio,
      aliquota_cbs: aliquotaCbs,
      cbenef,
      vtottrib,
      observacao: "Campos recuperados do texto fiscal estruturado retornado pela pesquisa web."
    },
    justificativa_curta: "NCM e campos fiscais recuperados do texto fiscal estruturado retornado pela pesquisa web.",
    status: "CLASSIFICADO",
    fontes: [{ type: "web_text_recovered", code: ncm, description, url: "", confidence: 0.9 }],
    avisos: ["A pesquisa retornou texto fiscal em vez de JSON; os campos rotulados foram recuperados automaticamente."]
  };
}

function collectOpenAiWebEvidence(payload) {
  const items = [];
  const seen = new Set();
  const pushItem = (item = {}) => {
    const url = item.url || item.link || item.source_website_url || item.image_url || "";
    const title = item.title || item.name || item.caption || url || "Fonte web do classificador";
    const snippet = item.snippet || item.text || item.description || item.caption || "";
    const key = `${url}|${title}|${snippet}`;
    if (!url && !snippet) return;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ provider: "openai_web_search", title, url, snippet });
  };

  for (const output of payload?.output || []) {
    if (Array.isArray(output.results)) {
      output.results.forEach(pushItem);
    }
    for (const content of output.content || []) {
      const contentText = content.text || content.output_text || "";
      if (contentText) {
        pushItem({
          title: "Resumo da pesquisa web do classificador",
          url: "",
          snippet: contentText
        });
      }
      for (const annotation of content.annotations || []) {
        if (annotation.type === "url_citation") {
          const citation = annotation.url_citation || annotation;
          pushItem({
            title: citation.title,
            url: citation.url,
            snippet: ""
          });
        }
      }
    }
  }

  return items.slice(0, NCM_WEB_EVIDENCE_LIMIT);
}

function mergeOpenAiWebEvidence(context, openAiItems = []) {
  if (!openAiItems.length) return context;
  const currentWeb = context.web_evidence || {};
  const existingItems = Array.isArray(currentWeb.items) ? currentWeb.items : [];
  return {
    ...context,
    web_evidence: {
      ...currentWeb,
      status: "ok",
      provider: currentWeb.provider || "openai_web_search",
      items: [...existingItems, ...openAiItems].slice(0, NCM_WEB_EVIDENCE_LIMIT)
    }
  };
}

function buildOpenAiNcmInput(context = {}) {
  return {
    request_id: context.request_id,
    generated_at: context.generated_at,
    search_queries: {
      ncm: context.search_queries?.ncm || "",
      ncm_cest: context.search_queries?.ncm_cest || "",
      fiscal_full: context.search_queries?.fiscal_full || ""
    },
    product: context.product,
    company: {
      uf: context.company?.uf || "",
      regime_tributario: context.company?.regime_tributario || "",
      crt: context.company?.crt || "",
      contribuinte_icms: Boolean(context.company?.contribuinte_icms)
    },
    tax_scope: context.tax_scope,
    operation: context.operation,
    web_evidence: context.web_evidence,
    required_fiscal_fields: [
      "SKU",
      "EAN/GTIN",
      "Descricao",
      "NCM",
      "CEST",
      "Unidade",
      "Origem da mercadoria",
      "CFOP interno",
      "CFOP interestadual",
      "CST ICMS",
      "CSOSN",
      "Aliquota ICMS",
      "ICMS-ST",
      "FCP",
      "CST PIS",
      "Aliquota PIS",
      "CST COFINS",
      "Aliquota COFINS",
      "CST IPI",
      "Aliquota IPI",
      "EX TIPI",
      "cEnq",
      "CST IBS/CBS",
      "cClassTrib",
      "Aliquota IBS UF",
      "Aliquota IBS Municipio",
      "Aliquota CBS",
      "cBenef",
      "vTotTrib"
    ]
  };
}

async function callOpenAiNcm(context) {
  assertOpenAiConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_NCM_TIMEOUT_MS);
  const request = {
    model: OPENAI_NCM_MODEL,
    instructions: aiNcmInstructions(),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(buildOpenAiNcmInput(context))
          }
        ]
      }
    ],
    max_output_tokens: OPENAI_NCM_MAX_OUTPUT_TOKENS,
    parallel_tool_calls: false,
    text: {
      format: {
        type: "json_schema",
        name: "ncm_classification",
        strict: true,
        schema: AI_NCM_SCHEMA
      }
    }
  };

  if (OPENAI_NCM_WEB_SEARCH_ENABLED) {
    request.tools = [
      {
        type: "web_search",
        search_context_size: "medium",
        user_location: {
          type: "approximate",
          country: "BR",
          timezone: "America/Sao_Paulo"
        }
      }
    ];
    request.tool_choice = "required";
    request.include = ["web_search_call.results"];
  }

  try {
    const response = await fetch(OPENAI_NCM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : { error: await response.text() };
    if (!response.ok) {
      const message = payload?.error?.message || payload?.error || `Classificador HTTP ${response.status}`;
      const error = new Error(`Falha no classificador automatico: ${message}`);
      error.status = response.status === 401 ? 422 : 502;
      throw error;
    }
    const outputText = extractOpenAiOutputText(payload);
    const webEvidence = collectOpenAiWebEvidence(payload);
    const parsedJson = parseOpenAiJsonOutput(outputText);
    const recoveredText = outputText || webEvidence.map((item) => `${item.title || ""}\n${item.snippet || ""}`).join("\n");
    const parsed = parsedJson || parseOpenAiFiscalText(recoveredText, context);
    const incompleteReason = payload.status === "incomplete" ? payload.incomplete_details?.reason : "";
    return {
      response_id: payload.id || null,
      model: payload.model || OPENAI_NCM_MODEL,
      usage: payload.usage || null,
      raw_text: outputText,
      parsed,
      response_format: parsedJson ? "json_schema" : parsed ? "text_recovered" : "unavailable",
      parse_error: parsed ? null : incompleteReason
        ? `Resposta incompleta do classificador: ${incompleteReason}.`
        : "O classificador automatico respondeu sem JSON valido para o NCM.",
      web_evidence: webEvidence
    };
  } finally {
    clearTimeout(timeout);
  }
}

function clampConfidence(value) {
  return Math.min(0.99, Math.max(0.01, Number(value || 0)));
}

function clampScore(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(0.99, Math.max(0, number));
}

function asCleanString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asStringArray(value, limit = 8) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function numberOrFallback(value, fallback = null) {
  if (value === "" || value === null || value === undefined) return fallback;
  const raw = String(value).replace(",", ".");
  const number = Number(raw);
  if (Number.isFinite(number)) return number;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return fallback;
  const extracted = Number(match[0]);
  return Number.isFinite(extracted) ? extracted : fallback;
}

function normalizeSimNaoIncerto(value, fallback = "incerto") {
  const text = normalizeText(value);
  if (["sim", "yes", "true", "obrigatorio", "obrigatoria"].includes(text)) return "sim";
  if (["nao", "não", "no", "false", "sem", "inexistente", "inaplicavel", "nao aplicavel", "nao se aplica"].includes(text)) return "nao";
  if (text.includes("nao") || text.includes("sem cest") || text.includes("nao possui") || text.includes("inaplicavel")) return "nao";
  if (text.includes("sim") || text.includes("obrig")) return "sim";
  return fallback;
}

function isNoCestSignal(value, required = "") {
  const text = normalizeText(`${value || ""} ${required || ""}`);
  return (
    required === "nao" ||
    text.includes("sem cest") ||
    text.includes("nao aplicavel") ||
    text.includes("nao se aplica") ||
    text.includes("inaplicavel") ||
    text.includes("nao possui cest") ||
    text.includes("nao ha cest") ||
    text.includes("nao tem cest") ||
    text.includes("sem codigo cest") ||
    (text.includes("nao possui") && text.includes("cest")) ||
    (text.includes("nao ha") && text.includes("cest")) ||
    (text.includes("nao tem") && text.includes("cest")) ||
    (text.includes("sem codigo") && text.includes("cest"))
  );
}

function webEvidenceSaysNoCest(webEvidence = {}) {
  if (webEvidence?.status !== "ok" || !Array.isArray(webEvidence.items)) return false;
  return webEvidence.items.some((item) =>
    isNoCestSignal(`${item.title || ""} ${item.snippet || ""} ${item.url || ""}`)
  );
}

function extractCestCodesFromText(text) {
  const codes = new Set();
  const rawText = String(text || "");
  for (const match of rawText.matchAll(/\b(\d{2})[.\s-]?(\d{3})[.\s-]?(\d{2})\b/g)) {
    codes.add(`${match[1]}${match[2]}${match[3]}`);
  }
  return [...codes];
}

function getCestsFromWebEvidence(webEvidence = {}) {
  if (webEvidence?.status !== "ok" || !Array.isArray(webEvidence.items)) return [];
  const counts = new Map();
  for (const item of webEvidence.items) {
    const text = `${item.title || ""} ${item.snippet || ""} ${item.url || ""}`;
    for (const code of extractCestCodesFromText(text)) counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([codigo, count]) => ({ codigo, count }))
    .sort((a, b) => b.count - a.count || a.codigo.localeCompare(b.codigo));
}

function normalizeCestSuggestion(value, required = "") {
  const text = asCleanString(value);
  if (isNoCestSignal(text, required)) return "SEM CEST OBRIGATORIO";
  const digits = text.replace(/\D/g, "");
  if (digits.length === 7) return digits;
  return text;
}

function aiFiscalData(ai = {}) {
  return ai.dados_fiscais || ai.fiscal_fields || {};
}

function fiscalText(value, fallback = "") {
  return asCleanString(value, fallback);
}

function cleanFiscalCode(value, length = null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return length ? digits.slice(0, length) : digits;
}

function isPlaceholderEan(value) {
  const text = normalizeText(value);
  const digits = cleanFiscalCode(value);
  return (
    !digits ||
    text.includes("exemplo") ||
    text.includes("generico") ||
    text.includes("placeholder") ||
    /^0+$/.test(digits) ||
    /^7890+$/.test(digits) ||
    digits === "7890000000000" ||
    digits === "1234567890123"
  );
}

function normalizeEanSuggestion(value, fallback = "") {
  const fallbackDigits = cleanFiscalCode(fallback);
  if (isPlaceholderEan(value)) return fallbackDigits;
  const digits = cleanFiscalCode(value);
  return [8, 12, 13, 14].includes(digits.length) ? digits : fallbackDigits;
}

function buildDefaultProductProfile(context = {}, ai = {}) {
  const product = context.product || {};
  const profile = ai.product_profile || {};
  const explicit = ai.caracteristicas_explicitas || {};
  const extraCharacteristics = [
    explicit.dimensao,
    explicit.apresentacao,
    ...(Array.isArray(explicit.outras) ? explicit.outras : []),
    ...(Array.isArray(profile.caracteristicas) ? profile.caracteristicas : [])
  ];
  return {
    produto_base: asCleanString(explicit.produto, asCleanString(profile.produto_base, asCleanString(ai.product_category, product.descricao || ""))),
    marca: asCleanString(explicit.marca, asCleanString(profile.marca, product.marca || "")),
    composicao: asCleanString(explicit.composicao, profile.composicao),
    material: asCleanString(explicit.material, profile.material),
    finalidade: asCleanString(explicit.finalidade, profile.finalidade),
    embalagem: asCleanString(explicit.embalagem, profile.embalagem),
    volume: asCleanString(explicit.volume, profile.volume),
    unidade: asCleanString(explicit.unidade, asCleanString(profile.unidade, product.unidade || "")),
    funcao_principal: asCleanString(explicit.funcao_principal, asCleanString(profile.funcao_principal, asCleanString(ai.product_category, product.descricao || ""))),
    funcionamento: asCleanString(explicit.funcionamento, profile.funcionamento),
    uso: asCleanString(explicit.uso, profile.uso),
    caracteristicas: asStringArray(extraCharacteristics)
  };
}

function buildFieldScores(ai = {}, confidence = 0) {
  const scores = ai.field_scores || {};
  const ncmConfidence = ai.confianca_ncm ?? confidence;
  const cestConfidence = ai.confianca_cest ?? scores.cest;
  return {
    ncm: clampScore(scores.ncm, ncmConfidence),
    cest: clampScore(cestConfidence, 0.35),
    cfop: clampScore(scores.cfop, 0.55),
    csosn_cst: clampScore(scores.csosn_cst, 0.5),
    icms: clampScore(scores.icms, 0.35),
    icms_st: clampScore(scores.icms_st, scores.cest || 0.35),
    fcp: clampScore(scores.fcp, 0.25),
    ibs_cbs: clampScore(scores.ibs_cbs, 0.45),
    pis_cofins: clampScore(scores.pis_cofins, 0.5),
    ipi: clampScore(scores.ipi, 0.35),
    cbenef: clampScore(scores.cbenef, 0.25)
  };
}

function normalizeSources(sources = [], code = "", context = {}) {
  const official = getOfficialNcmRow(code);
  const normalized = (Array.isArray(sources) ? sources : [])
    .map((source) => ({
      type: asCleanString(source?.type, "evidence"),
      code: normalizeNcmCode(source?.code) || asCleanString(source?.code),
      description: asCleanString(source?.description),
      url: asCleanString(source?.url),
      confidence: clampScore(source?.confidence, 0.65)
    }))
    .filter((source) => source.code || source.description || source.url);

  if (official && !normalized.some((source) => normalizeNcmCode(source.code) === code)) {
    normalized.unshift({
      type: "official",
      code,
      description: official.descricao || "Tabela oficial NCM",
      url: context.official_ncm_source || NCM_JSON_URL,
      confidence: 0.95
    });
  }

  return normalized.slice(0, 8);
}

function buildFieldSuggestions(ai = {}, context = {}, code = "", description = "", confidence = 0) {
  const fiscal = aiFiscalData(ai);
  const suggestion = {
    ...(ai.field_suggestions || {}),
    ncm_description: fiscalText(fiscal.descricao, ai.field_suggestions?.ncm_description),
    sku: fiscalText(fiscal.sku, ai.field_suggestions?.sku),
    ean: fiscalText(fiscal.ean_gtin || fiscal.ean || fiscal.codigo_barras, ai.field_suggestions?.ean),
    unidade: fiscalText(fiscal.unidade, ai.field_suggestions?.unidade),
    cest: fiscalText(fiscal.cest, fiscalText(ai.cest_possivel, ai.field_suggestions?.cest)),
    cfop_internal: fiscalText(fiscal.cfop_interno, ai.field_suggestions?.cfop_internal),
    cfop_interstate: fiscalText(fiscal.cfop_interestadual, ai.field_suggestions?.cfop_interstate),
    cst_icms: fiscalText(fiscal.cst_icms, ai.field_suggestions?.cst_icms),
    csosn: fiscalText(fiscal.csosn, ai.field_suggestions?.csosn),
    aliquota_icms: fiscalText(fiscal.aliquota_icms, ai.field_suggestions?.aliquota_icms),
    icms_st: fiscalText(fiscal.icms_st, ai.field_suggestions?.icms_st),
    origem: fiscalText(fiscal.origem, ai.field_suggestions?.origem),
    cst_pis: fiscalText(fiscal.cst_pis, ai.field_suggestions?.cst_pis),
    aliquota_pis: fiscalText(fiscal.aliquota_pis, ai.field_suggestions?.aliquota_pis),
    cst_cofins: fiscalText(fiscal.cst_cofins, ai.field_suggestions?.cst_cofins),
    aliquota_cofins: fiscalText(fiscal.aliquota_cofins, ai.field_suggestions?.aliquota_cofins),
    aliquota_fcp: fiscalText(fiscal.aliquota_fcp, ai.field_suggestions?.aliquota_fcp),
    ibs_cbs_cst: fiscalText(fiscal.ibs_cbs_cst, ai.field_suggestions?.ibs_cbs_cst),
    cclass_trib: fiscalText(fiscal.cclass_trib, ai.field_suggestions?.cclass_trib),
    aliquota_ibs_uf: fiscalText(fiscal.aliquota_ibs_uf, ai.field_suggestions?.aliquota_ibs_uf),
    aliquota_ibs_municipio: fiscalText(fiscal.aliquota_ibs_municipio, ai.field_suggestions?.aliquota_ibs_municipio),
    aliquota_cbs: fiscalText(fiscal.aliquota_cbs, ai.field_suggestions?.aliquota_cbs),
    cst_ipi: fiscalText(fiscal.cst_ipi, ai.field_suggestions?.cst_ipi),
    ipi: fiscalText(fiscal.aliquota_ipi || fiscal.ipi, ai.field_suggestions?.ipi),
    ex_tipi: fiscalText(fiscal.ex_tipi, ai.field_suggestions?.ex_tipi),
    cenq: fiscalText(fiscal.cenq, ai.field_suggestions?.cenq),
    cbenef: fiscalText(fiscal.cbenef, ai.field_suggestions?.cbenef),
    vtottrib: fiscalText(fiscal.vtottrib, ai.field_suggestions?.vtottrib),
    observations: asStringArray([fiscal.observacao, ...asStringArray(ai.field_suggestions?.observations, 6)], 6)
  };
  const trustedCode = normalizeNcmCode(code);
  const hasTrustedNcm = Boolean(trustedCode && trustedCode !== "00000000");
  const webCest = hasTrustedNcm ? getCestsFromWebEvidence(context.web_evidence)[0]?.codigo || "" : "";
  const webNoCest = hasTrustedNcm ? webEvidenceSaysNoCest(context.web_evidence) : false;
  const rawCestRequired = normalizeSimNaoIncerto(suggestion.cest_required, webNoCest ? "nao" : webCest || suggestion.cest ? "sim" : "incerto");
  const cestRequired = isNoCestSignal(suggestion.cest, rawCestRequired) ? "nao" : rawCestRequired;
  const cest = normalizeCestSuggestion(suggestion.cest || webCest, cestRequired);
  const icmsSt = normalizeSimNaoIncerto(
    suggestion.icms_st,
    cestRequired === "nao" ? "nao" : cest || webCest ? "sim" : "incerto"
  );
  const cfopInternal = asCleanString(suggestion.cfop_internal, context.operation?.cfop_interno_default || "");
  const cfopInterstate = asCleanString(suggestion.cfop_interstate, context.operation?.cfop_interestadual_default || "");

  return {
    ncm: trustedCode && trustedCode !== "00000000" ? trustedCode : "00000000",
    ncm_description: asCleanString(suggestion.ncm_description, description),
    sku: asCleanString(suggestion.sku, context.product?.codigo_produto || ""),
    ean: normalizeEanSuggestion(suggestion.ean, context.product?.codigo_barras || ""),
    unidade: asCleanString(suggestion.unidade, context.product?.unidade || ""),
    cest: cestRequired === "nao" ? "SEM CEST OBRIGATORIO" : cest,
    cest_required: cestRequired,
    cest_confidence: clampScore(suggestion.cest_confidence, webCest || suggestion.cest ? 0.82 : webNoCest ? 0.78 : 0.35),
    cest_reason: asCleanString(
      suggestion.cest_reason,
      cestRequired === "nao"
        ? "Pesquisa/evidencia nao indicou CEST obrigatorio especifico."
        : "CEST depende da evidencia web, UF, segmento e mercadoria."
    ),
    cfop_internal: cfopInternal,
    cfop_interstate: cfopInterstate,
    cfop_confidence: clampScore(suggestion.cfop_confidence, 0.55),
    cfop_reason: asCleanString(
      suggestion.cfop_reason,
      "CFOP calculado pela camada de operacao; pode depender de UF destino, finalidade e destinatario."
    ),
    csosn: asCleanString(suggestion.csosn),
    cst_icms: asCleanString(suggestion.cst_icms),
    aliquota_icms: numberOrFallback(suggestion.aliquota_icms, null),
    icms_st: icmsSt,
    icms_st_reason: asCleanString(
      suggestion.icms_st_reason,
      icmsSt === "sim"
        ? "Indicado pela relacao CEST/ST encontrada para o produto."
        : icmsSt === "nao"
          ? "Nao foi identificada obrigatoriedade de ICMS-ST/CEST para a descricao."
          : "ICMS-ST depende de NCM, CEST, UF, segmento e operacao."
    ),
    origem: asCleanString(suggestion.origem),
    cst_pis: asCleanString(suggestion.cst_pis),
    aliquota_pis: numberOrFallback(suggestion.aliquota_pis, null),
    pis_cofins_reason: asCleanString(
      suggestion.pis_cofins_reason,
      "PIS/COFINS preenchido somente quando retornado pela pesquisa fiscal."
    ),
    cst_cofins: asCleanString(suggestion.cst_cofins),
    aliquota_cofins: numberOrFallback(suggestion.aliquota_cofins, null),
    aliquota_fcp: numberOrFallback(suggestion.aliquota_fcp, null),
    ibs_cbs_cst: asCleanString(suggestion.ibs_cbs_cst),
    cclass_trib: asCleanString(suggestion.cclass_trib),
    aliquota_ibs_uf: numberOrFallback(suggestion.aliquota_ibs_uf, null),
    aliquota_ibs_municipio: numberOrFallback(suggestion.aliquota_ibs_municipio, null),
    aliquota_cbs: numberOrFallback(suggestion.aliquota_cbs, null),
    ibs_cbs_reason: asCleanString(
      suggestion.ibs_cbs_reason,
      "IBS/CBS deve ser cruzado com NCM, LC 214/2025, reducoes, aliquota zero e cClassTrib vigente."
    ),
    cst_ipi: asCleanString(suggestion.cst_ipi),
    ipi: asCleanString(suggestion.ipi),
    ipi_reason: asCleanString(
      suggestion.ipi_reason,
      "IPI/EX TIPI preenchido somente quando retornado pela pesquisa fiscal."
    ),
    ex_tipi: asCleanString(suggestion.ex_tipi),
    cenq: asCleanString(suggestion.cenq),
    cbenef: asCleanString(suggestion.cbenef),
    benefit_reason: asCleanString(
      suggestion.benefit_reason,
      "Beneficios e reducoes fiscais dependem de NCM, UF, regime, cBenef e enquadramento legal."
    ),
    vtottrib: asCleanString(suggestion.vtottrib),
    observations: asStringArray(suggestion.observations, 6)
  };
}

function buildFiscalLayers(ai = {}, context = {}, fieldSuggestions = {}, profile = {}) {
  const layers = ai.fiscal_layers || {};
  const fiscalUf = context.tax_scope?.uf || context.company?.uf || "";
  return {
    produto: {
      ncm: asCleanString(layers.produto?.ncm, fieldSuggestions.ncm || "00000000"),
      descricao_fiscal: asCleanString(layers.produto?.descricao_fiscal, fieldSuggestions.ncm_description || ""),
      cest: asCleanString(layers.produto?.cest, fieldSuggestions.cest || ""),
      cest_obrigatorio: normalizeSimNaoIncerto(layers.produto?.cest_obrigatorio, fieldSuggestions.cest_required || "incerto"),
      unidade: asCleanString(layers.produto?.unidade, profile.unidade || context.product?.unidade || ""),
      ex_tipi: asCleanString(layers.produto?.ex_tipi, fieldSuggestions.ex_tipi || ""),
      caracteristicas: asStringArray(layers.produto?.caracteristicas, 8)
    },
    empresa: {
      regime: asCleanString(layers.empresa?.regime, context.company?.regime_tributario || ""),
      uf: asCleanString(layers.empresa?.uf, fiscalUf),
      impacto: asCleanString(layers.empresa?.impacto, `Regime, UF ${fiscalUf || "-"} e contribuinte ICMS afetam CST/CSOSN, beneficios e regras estaduais.`)
    },
    operacao: {
      tipo: asCleanString(layers.operacao?.tipo, context.operation?.type || ""),
      cfop_interno: asCleanString(layers.operacao?.cfop_interno, fieldSuggestions.cfop_internal || ""),
      cfop_interestadual: asCleanString(layers.operacao?.cfop_interestadual, fieldSuggestions.cfop_interstate || ""),
      dependencias: asStringArray(layers.operacao?.dependencias, 6)
    }
  };
}

function buildWhy(ai = {}, context = {}, code = "", description = "") {
  const why = ai.why || {};
  const alternatives = asStringArray(why.discarded_alternatives, 6);
  return {
    identified_as: asCleanString(
      why.identified_as,
      asCleanString(ai.caracteristicas_explicitas?.produto, asCleanString(ai.product_category, context.product?.descricao || ""))
    ),
    official_basis: asCleanString(why.official_basis, description ? `NCM oficial: ${description}` : "Base oficial/local NCM e evidencia web consultadas."),
    evidence_summary: asCleanString(
      why.evidence_summary,
      asCleanString(ai.justificativa_curta, asCleanString(ai.reason, "Classificacao feita por pesquisa web fiscal e referencias oficiais quando disponiveis."))
    ),
    discarded_alternatives: alternatives.slice(0, 6),
    review_recommendation: asCleanString(
      why.review_recommendation,
      "Campos aplicados conforme retorno da pesquisa fiscal."
    )
  };
}

function textMentionsNcm(text, code) {
  const cleanCode = normalizeNcmCode(code);
  if (!cleanCode) return false;
  const rawText = String(text || "");
  const digits = rawText.replace(/\D/g, "");
  if (digits.includes(cleanCode)) return true;
  return normalizeText(rawText).includes(normalizeText(formatNcm(cleanCode)));
}

function webEvidenceSupportsNcm(webEvidence, code) {
  if (webEvidence?.status !== "ok" || !Array.isArray(webEvidence.items)) return false;
  return webEvidence.items.some((item) => textMentionsNcm(`${item.title || ""} ${item.snippet || ""} ${item.url || ""}`, code));
}

function extractNcmCodesFromText(text) {
  const codes = new Set();
  const rawText = String(text || "");
  for (const match of rawText.matchAll(/\b(\d{4})[.\s-]?(\d{2})[.\s-]?(\d{2})\b/g)) {
    const code = normalizeNcmCode(`${match[1]}${match[2]}${match[3]}`);
    if (code && code !== "00000000") codes.add(code);
  }
  return [...codes];
}

function getOfficialNcmsFromWebEvidence(webEvidence) {
  if (webEvidence?.status !== "ok" || !Array.isArray(webEvidence.items)) return [];
  const counts = new Map();
  for (const item of webEvidence.items) {
    const text = `${item.title || ""} ${item.snippet || ""} ${item.url || ""}`;
    for (const code of extractNcmCodesFromText(text)) {
      if (!getOfficialNcmRow(code)) continue;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([codigo, count]) => ({ codigo, count, row: getOfficialNcmRow(codigo) }))
    .sort((a, b) => b.count - a.count || a.codigo.localeCompare(b.codigo));
}

function getNcmsFromWebEvidence(webEvidence) {
  if (webEvidence?.status !== "ok" || !Array.isArray(webEvidence.items)) return [];
  const counts = new Map();
  for (const item of webEvidence.items) {
    const text = `${item.title || ""} ${item.snippet || ""} ${item.url || ""}`;
    for (const code of extractNcmCodesFromText(text)) {
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([codigo, count]) => ({ codigo, count, row: getOfficialNcmRow(codigo) || null }))
    .sort((a, b) => Number(Boolean(b.row)) - Number(Boolean(a.row)) || b.count - a.count || a.codigo.localeCompare(b.codigo));
}

function pickWebEvidenceNcm(webEvidence, preferredCode) {
  const officialCodes = getOfficialNcmsFromWebEvidence(webEvidence);
  const cleanPreferred = normalizeNcmCode(preferredCode);
  const preferred = officialCodes.find((item) => item.codigo === cleanPreferred);
  if (preferred) return preferred;
  if (officialCodes.length === 1) return officialCodes[0];

  const allCodes = getNcmsFromWebEvidence(webEvidence);
  const anyPreferred = allCodes.find((item) => item.codigo === cleanPreferred);
  if (anyPreferred) return anyPreferred;
  return allCodes.length === 1 ? allCodes[0] : null;
}

function aiSourcesSupportNcm(sources = [], code) {
  const cleanCode = normalizeNcmCode(code);
  if (!cleanCode) return false;
  return sources.some((source) => normalizeNcmCode(source?.code) === cleanCode);
}

function aiSourceDescription(sources = [], code) {
  const cleanCode = normalizeNcmCode(code);
  const source = sources.find((item) => normalizeNcmCode(item?.code) === cleanCode && item?.description);
  return source?.description ? String(source.description) : null;
}

function normalizeAiClassificationStatus(status) {
  const text = normalizeText(status).replace(/\s+/g, "_");
  if (["classificado", "apply", "aplicado"].includes(text)) return "CLASSIFICADO";
  if (["review", "uncertain"].includes(text)) {
    return "REVISAO_MANUAL";
  }
  if (["erro_base_fiscal", "base_error", "base_fiscal"].includes(text)) return "ERRO_BASE_FISCAL";
  if (["erro_openai", "openai_error"].includes(text)) return "ERRO_OPENAI";
  if (["erro_validacao", "invalid_ncm", "validation_error"].includes(text)) return "ERRO_VALIDACAO";
  return "REVISAO_MANUAL";
}

function validateAiResponseIdentity(ai = {}, context = {}) {
  const expectedRequestId = asCleanString(context.request_id);
  const returnedRequestId = asCleanString(ai.request_id);
  const expectedSku = asCleanString(context.product?.sku || context.product?.codigo_produto || "");
  const returnedSku = asCleanString(ai.sku);
  const errors = [];

  if (expectedRequestId && returnedRequestId !== expectedRequestId) {
    errors.push(`request_id divergente: esperado ${expectedRequestId}, recebido ${returnedRequestId || "vazio"}.`);
  }

  if (expectedSku && returnedSku && normalizeText(expectedSku) !== normalizeText(returnedSku)) {
    errors.push(`sku divergente: esperado ${expectedSku}, recebido ${returnedSku}.`);
  }

  return { ok: errors.length === 0, errors };
}

function buildAiWarnings(ai, context, code) {
  return asStringArray(ai?.avisos || ai?.warnings, 8).slice(0, 6);
}

function buildStructuredFiscalOutput(context = {}, result = {}) {
  const profile = result.product_profile || {};
  const suggestions = result.field_suggestions || {};
  const fieldScores = result.field_scores || {};
  const status = result.status || "REVISAO_MANUAL";
  const fiscalUf = context.tax_scope?.uf || context.company?.uf || "";
  const operation = String(context.operation?.type || "").toUpperCase();
  return {
    request_id: context.request_id || "",
    sku: context.product?.sku || context.product?.codigo_produto || "",
    descricao_original: context.product?.descricao || "",
    caracteristicas_explicitas: {
      produto: profile.produto_base || "",
      marca: profile.marca || "",
      composicao: profile.composicao || "",
      material: profile.material || "",
      finalidade: profile.finalidade || "",
      embalagem: profile.embalagem || "",
      volume: profile.volume || "",
      unidade: profile.unidade || "",
      funcao_principal: profile.funcao_principal || "",
      funcionamento: profile.funcionamento || "",
      uso: profile.uso || "",
      outras: profile.caracteristicas || []
    },
    produto_fiscal: {
      ncm: result.ncm || "00000000",
      confianca_ncm: result.confidence || 0,
      cest: suggestions.cest || null,
      confianca_cest: fieldScores.cest || 0,
      ipi: {
        cst: suggestions.cst_ipi || null,
        aliquota: suggestions.ipi || null,
        ex_tipi: suggestions.ex_tipi || null,
        cenq: suggestions.cenq || null
      },
      unidade: suggestions.unidade || profile.unidade || context.product?.unidade || ""
    },
    operacao_fiscal: {
      operacao: operation,
      uf_origem: fiscalUf,
      uf_destino: fiscalUf,
      cfop: suggestions.cfop_internal || "",
      cfop_interestadual: suggestions.cfop_interstate || "",
      icms: {
        csosn: suggestions.csosn || null,
        cst: suggestions.cst_icms || null,
        aliquota: suggestions.aliquota_icms ?? null,
        fcp: suggestions.aliquota_fcp ?? null,
        st: suggestions.icms_st || "incerto"
      },
      pis: {
        cst: suggestions.cst_pis || null,
        aliquota: suggestions.aliquota_pis ?? null
      },
      cofins: {
        cst: suggestions.cst_cofins || null,
        aliquota: suggestions.aliquota_cofins ?? null
      },
      ibs_cbs: {
        cst: suggestions.ibs_cbs_cst || null,
        cclass_trib: suggestions.cclass_trib || null,
        aliquota_ibs_uf: suggestions.aliquota_ibs_uf ?? null,
        aliquota_ibs_municipio: suggestions.aliquota_ibs_municipio ?? null,
        aliquota_cbs: suggestions.aliquota_cbs ?? null
      },
      cbenef: suggestions.cbenef || null,
      vtottrib: suggestions.vtottrib || null
    },
    validacao: {
      aplicou: Boolean(result.eligible_to_apply),
      status
    },
    justificativa_curta: result.reason || ""
  };
}

function buildTechnicalAiPayload(context = {}, status = "ERRO_VALIDACAO", reason = "", details = {}) {
  return {
    request_id: context.request_id || "",
    sku: context.product?.sku || context.product?.codigo_produto || "",
    descricao_original: context.product?.descricao || "",
    caracteristicas_explicitas: {
      produto: context.product?.descricao || "",
      marca: context.product?.marca || "",
      composicao: "",
      material: "",
      finalidade: "",
      embalagem: "",
      volume: "",
      unidade: context.product?.unidade || "",
      dimensao: "",
      apresentacao: "",
      funcao_principal: "",
      funcionamento: "",
      uso: "",
      outras: []
    },
    ncm: "00000000",
    confianca_ncm: 0.01,
    cest_possivel: "",
    confianca_cest: 0,
    dados_fiscais: {
      sku: context.product?.sku || context.product?.codigo_produto || "",
      ean_gtin: context.product?.ean || context.product?.codigo_barras || "",
      descricao: context.product?.descricao || "",
      ncm: "00000000",
      cest: "",
      unidade: context.product?.unidade || "",
      origem: "",
      cfop_interno: context.operation?.cfop_interno_default || "",
      cfop_interestadual: context.operation?.cfop_interestadual_default || "",
      cst_icms: "",
      csosn: "",
      aliquota_icms: "",
      icms_st: "",
      aliquota_fcp: "",
      cst_pis: "",
      aliquota_pis: "",
      cst_cofins: "",
      aliquota_cofins: "",
      cst_ipi: "",
      aliquota_ipi: "",
      ex_tipi: "",
      cenq: "",
      ibs_cbs_cst: "",
      cclass_trib: "",
      aliquota_ibs_uf: "",
      aliquota_ibs_municipio: "",
      aliquota_cbs: "",
      cbenef: "",
      vtottrib: "",
      observacao: reason
    },
    justificativa_curta: reason,
    status,
    fontes: [],
    avisos: asStringArray(details.avisos || details.warnings, 6)
  };
}

function normalizeAiNcmResult(ai, context) {
  const aiStatus = normalizeAiClassificationStatus(ai?.status);
  const identity = validateAiResponseIdentity(ai, context);
  const fiscal = aiFiscalData(ai);
  const rawNcmValue = ai?.ncm || fiscal.ncm;
  const rawNcmDigits = String(rawNcmValue || "").replace(/\D/g, "");
  const aiNcm = rawNcmDigits.length === 8 ? rawNcmDigits : "";
  const aiReturnedNcm = aiNcm && aiNcm !== "00000000" ? aiNcm : "";
  const cleanNcm = aiReturnedNcm;
  const official = cleanNcm ? getOfficialNcmRow(cleanNcm) : null;
  const validNcm = Boolean(cleanNcm && cleanNcm.length === 8 && cleanNcm !== "00000000");
  const fromAiSources = aiSourcesSupportNcm(ai?.fontes || ai?.sources || [], cleanNcm);
  const fromWebEvidence = Boolean(webEvidenceSupportsNcm(context.web_evidence, cleanNcm) || fromAiSources);
  const invalidReturnedNcm = Boolean(rawNcmValue && rawNcmDigits.length !== 8);
  const confidence = clampConfidence(ai?.confianca_ncm ?? ai?.confidence);
  const productProfile = buildDefaultProductProfile(context, ai);
  // A resposta da pesquisa web e tratada como fonte de verdade do produto: uma
  // divergencia de request_id/sku (checagem administrativa de sanidade) vira aviso,
  // nao bloqueia mais o NCM nem os campos fiscais que a IA efetivamente encontrou.
  const acceptedNcm = Boolean(validNcm && !invalidReturnedNcm);
  const outputNcm = acceptedNcm ? cleanNcm : "00000000";
  const description = acceptedNcm
    ? fiscalText(fiscal.descricao) || official?.descricao || aiSourceDescription(ai?.fontes || ai?.sources || [], cleanNcm) || ""
    : "";
  const warnings = buildAiWarnings(ai, context, cleanNcm);
  if (!identity.ok) {
    // Divergencia de request_id/sku vira aviso visivel, mas nao derruba a resposta:
    // o que a pesquisa web encontrou para este produto continua sendo aplicado.
    warnings.unshift(...identity.errors);
  }
  let status = aiStatus;

  if (invalidReturnedNcm) {
    status = "ERRO_VALIDACAO";
    const message = `NCM retornado invalido: ${ai?.ncm || fiscal.ncm || "vazio"}.`;
    warnings.unshift(message);
  } else if (acceptedNcm && !official) {
    const message = `NCM ${outputNcm} aplicado pela pesquisa web, mas nao localizado na base NCM oficial local.`;
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
    if (!["ERRO_BASE_FISCAL", "ERRO_OPENAI", "ERRO_VALIDACAO"].includes(status)) status = "CLASSIFICADO";
  } else if (acceptedNcm && !["ERRO_BASE_FISCAL", "ERRO_OPENAI", "ERRO_VALIDACAO"].includes(status)) {
    status = "CLASSIFICADO";
  }

  if (!acceptedNcm && aiReturnedNcm && !invalidReturnedNcm) {
    const message = `NCM ${aiReturnedNcm} nao foi aplicado por falha de validacao do contexto.`;
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
  }

  const fieldSuggestions = buildFieldSuggestions(ai, context, outputNcm || "00000000", description, confidence);
  const fieldScores = buildFieldScores(ai, confidence);
  const safeToApply = Boolean(status === "CLASSIFICADO" && acceptedNcm);
  // O NCM so e gravado quando reduz a 8 digitos validos; os demais campos fiscais
  // (CEST, CFOP, CST/aliquotas, IBS/CBS...) sao gravados sempre que a chamada tiver
  // de fato respondido (nao falhou na OpenAI) - a pesquisa web e tratada como a
  // verdade do produto, sem exigir bater request_id/sku pra confiar no conteudo.
  const fieldsEligibleToApply = Boolean(status !== "ERRO_OPENAI");
  const result = {
    request_id: context.request_id || "",
    sku: context.product?.sku || context.product?.codigo_produto || "",
    ncm: outputNcm,
    formatted: formatNcm(outputNcm),
    descricao: acceptedNcm ? description : "NCM nao aplicado",
    confidence,
    status,
    should_apply: safeToApply,
    needs_review: !safeToApply,
    product_category: String(ai?.caracteristicas_explicitas?.produto || ai?.product_category || ""),
    reason: String(ai?.justificativa_curta || ai?.reason || ""),
    warnings: warnings.slice(0, 8),
    sources: normalizeSources(ai?.fontes || ai?.sources || [], outputNcm, context),
    product_profile: productProfile,
    field_scores: fieldScores,
    fiscal_layers: buildFiscalLayers(ai, context, fieldSuggestions, productProfile),
    field_suggestions: fieldSuggestions,
    why: buildWhy(ai, context, outputNcm, acceptedNcm ? description : ""),
    eligible_to_apply: safeToApply,
    fields_eligible_to_apply: fieldsEligibleToApply,
    validation: {
      status,
      request_id_expected: context.request_id || null,
      request_id_returned: ai?.request_id || null,
      request_id_ok: identity.ok,
      exists_in_official: Boolean(official),
      web_first_policy: true,
      from_web_evidence: fromWebEvidence,
      from_ai_sources: fromAiSources,
      threshold: OPENAI_NCM_APPLY_THRESHOLD,
      researched_ncm: acceptedNcm,
      auto_apply_source_allowed: true,
      returned_ncm: aiReturnedNcm || null,
      selected_ncm: outputNcm !== "00000000" ? outputNcm : null,
      rejected_ncm: outputNcm === "00000000" && aiReturnedNcm ? aiReturnedNcm : null
    }
  };
  result.final_json = buildStructuredFiscalOutput(context, result);
  return result;
}

async function prepareAiNcmContext(classification, options = {}) {
  return buildAiNcmContext(classification, { ...options, use_web: false, useWeb: false });
}

async function buildAiNcmSuggestion(classification, options = {}) {
  const enrichedContext = options.context?.request_id
    ? options.context
    : await buildAiNcmContext(classification, options);

  let response;
  try {
    response = await callOpenAiNcm(enrichedContext);
  } catch (error) {
    const result = normalizeAiNcmResult(
      buildTechnicalAiPayload(enrichedContext, "ERRO_OPENAI", error.message, { avisos: ["Falha na chamada do classificador automatico."] }),
      enrichedContext
    );
    return {
      checked_at: now(),
      provider: "openai",
      model: OPENAI_NCM_MODEL,
      response_id: null,
      usage: null,
      parse_error: error.message,
      context: enrichedContext,
      result,
      billing: options.billing || null,
      message: `Auto classificacao falhou na OpenAI: ${error.message}`,
      policy: "Falha de OpenAI vira ERRO_OPENAI por item, sem aplicar NCM por fallback."
    };
  }

  const responseContext = mergeOpenAiWebEvidence(enrichedContext, response.web_evidence || []);
  if (!response.parsed) {
    const result = normalizeAiNcmResult(
      buildTechnicalAiPayload(responseContext, "ERRO_OPENAI", response.parse_error, {
        avisos: ["A resposta da OpenAI nao seguiu o JSON estruturado."]
      }),
      responseContext
    );
    return {
      checked_at: now(),
      provider: "openai",
      model: response.model,
      response_id: response.response_id,
      usage: response.usage,
      parse_error: response.parse_error,
      context: responseContext,
      result,
      billing: options.billing || null,
      message: response.parse_error,
      policy: "JSON invalido vira ERRO_OPENAI e nao aplica NCM por fallback."
    };
  }

  const result = normalizeAiNcmResult(response.parsed, responseContext);
  return {
    checked_at: now(),
    provider: "openai",
    model: response.model,
    response_id: response.response_id,
    usage: response.usage,
    parse_error: response.parse_error,
    context: responseContext,
    result,
    billing: options.billing || null,
    message: result.eligible_to_apply
      ? `Classificador automatico aplicou ${result.ncm} com ${Math.round(result.confidence * 100)}% de confianca.`
      : `Classificador automatico deixou para revisao: ${result.reason || result.status || "sem confianca suficiente."}`,
    policy: "Uma chamada OpenAI stateless por produto. O backend valida request_id/NCM valido e grava os campos fiscais pesquisados, sem aprendizado e sem referencia local obrigatoria."
  };
}

function getOperationForClassification(classification) {
  if (classification?.operation_type) return normalizeOperationType(classification.operation_type);
  const row = db
    .prepare(
      `
      SELECT ib.operation_type
      FROM products p
      LEFT JOIN import_batches ib ON ib.id = p.batch_id
      WHERE p.id = ?
    `
    )
    .get(classification.product_id);
  return normalizeOperationType(row?.operation_type || "venda");
}

function resolveIbsCbsPatch(suggested = {}) {
  const suggestedCst = asCleanString(suggested.ibs_cbs_cst);
  const suggestedClass = asCleanString(suggested.cclass_trib);
  return {
    ibs_cbs_cst: suggestedCst || null,
    cclass_trib: suggestedClass || null
  };
}

function buildFiscalPatchFromNcm(previous, ncm, aiResult = null) {
  const fiscalUf = getFiscalUfForClassification(previous);
  const company = getCompanyForFiscalUf(fiscalUf);
  const operation = getOperationForClassification(previous);
  const cfops = getCfopPair(operation, company);
  const suggested = aiResult?.field_suggestions || {};
  const ibsCbsPatch = resolveIbsCbsPatch(suggested);
  const suggestedCest = normalizeCestSuggestion(suggested.cest, suggested.cest_required);
  const noCestRequired = isNoCestSignal(suggestedCest, suggested.cest_required);
  const finalCest = noCestRequired ? "SEM CEST OBRIGATORIO" : suggestedCest || null;
  const finalIcmsSt = normalizeSimNaoIncerto(
    suggested.icms_st,
    noCestRequired ? "nao" : finalCest && finalCest !== "SEM CEST OBRIGATORIO" ? "sim" : "incerto"
  );
  const finalCfopInterno = asCleanString(suggested.cfop_internal, cfops.interno);
  const finalCfopInterestadual = asCleanString(suggested.cfop_interstate, cfops.interestadual);
  const finalPis = asCleanString(suggested.cst_pis);
  const finalCofins = asCleanString(suggested.cst_cofins);
  const suggestedCsosn = asCleanString(suggested.csosn);
  const suggestedCstIcms = asCleanString(suggested.cst_icms);
  const finalCsosn = suggestedCsosn || null;

  return {
    unidade: asCleanString(suggested.unidade, previous.unidade || null),
    sku: asCleanString(suggested.sku, previous.sku || previous.codigo_produto || null),
    ean: asCleanString(suggested.ean, previous.ean || previous.codigo_barras || null),
    ncm,
    cest: finalCest,
    cfop_interno: finalCfopInterno,
    cfop_interestadual: finalCfopInterestadual,
    cst_icms: suggestedCstIcms || null,
    aliquota_icms: numberOrFallback(suggested.aliquota_icms, null),
    icms_st: finalIcmsSt,
    csosn: finalCsosn,
    origem: asCleanString(suggested.origem),
    cst_pis: finalPis,
    aliquota_pis: numberOrFallback(suggested.aliquota_pis, null),
    cst_cofins: finalCofins,
    aliquota_cofins: numberOrFallback(suggested.aliquota_cofins, null),
    aliquota_fcp: numberOrFallback(suggested.aliquota_fcp, null),
    ibs_cbs_cst: ibsCbsPatch.ibs_cbs_cst,
    cclass_trib: ibsCbsPatch.cclass_trib,
    aliquota_ibs_uf: numberOrFallback(suggested.aliquota_ibs_uf, null),
    aliquota_ibs_municipio: numberOrFallback(suggested.aliquota_ibs_municipio, null),
    aliquota_cbs: numberOrFallback(suggested.aliquota_cbs, null),
    cst_ipi: asCleanString(suggested.cst_ipi),
    ipi: asCleanString(suggested.ipi),
    ex_tipi: asCleanString(suggested.ex_tipi),
    cenq: asCleanString(suggested.cenq),
    cbenef: asCleanString(suggested.cbenef),
    vtottrib: numberOrFallback(suggested.vtottrib, null)
  };
}

function updateClassificationAiNcm(id, aiCheck, options = {}, actor = "contador") {
  const previous = getClassification(id);
  if (!previous) return null;
  const currentSuggestion = previous.sugestao || {};
  const shouldTryApply = options.apply_suggestion !== false && options.applySuggestion !== false;
  const notApproved = previous.status !== "approved";
  // NCM so e sobrescrito quando reduz a 8 digitos validos (nao exige mais bater request_id/sku).
  const canApplyNcm = Boolean(shouldTryApply && notApproved && aiCheck.result?.eligible_to_apply);
  // Os demais campos fiscais (CEST, CFOP, CST/aliquotas ICMS-PIS-COFINS-IPI, IBS/CBS, cBenef, vTotTrib...)
  // sao gravados sempre que a resposta for da requisicao certa e a chamada nao tiver falhado,
  // mesmo quando o NCM ainda ficar pendente de revisao manual - antes eles eram descartados junto.
  const canApplyFields = Boolean(shouldTryApply && notApproved && aiCheck.result?.fields_eligible_to_apply);
  const ncmForPatch = canApplyNcm ? aiCheck.result.ncm : previous.ncm;
  const fiscalPatch = canApplyFields ? buildFiscalPatchFromNcm(previous, ncmForPatch, aiCheck.result) : previous;
  const nextAiCheck = canApplyFields
    ? { ...aiCheck, applied_fiscal: fiscalPatch, applied_ncm: canApplyNcm }
    : aiCheck;
  const nextSuggestion = { ...currentSuggestion, ai_ncm: nextAiCheck };
  const confidence = canApplyFields ? Math.max(Number(previous.confianca || 0), aiCheck.result.confidence) : previous.confianca;
  const observation = canApplyFields
    ? canApplyNcm
      ? `NCM e fiscal aplicados pelo classificador automatico: ${aiCheck.result.ncm} - ${aiCheck.result.descricao || aiCheck.result.reason}`
      : `Campos fiscais aplicados pelo classificador automatico (NCM mantido para revisao manual): ${aiCheck.result?.reason || "confira o NCM antes de aprovar."}`
    : `${previous.observacao || ""}${previous.observacao ? " " : ""}Auto classificacao: ${aiCheck.result?.reason || "revisar manualmente."}`.trim();

  db.prepare(
    `
    UPDATE classifications SET
      sku = ?, ean = ?, ncm = ?, cest = ?, cfop_interno = ?, cfop_interestadual = ?,
      cst_icms = ?, aliquota_icms = ?, icms_st = ?, csosn = ?, origem = ?, cst_pis = ?,
      aliquota_pis = ?, cst_cofins = ?, aliquota_cofins = ?, aliquota_fcp = ?,
      ibs_cbs_cst = ?, cclass_trib = ?, aliquota_ibs_uf = ?, aliquota_ibs_municipio = ?, aliquota_cbs = ?,
      cst_ipi = ?, ipi = ?, ex_tipi = ?, cenq = ?, cbenef = ?, vtottrib = ?,
      confianca = ?, status = ?, observacao = ?, sugestao_json = ?, updated_at = ?
    WHERE id = ?
  `
  ).run(
    fiscalPatch.sku,
    fiscalPatch.ean,
    fiscalPatch.ncm,
    fiscalPatch.cest,
    fiscalPatch.cfop_interno,
    fiscalPatch.cfop_interestadual,
    fiscalPatch.cst_icms,
    fiscalPatch.aliquota_icms,
    fiscalPatch.icms_st,
    fiscalPatch.csosn,
    fiscalPatch.origem,
    fiscalPatch.cst_pis,
    fiscalPatch.aliquota_pis,
    fiscalPatch.cst_cofins,
    fiscalPatch.aliquota_cofins,
    fiscalPatch.aliquota_fcp,
    fiscalPatch.ibs_cbs_cst,
    fiscalPatch.cclass_trib,
    fiscalPatch.aliquota_ibs_uf,
    fiscalPatch.aliquota_ibs_municipio,
    fiscalPatch.aliquota_cbs,
    fiscalPatch.cst_ipi,
    fiscalPatch.ipi,
    fiscalPatch.ex_tipi,
    fiscalPatch.cenq,
    fiscalPatch.cbenef,
    fiscalPatch.vtottrib,
    Number(confidence || 0),
    previous.status === "approved" ? previous.status : "pending_review",
    observation,
    asJson(nextSuggestion),
    now(),
    id
  );
  if (canApplyFields && fiscalPatch.unidade && fiscalPatch.unidade !== previous.unidade) {
    db.prepare("UPDATE products SET unidade = ? WHERE id = ?").run(fiscalPatch.unidade, previous.product_id);
  }

  const updated = getClassification(id);
  logAudit("classification", id, "openai_ncm_check", actor, previous, updated, {
    source_table: "openai_responses+web_search",
    table_version: aiCheck.model,
    effective_date: aiCheck.checked_at?.slice(0, 10)
  });
  return updated;
}

function updateClassificationAiBilling(id, billing, actor = "contador") {
  const previous = getClassification(id);
  if (!previous) return null;
  const currentSuggestion = previous.sugestao || {};
  const nextSuggestion = { ...currentSuggestion, ai_ncm_billing: billing };
  db.prepare("UPDATE classifications SET sugestao_json = ?, observacao = ?, updated_at = ? WHERE id = ?").run(
    asJson(nextSuggestion),
    billing.requires_payment ? "Pix gerado. A auto classificacao sera liberada apos confirmar o pagamento." : previous.observacao,
    now(),
    id
  );
  const updated = getClassification(id);
  logAudit("classification", id, "openai_ncm_billing", actor, previous, updated, {
    source_table: "mercado_pago",
    table_version: billing.payment_id || billing.event_id,
    effective_date: now().slice(0, 10)
  });
  return updated;
}

async function checkClassificationAiNcm(id, options = {}, actor = "contador") {
  assertOpenAiConfigured();
  const previous = getClassification(id);
  if (!previous) return null;
  const context = options.context?.request_id ? options.context : await prepareAiNcmContext(previous, options);
  const billing = options.skip_billing
    ? options.billing || null
    : await resolveAiBillingForUse({ classificationId: id, quantity: 1, actor, context: "item", options });
  if (billing?.enabled && billing.requires_payment) {
    return updateClassificationAiBilling(id, billing, actor);
  }
  const check = await buildAiNcmSuggestion(previous, { ...options, billing, context });
  return updateClassificationAiNcm(id, check, options, actor);
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];
  const workerCount = Math.min(normalizeAiNcmConcurrency(concurrency), items.length);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(workerId) {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index, workerId);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index + 1)));
  return results;
}

async function checkReviewTableAiNcm(options = {}, actor = "contador") {
  assertOpenAiConfigured();
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const rows = db.prepare("SELECT id FROM classifications WHERE status != 'approved' ORDER BY id LIMIT ?").all(limit);
  const aiJobs = [];

  for (const row of rows) {
    const previous = getClassification(row.id);
    if (!previous) continue;
    const context = await prepareAiNcmContext(previous, options);
    aiJobs.push({ id: row.id, context });
  }

  const billing = aiJobs.length
    ? await resolveAiBillingForUse({ quantity: aiJobs.length, actor, context: "table", options })
    : {
        enabled: billingEnabled(),
        status: rows.length ? "no_billable_items" : "empty",
        paid: true,
        requires_payment: false,
        quantity: 0,
      amount_cents: 0,
      amount_brl: 0
      };
  if (billing?.enabled && billing.requires_payment) {
    logAudit("review_table", null, "openai_ncm_billing", actor, { total: rows.length, billable: aiJobs.length }, { billing });
    return {
      checked: 0,
      applied: 0,
      counts: {},
      payment_required: true,
      openai: aiNcmConfig(),
      billing,
      items: listClassifications({ limit: 500 })
    };
  }
  const paidQuantity = billing?.enabled ? Math.max(0, Number(billing.quantity || 0)) : aiJobs.length;
  const billableRows = billing?.enabled ? aiJobs.slice(0, paidQuantity) : aiJobs;
  const concurrency = billableRows.length ? Math.min(OPENAI_NCM_CONCURRENCY, billableRows.length) : 0;
  const progressMessage = concurrency > 1
    ? `Auto classificacao em andamento (${concurrency} produtos por vez). Nao feche o navegador.`
    : "Auto classificacao em andamento. Nao feche o navegador.";
  let processed = 0;
  let failed = 0;
  const runningItems = new Map();

  function publishProgress(patch = {}) {
    if (!billing?.event_id) return null;
    return updateBillingAiProgress(billing.event_id, {
      total: billableRows.length,
      processed,
      status: "processing",
      concurrency: concurrency || 1,
      active_workers: runningItems.size,
      running_items: Array.from(runningItems.values()),
      failed,
      message: progressMessage,
      ...patch
    });
  }

  if (billing?.event_id) {
    publishProgress({
      processed: 0,
      percent: 0,
      status: "processing",
      started_at: now()
    });
  }

  const results = await runWithConcurrency(billableRows, concurrency || 1, async (row, index, workerId) => {
    const currentItem = { id: row.id, position: index + 1 };
    runningItems.set(workerId, currentItem);
    publishProgress({ current_item: currentItem });

    try {
      const updated = await checkClassificationAiNcm(row.id, { ...options, skip_billing: true, billing, context: row.context }, actor);
      return updated ? { updated } : null;
    } catch (error) {
      failed += 1;
      logAudit(
        "classification",
        row.id,
        "openai_ncm_error",
        actor,
        { id: row.id },
        { error: error.message },
        { source_table: "openai", effective_date: now().slice(0, 10) }
      );
      return { error: error.message, row_id: row.id };
    } finally {
      processed += 1;
      runningItems.delete(workerId);
      publishProgress({ processed, current_item: currentItem });
    }
  });

  const items = [];
  const counts = {};
  let applied = 0;
  for (const result of results) {
    if (result?.error) {
      counts.error = (counts.error || 0) + 1;
      continue;
    }
    const updated = result?.updated;
    if (!updated) continue;
    const check = updated.sugestao?.ai_ncm;
    const status = check?.result?.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
    if (check?.result?.eligible_to_apply) applied += 1;
    items.push(updated);
  }

  if (failed && !items.length && billableRows.length) {
    const error = new Error(`Nao foi possivel auto classificar nenhum item. ${failed} produto(s) falharam durante a consulta.`);
    error.status = 502;
    throw error;
  }
  const unpaidItems = Math.max(0, aiJobs.length - billableRows.length);
  logAudit("review_table", null, "openai_ncm_check_all", actor, { total: rows.length }, {
    total: items.length,
    applied,
    counts,
    unpaidItems,
    billableItems: aiJobs.length
  });
  return {
    checked: items.length,
    applied,
    counts,
    failed,
    concurrency: concurrency || 1,
    paid_items: billableRows.length,
    unpaid_items: unpaidItems,
    base_error_items: 0,
    openai: aiNcmConfig(),
    billing: billing?.event_id ? publicBillingFromEvent(getAiBillingEvent(billing.event_id)) : billing,
    items
  };
}

function markBillingAiProcessing(event) {
  const current = getAiBillingEvent(event.id);
  if (!current) return { process: false, reason: "not_found" };
  const metadata = current.metadata || {};
  if (metadata.ai_processed_at) return { process: false, reason: "already_processed" };

  const startedAt = metadata.ai_processing_started_at ? Date.parse(metadata.ai_processing_started_at) : 0;
  const processingFresh = startedAt && Date.now() - startedAt < 15 * 60 * 1000;
  if (processingFresh) return { process: false, reason: "already_processing" };

  db.prepare("UPDATE ai_billing_events SET status = 'processing_ai', metadata_json = ?, updated_at = ? WHERE id = ?").run(
    asJson({
      ...metadata,
      ai_processing_started_at: now(),
      ai_processing_error: null,
      ai_progress: buildAiBillingProgress(
        {
          ...(metadata.ai_progress || {}),
          total: current.quantity || 1,
          processed: 0,
          percent: 0,
          status: "processing",
          concurrency: OPENAI_NCM_CONCURRENCY,
          active_workers: 0,
          failed: 0,
          message: "Auto classificacao iniciada. Nao feche o navegador.",
          started_at: metadata.ai_progress?.started_at || now(),
          updated_at: now()
        },
        { total: current.quantity || 1 }
      )
    }),
    now(),
    current.id
  );
  return { process: true, event: getAiBillingEvent(current.id) };
}

function markBillingAiProcessed(eventId, result) {
  const event = getAiBillingEvent(eventId);
  if (!event) return;
  const metadata = event.metadata || {};
  const checked = result?.checked ?? (result?.item ? 1 : 0);
  const paidItems = result?.paid_items ?? null;
  const total = paidItems || checked || event.quantity || metadata.ai_progress?.total || 1;
  const applied = result?.applied ?? (result?.item?.sugestao?.ai_ncm?.result?.eligible_to_apply ? 1 : 0);
  const failed = result?.failed ?? metadata.ai_progress?.failed ?? 0;
  db.prepare("UPDATE ai_billing_events SET status = 'paid', metadata_json = ?, updated_at = ? WHERE id = ?").run(
    asJson({
      ...metadata,
      ai_processed_at: now(),
      ai_processing_started_at: null,
      ai_processing_error: null,
      ai_progress: buildAiBillingProgress(
        {
          ...(metadata.ai_progress || {}),
          total,
          processed: total,
          percent: 100,
          status: "completed",
          failed,
          message: "Completo.",
          completed_at: now(),
          updated_at: now()
        },
        { total, processed: total, percent: 100, status: "completed" }
      ),
      ai_result_summary: {
        checked,
        applied,
        failed,
        paid_items: paidItems,
        unpaid_items: result?.unpaid_items ?? null
      }
    }),
    now(),
    event.id
  );
}

function markBillingAiProcessingError(eventId, error) {
  const event = getAiBillingEvent(eventId);
  if (!event) return;
  const metadata = event.metadata || {};
  db.prepare("UPDATE ai_billing_events SET status = 'paid', metadata_json = ?, updated_at = ? WHERE id = ?").run(
    asJson({
      ...metadata,
      ai_processing_started_at: null,
      ai_processing_error: {
        message: error.message,
        at: now()
      },
      ai_progress: buildAiBillingProgress(
        {
          ...(metadata.ai_progress || {}),
          status: "error",
          message: `Falha na auto classificacao: ${error.message}`,
          updated_at: now()
        },
        { total: event.quantity || 1, status: "error" }
      )
    }),
    now(),
    event.id
  );
}

async function processPaidAiBillingEvent(eventId, actor = "mercado_pago_webhook") {
  const event = getAiBillingEvent(eventId);
  if (!event) return { processed: false, reason: "not_found" };
  const paymentStatus = event.metadata?.payment?.payment_status;
  if (paymentStatus !== "approved" && event.status !== "paid") {
    return { processed: false, reason: "not_paid" };
  }

  const marker = markBillingAiProcessing(event);
  if (!marker.process) return { processed: false, reason: marker.reason };

  try {
    const current = marker.event || event;
    const context = current.metadata?.context || "table";
    const options = {
      billing_event_id: current.id,
      apply_suggestion: true,
      use_web: true,
      skip_payment_refresh: true,
      limit: Math.min(Math.max(Number(current.quantity || 1), 1), 500)
    };
    const result =
      context === "item" && current.classification_id
        ? { item: await checkClassificationAiNcm(Number(current.classification_id), options, actor) }
        : await checkReviewTableAiNcm(options, actor);
    markBillingAiProcessed(current.id, result);
    return { processed: true, context, result };
  } catch (error) {
    markBillingAiProcessingError(event.id, error);
    console.error("Falha ao processar auto classificacao apos webhook Mercado Pago:", error.message);
    return { processed: false, reason: "processing_error", error: error.message };
  }
}

function shouldStartAiFromBillingStatus(event, billing) {
  if (!billing?.paid || billing.ai_processing || billing.ai_processed) return false;
  if (!billing.ai_error) return true;
  return normalizeText(billing.ai_error).includes("falha ao consultar mercado pago");
}

function extractMercadoPagoPaymentId(body = {}, query = {}) {
  return String(
    body?.data?.id ||
      body?.resource?.id ||
      body?.id ||
      query["data.id"] ||
      query.id ||
      query.payment_id ||
      ""
  ).trim();
}

function isMercadoPagoPaymentWebhook(body = {}, query = {}) {
  const topic = String(body?.type || body?.action || query.type || query.topic || "").toLowerCase();
  return !topic || topic.includes("payment");
}

function isMercadoPagoPaymentUpdated(body = {}) {
  return String(body?.action || "").toLowerCase() === "payment.updated";
}

function trustedMercadoPagoWebhookPayment(paymentId, event, fetchError) {
  const payment = event?.metadata?.payment || {};
  return {
    id: paymentId,
    status: "approved",
    status_detail: "trusted_payment_updated_webhook",
    external_reference: payment.external_reference || null,
    point_of_interaction: {
      transaction_data: {
        qr_code_base64: payment.qr_code_base64 || null,
        qr_code: payment.qr_code || null,
        ticket_url: payment.ticket_url || event?.checkout_url || null
      }
    },
    metadata: {
      ...(event?.metadata || {}),
      billing_event_id: event?.id || null,
      trusted_webhook_without_fetch: true,
      mercado_pago_fetch_error: fetchError?.message || null
    }
  };
}

function logMercadoPagoWebhook(body = {}, payment = null, result = {}) {
  try {
    logAudit(
      "billing",
      result.event_id || null,
      "mercado_pago_webhook",
      "mercado_pago",
      {
        action: body.action || null,
        type: body.type || null,
        data_id: body.data?.id || null
      },
      {
        ...result,
        payment_id: result.payment_id || payment?.id || body.data?.id || null,
        payment_status: payment?.status || null,
        external_reference: payment?.external_reference || null
      },
      {
        source_table: "mercado_pago",
        table_version: payment?.id || body.data?.id || null,
        effective_date: now().slice(0, 10)
      }
    );
  } catch (error) {
    console.error("Falha ao registrar webhook Mercado Pago:", error.message);
  }
}

async function handleMercadoPagoBillingWebhook(body = {}, query = {}) {
  if (!isMercadoPagoPaymentWebhook(body, query)) {
    const result = { received: true, ignored: true, reason: "not_payment_notification" };
    logMercadoPagoWebhook(body, null, result);
    return result;
  }
  const paymentId = extractMercadoPagoPaymentId(body, query);
  if (!paymentId) {
    const result = { received: true, ignored: true, reason: "missing_payment_id" };
    logMercadoPagoWebhook(body, null, result);
    return result;
  }

  const eventFromNotification = getAiBillingEventByPaymentId(paymentId);
  let payment;
  try {
    payment = await fetchMercadoPagoPaymentById(paymentId);
  } catch (error) {
    if (AI_BILLING_TRUST_PAYMENT_UPDATED_WEBHOOK && eventFromNotification && isMercadoPagoPaymentUpdated(body)) {
      payment = trustedMercadoPagoWebhookPayment(paymentId, eventFromNotification, error);
      const updatedEvent = updateBillingEventWithPaymentPayload(eventFromNotification, payment);
      const result = {
        received: true,
        event_id: updatedEvent.id,
        payment_id: paymentId,
        status: payment.status,
        ai_processing: true,
        trusted_webhook_without_fetch: true,
        mercado_pago_fetch_error: error.message
      };
      processPaidAiBillingEvent(updatedEvent.id, "mercado_pago_webhook_trusted").catch((processingError) => {
        markBillingAiProcessingError(updatedEvent.id, processingError);
        console.error("Falha ao iniciar auto classificacao pelo webhook Mercado Pago confiavel:", processingError.message);
      });
      logMercadoPagoWebhook(body, payment, result);
      return result;
    }
    const result = {
      received: true,
      ignored: true,
      reason: "mercado_pago_fetch_failed",
      payment_id: paymentId,
      error: error.message
    };
    logMercadoPagoWebhook(body, null, result);
    return result;
  }

  const event = getAiBillingEventFromPaymentPayload(payment) || eventFromNotification;
  if (!event) {
    const result = {
      received: true,
      ignored: true,
      reason: "billing_event_not_found",
      payment_id: payment.id || paymentId,
      payment_status: payment.status || null,
      external_reference: payment.external_reference || null
    };
    logMercadoPagoWebhook(body, payment, result);
    return result;
  }

  const updatedEvent = updateBillingEventWithPaymentPayload(event, payment);
  if (payment.status === "approved") {
    const result = {
      received: true,
      event_id: updatedEvent.id,
      payment_id: payment.id || paymentId,
      status: payment.status,
      ai_processing: true
    };
    processPaidAiBillingEvent(updatedEvent.id, "mercado_pago_webhook").catch((error) => {
      markBillingAiProcessingError(updatedEvent.id, error);
      console.error("Falha ao iniciar auto classificacao pelo webhook Mercado Pago:", error.message);
    });
    logMercadoPagoWebhook(body, payment, result);
    return result;
  }

  const result = {
    received: true,
    event_id: updatedEvent.id,
    payment_id: payment.id || paymentId,
    status: payment.status,
    ai_processing: false
  };
  logMercadoPagoWebhook(body, payment, result);
  return result;
}

function getCfopPair(operationType, company) {
  const origem = normalizeUf(company?.uf, "SP");
  const internal = db.prepare(`
    SELECT cfop FROM regras_cfop
    WHERE tipo_operacao = ? AND (uf_origem = ? OR uf_origem = '*') AND uf_destino = ?
    ORDER BY uf_origem DESC LIMIT 1
  `).get(operationType, origem, origem)?.cfop;

  const interstate = db.prepare(`
    SELECT cfop FROM regras_cfop
    WHERE tipo_operacao = ? AND (uf_origem = ? OR uf_origem = '*') AND uf_destino = '*'
    ORDER BY uf_origem DESC LIMIT 1
  `).get(operationType, origem)?.cfop;

  return {
    interno: internal || (operationType === "compra" ? "1102" : "5102"),
    interestadual: interstate || (operationType === "compra" ? "2102" : "6102")
  };
}

function getPisCofins(ncm, options = {}) {
  const exact = db.prepare("SELECT * FROM regras_pis_cofins_por_ncm WHERE ncm = ? LIMIT 1").get(ncm);
  if (exact) return exact;
  if (!options.allowFallback) return null;
  return db.prepare("SELECT * FROM regras_pis_cofins_por_ncm WHERE ncm = '00000000' LIMIT 1").get() || null;
}

function getPisCofinsCst(pisCofins = {}) {
  if (!pisCofins) return "";
  const incidence = normalizeText(pisCofins.tipo_incidencia || "");
  if (incidence.includes("monofasica")) return "04";
  if (incidence.includes("zero")) return "06";
  return "01";
}

function getIbptEstimate(ncm, company, price) {
  const itemPrice = Number(price || 0);
  if (!itemPrice) return null;
  const row = db
    .prepare(
      `
      SELECT *
      FROM ibpt
      WHERE uf = ? AND (ncm = ? OR ncm LIKE ?)
      ORDER BY CASE WHEN ncm = ? THEN 0 ELSE 1 END, vigencia_fim DESC
      LIMIT 1
    `
    )
    .get(normalizeUf(company?.uf, "SP"), ncm, `${String(ncm || "").slice(0, 4)}%`, ncm);
  if (!row) return null;
  const totalRate = Number(row.aliquota_federal || 0) + Number(row.aliquota_estadual || 0) + Number(row.aliquota_municipal || 0);
  return Number(((itemPrice * totalRate) / 100).toFixed(2));
}

function pickFiscalBenefit(tables, company) {
  const benefits = tables.cbenef || [];
  const fiscalUf = normalizeUf(company?.uf, "");
  return benefits.find((item) => item.uf === fiscalUf) || benefits.find((item) => item.uf === "*") || null;
}

function pickIbsCbsClassification(tables, cst) {
  const rows = tables.ibs_cbs_classificacao || [];
  return rows.find((item) => String(item.cst_permitido || "").split(/[,\s]+/).includes(cst)) || rows[0] || null;
}

function classifyProduct(product, operationType = "venda", uf = "") {
  const baseCompany = getCompany();
  const fiscalUf = normalizeUf(uf || product.uf, baseCompany?.uf || "SP");
  const company = getCompanyForFiscalUf(fiscalUf);
  const operation = normalizeOperationType(operationType);
  const tokens = extractTokens(`${product.descricao_original} ${product.marca || ""} ${product.categoria || ""}`);
  const cfops = getCfopPair(operation, company);

  const confidenceParts = [
    product.codigo_barras ? 0.04 : 0,
    product.categoria ? 0.04 : 0
  ];
  const confidence = Math.min(0.3, Math.max(0.05, confidenceParts.reduce((sum, item) => sum + item, 0)));

  return {
    operation_type: operation,
    uf: fiscalUf,
    sku: product.codigo_produto || null,
    ean: product.codigo_barras || null,
    ncm: "00000000",
    cest: null,
    cfop_interno: cfops.interno,
    cfop_interestadual: cfops.interestadual,
    cst_icms: null,
    aliquota_icms: null,
    icms_st: "incerto",
    csosn: null,
    origem: "0",
    cst_pis: null,
    aliquota_pis: null,
    cst_cofins: null,
    aliquota_cofins: null,
    aliquota_fcp: null,
    ibs_cbs_cst: null,
    cclass_trib: null,
    aliquota_ibs_uf: null,
    aliquota_ibs_municipio: null,
    aliquota_cbs: null,
    cst_ipi: null,
    ipi: null,
    ex_tipi: null,
    cenq: null,
    cbenef: null,
    vtottrib: null,
    confianca: Number(confidence.toFixed(2)),
    status: "pending_review",
    observacao: "Pre-classificacao inicial sem aprendizado legado. Use Auto Classificar Produtos para completar os campos fiscais com contexto de UF.",
    sugestao_json: {
      tokens,
      ncm: { codigo: "00000000", source: "web_first_pending" },
      aprendizado_legado: "disabled",
      empresa: {
        crt: company.crt,
        regime_tributario: company.regime_tributario,
        uf: fiscalUf,
        contribuinte_icms: Boolean(company.contribuinte_icms)
      },
      operacao: operation
    }
  };
}

function createImportBatch({ filename, sourceType, operationType, uf, importedBy, rowCount }) {
  const operation = normalizeOperationType(operationType);
  const fiscalUf = normalizeUf(uf, getCompany()?.uf || "SP");
  const result = db.prepare(`
    INSERT INTO import_batches (filename, source_type, operation_type, uf, imported_by, row_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(filename || null, sourceType, operation, fiscalUf, importedBy || "sistema", rowCount || 0, now());
  return Number(result.lastInsertRowid);
}

function insertProduct(batchId, product, operationType, uf = "") {
  const fiscalUf = normalizeUf(product.uf || uf, getCompany()?.uf || "SP");
  const descricaoTratada = normalizeText(product.descricao_original);
  const result = db.prepare(`
    INSERT INTO products (
      batch_id, codigo_produto, descricao_original, descricao_tratada, unidade, preco,
      codigo_barras, peso, marca, categoria, ncm_importado, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batchId,
    product.codigo_produto || null,
    product.descricao_original,
    descricaoTratada,
    product.unidade || null,
    product.preco ?? null,
    product.codigo_barras || null,
    product.peso || null,
    product.marca || null,
    product.categoria || null,
    product.ncm_importado || null,
    asJson(product),
    now()
  );
  const productId = Number(result.lastInsertRowid);
  const operation = normalizeOperationType(operationType);
  const classification = classifyProduct({ ...product, descricao_tratada: descricaoTratada, uf: fiscalUf }, operation, fiscalUf);
  db.prepare(`
    INSERT INTO classifications (
      product_id, operation_type, uf, sku, ean, ncm, cest, cfop_interno, cfop_interestadual, cst_icms,
      aliquota_icms, icms_st, csosn, origem, cst_pis, aliquota_pis, cst_cofins, aliquota_cofins,
      aliquota_fcp, ibs_cbs_cst,
      cclass_trib, aliquota_ibs_uf, aliquota_ibs_municipio, aliquota_cbs, cst_ipi, ipi, ex_tipi, cenq,
      cbenef, vtottrib, confianca, status, observacao, sugestao_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    operation,
    classification.uf,
    classification.sku,
    classification.ean,
    classification.ncm,
    classification.cest,
    classification.cfop_interno,
    classification.cfop_interestadual,
    classification.cst_icms,
    classification.aliquota_icms,
    classification.icms_st,
    classification.csosn,
    classification.origem,
    classification.cst_pis,
    classification.aliquota_pis,
    classification.cst_cofins,
    classification.aliquota_cofins,
    classification.aliquota_fcp,
    classification.ibs_cbs_cst,
    classification.cclass_trib,
    classification.aliquota_ibs_uf,
    classification.aliquota_ibs_municipio,
    classification.aliquota_cbs,
    classification.cst_ipi,
    classification.ipi,
    classification.ex_tipi,
    classification.cenq,
    classification.cbenef,
    classification.vtottrib,
    classification.confianca,
    classification.status,
    classification.observacao,
    asJson(classification.sugestao_json),
    now()
  );
  return productId;
}

function importProducts({ products, filename, sourceType, operationType, uf, importedBy }) {
  const cleanProducts = products
    .map((product, index) => mapProductRow(product, index))
    .filter((product) => product.descricao_original);
  const operation = normalizeOperationType(operationType);
  const fiscalUf = normalizeUf(uf, getCompany()?.uf || "SP");
  const batchId = createImportBatch({
    filename,
    sourceType,
    operationType: operation,
    uf: fiscalUf,
    importedBy,
    rowCount: cleanProducts.length
  });
  const ids = cleanProducts.map((product) => insertProduct(batchId, { ...product, uf: fiscalUf }, operation, fiscalUf));
  logAudit("import_batch", batchId, "import", importedBy || "sistema", null, {
    filename,
    sourceType,
    operationType: operation,
    uf: fiscalUf,
    rowCount: cleanProducts.length
  });
  return { batchId, imported: ids.length, operationType: operation, uf: fiscalUf };
}

function rowToClassification(row) {
  return {
    id: row.classification_id,
    product_id: row.product_id,
    batch_id: row.batch_id,
    operation_type: normalizeOperationType(row.operation_type || row.batch_operation_type || "venda"),
    uf: normalizeUf(row.uf || row.batch_uf || getCompany()?.uf, "SP"),
    codigo_produto: row.codigo_produto,
    descricao_original: row.descricao_original,
    descricao_tratada: row.descricao_tratada,
    unidade: row.unidade,
    preco: row.preco,
    codigo_barras: row.codigo_barras,
    peso: row.peso,
    marca: row.marca,
    categoria: row.categoria,
    ncm_importado: row.ncm_importado,
    sku: row.sku || row.codigo_produto,
    ean: row.ean || row.codigo_barras,
    ncm: row.ncm,
    cest: row.cest,
    cfop_interno: row.cfop_interno,
    cfop_interestadual: row.cfop_interestadual,
    cst_icms: row.cst_icms,
    aliquota_icms: row.aliquota_icms,
    icms_st: row.icms_st,
    csosn: row.csosn,
    origem: row.origem,
    cst_pis: row.cst_pis,
    aliquota_pis: row.aliquota_pis,
    cst_cofins: row.cst_cofins,
    aliquota_cofins: row.aliquota_cofins,
    aliquota_fcp: row.aliquota_fcp,
    ibs_cbs_cst: row.ibs_cbs_cst,
    cclass_trib: row.cclass_trib,
    aliquota_ibs_uf: row.aliquota_ibs_uf,
    aliquota_ibs_municipio: row.aliquota_ibs_municipio,
    aliquota_cbs: row.aliquota_cbs,
    cst_ipi: row.cst_ipi,
    ipi: row.ipi,
    ex_tipi: row.ex_tipi,
    cenq: row.cenq,
    cbenef: row.cbenef,
    vtottrib: row.vtottrib,
    confianca: row.confianca,
    status: row.status,
    observacao: row.observacao,
    sugestao: parseJson(row.sugestao_json, {}),
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    updated_at: row.updated_at,
    created_at: row.created_at
  };
}

function listClassifications(params = {}) {
  const where = [];
  const values = [];
  if (params.status && params.status !== "all") {
    where.push("c.status = ?");
    values.push(params.status);
  }
  if (params.q) {
    where.push("(p.descricao_original LIKE ? OR p.codigo_produto LIKE ? OR c.ncm LIKE ?)");
    const term = `%${params.q}%`;
    values.push(term, term, term);
  }
  const sql = `
    SELECT
      c.id AS classification_id, c.*,
      p.id AS product_id, p.batch_id, p.codigo_produto, p.descricao_original,
      p.descricao_tratada, p.unidade, p.preco, p.codigo_barras, p.peso,
      p.marca, p.categoria, p.ncm_importado, p.created_at,
      ib.operation_type AS batch_operation_type,
      ib.uf AS batch_uf
    FROM classifications c
    JOIN products p ON p.id = c.product_id
    LEFT JOIN import_batches ib ON ib.id = p.batch_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      CASE c.status WHEN 'pending_review' THEN 0 WHEN 'suggested_high_confidence' THEN 1 ELSE 2 END,
      c.updated_at DESC
    LIMIT ?
  `;
  values.push(Math.min(Number(params.limit || 250), 1000));
  return db.prepare(sql).all(...values).map(rowToClassification);
}

function getClassification(id) {
  const row = db.prepare(`
    SELECT
      c.id AS classification_id, c.*,
      p.id AS product_id, p.batch_id, p.codigo_produto, p.descricao_original,
      p.descricao_tratada, p.unidade, p.preco, p.codigo_barras, p.peso,
      p.marca, p.categoria, p.ncm_importado, p.created_at,
      ib.operation_type AS batch_operation_type,
      ib.uf AS batch_uf
    FROM classifications c
    JOIN products p ON p.id = c.product_id
    LEFT JOIN import_batches ib ON ib.id = p.batch_id
    WHERE c.id = ?
  `).get(id);
  return row ? rowToClassification(row) : null;
}

function updateClassification(id, patch, actor = "contador") {
  const previous = getClassification(id);
  if (!previous) return null;
  const allowed = [
    "operation_type",
    "uf",
    "sku",
    "ean",
    "ncm",
    "cest",
    "cfop_interno",
    "cfop_interestadual",
    "cst_icms",
    "aliquota_icms",
    "icms_st",
    "csosn",
    "origem",
    "cst_pis",
    "aliquota_pis",
    "cst_cofins",
    "aliquota_cofins",
    "aliquota_fcp",
    "ibs_cbs_cst",
    "cclass_trib",
    "aliquota_ibs_uf",
    "aliquota_ibs_municipio",
    "aliquota_cbs",
    "cst_ipi",
    "ipi",
    "ex_tipi",
    "cenq",
    "cbenef",
    "vtottrib",
    "confianca",
    "status",
    "observacao"
  ];
  const next = { ...previous };
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) next[field] = patch[field] === "" ? null : patch[field];
  }
  next.operation_type = normalizeOperationType(next.operation_type || previous.operation_type || "venda");
  next.uf = normalizeUf(next.uf || previous.uf || getCompany()?.uf, "SP");
  const operationChanged = Object.prototype.hasOwnProperty.call(patch, "operation_type") && next.operation_type !== previous.operation_type;
  const ufChanged = Object.prototype.hasOwnProperty.call(patch, "uf") && next.uf !== previous.uf;
  if (operationChanged || ufChanged) {
    const cfops = getCfopPair(next.operation_type, getCompanyForFiscalUf(next.uf));
    next.cfop_interno = cfops.interno;
    next.cfop_interestadual = cfops.interestadual;
    if (ufChanged) {
      const stateFields = ["cest", "aliquota_icms", "aliquota_fcp", "aliquota_ibs_uf", "aliquota_ibs_municipio", "cbenef", "vtottrib"];
      for (const field of stateFields) {
        if (!Object.prototype.hasOwnProperty.call(patch, field)) next[field] = null;
      }
      if (!Object.prototype.hasOwnProperty.call(patch, "icms_st")) next.icms_st = "incerto";
    }
    const operationNote = `${operationChanged ? `Operacao alterada para ${next.operation_type}` : "UF fiscal alterada"}; CFOP recalculado para UF ${next.uf}.`;
    next.observacao = next.observacao ? `${next.observacao} ${operationNote}` : operationNote;
  }
  db.prepare(`
    UPDATE classifications SET
      operation_type = ?, uf = ?, sku = ?, ean = ?, ncm = ?, cest = ?, cfop_interno = ?, cfop_interestadual = ?,
      cst_icms = ?, aliquota_icms = ?, icms_st = ?, csosn = ?, origem = ?, cst_pis = ?,
      aliquota_pis = ?, cst_cofins = ?, aliquota_cofins = ?, aliquota_fcp = ?,
      ibs_cbs_cst = ?, cclass_trib = ?, aliquota_ibs_uf = ?, aliquota_ibs_municipio = ?, aliquota_cbs = ?,
      cst_ipi = ?, ipi = ?, ex_tipi = ?, cenq = ?, cbenef = ?, vtottrib = ?,
      confianca = ?, status = ?, observacao = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.operation_type,
    next.uf,
    next.sku,
    next.ean,
    next.ncm,
    next.cest,
    next.cfop_interno,
    next.cfop_interestadual,
    next.cst_icms,
    next.aliquota_icms,
    next.icms_st,
    next.csosn,
    next.origem,
    next.cst_pis,
    next.aliquota_pis,
    next.cst_cofins,
    next.aliquota_cofins,
    next.aliquota_fcp,
    next.ibs_cbs_cst,
    next.cclass_trib,
    next.aliquota_ibs_uf,
    next.aliquota_ibs_municipio,
    next.aliquota_cbs,
    next.cst_ipi,
    next.ipi,
    next.ex_tipi,
    next.cenq,
    next.cbenef,
    next.vtottrib,
    next.confianca,
    next.status,
    next.observacao,
    now(),
    id
  );
  const updated = getClassification(id);
  logAudit("classification", id, "update", actor, previous, updated);
  return updated;
}

function approveClassification(id, actor = "contador") {
  const updated = updateClassification(id, { status: "approved", confianca: 1 }, actor);
  if (!updated) return null;
  db.prepare("UPDATE classifications SET approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(
    actor,
    now(),
    now(),
    id
  );
  const approved = getClassification(id);
  logAudit("classification", id, "approve", actor, updated, approved);
  return approved;
}

function getDashboard() {
  const statusRows = db.prepare("SELECT status, COUNT(*) AS total FROM classifications GROUP BY status").all();
  const byStatus = Object.fromEntries(statusRows.map((row) => [row.status, row.total]));
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(AVG(confianca), 0) AS confianca_media,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS aprovados,
      SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pendentes
    FROM classifications
  `).get();
  const batches = db.prepare("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 8").all();
  const audits = db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 8").all();
  return {
    summary: {
      total: summary.total || 0,
      confianca_media: Number((summary.confianca_media || 0).toFixed(2)),
      aprovados: summary.aprovados || 0,
      pendentes: summary.pendentes || 0,
      by_status: byStatus
    },
    batches,
    audits,
    recent: listClassifications({ limit: 8 })
  };
}

function clearReviewTable(actor = "contador") {
  const previous = db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM classifications) AS classifications,
        (SELECT COUNT(*) FROM products) AS products,
        (SELECT COUNT(*) FROM import_batches) AS import_batches
    `
    )
    .get();

  db.exec(`
    DELETE FROM classifications;
    DELETE FROM products;
    DELETE FROM import_batches;
    DELETE FROM sqlite_sequence WHERE name IN ('classifications', 'products', 'import_batches');
  `);

  const next = { classifications: 0, products: 0, import_batches: 0 };
  logAudit("review_table", null, "clear", actor, previous, next);
  return { cleared: true, previous, next };
}

function clearTrainingRules(actor = "contador", onlyInvalid = false) {
  const where = onlyInvalid ? "WHERE COALESCE(ncm, '') = '00000000'" : "";
  const previous = db.prepare(`SELECT COUNT(*) AS total FROM validated_rules ${where}`).get();
  db.exec(`DELETE FROM validated_rules ${where};`);
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'validated_rules';");
  const next = { total: db.prepare("SELECT COUNT(*) AS total FROM validated_rules").get().total };
  logAudit("validated_rules", null, onlyInvalid ? "clear_invalid_training" : "clear_training", actor, previous, next);
  return { cleared: true, removed: previous.total || 0, remaining: next.total, only_invalid: onlyInvalid };
}

function getCatalogs() {
  return {
    ncm: db.prepare("SELECT * FROM ncm_oficial ORDER BY codigo LIMIT 200").all().map((row) => ({
      ...row,
      keywords: parseJson(row.keywords_json, [])
    })),
    cfop: db.prepare("SELECT * FROM cfop_oficial ORDER BY codigo").all(),
    regras_cfop: db.prepare("SELECT * FROM regras_cfop ORDER BY tipo_operacao, cfop").all(),
    origem_mercadoria: db.prepare("SELECT * FROM origem_mercadoria ORDER BY codigo").all(),
    cst_icms: db.prepare("SELECT * FROM cst_icms ORDER BY codigo").all(),
    csosn: db.prepare("SELECT * FROM csosn ORDER BY codigo").all(),
    cst_pis: db.prepare("SELECT * FROM cst_pis ORDER BY codigo").all(),
    cst_cofins: db.prepare("SELECT * FROM cst_cofins ORDER BY codigo").all(),
    ibs_cbs_cst: db.prepare("SELECT * FROM ibs_cbs_cst ORDER BY codigo").all(),
    ibs_cbs_classificacao: db.prepare("SELECT * FROM ibs_cbs_classificacao ORDER BY cclass_trib").all()
  };
}

function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function companyExportName(company = getCompany()) {
  return String(company?.razao_social || "Empresa sem nome").trim() || "Empresa sem nome";
}

function exportFilename(extension) {
  const company = getCompany();
  const base = normalizeText(companyExportName(company))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `dados-fiscais-${base || "empresa"}.${extension}`;
}

const EXPORT_PRODUCT_HEADERS = [
  "Produto",
  "SKU",
  "EAN",
  "Unidade",
  "UF",
  "Operacao",
  "NCM",
  "CEST",
  "CFOP interno",
  "CFOP interestadual",
  "CST ICMS",
  "Aliquota ICMS",
  "ICMS/ST",
  "CSOSN",
  "Origem",
  "CST PIS",
  "Aliquota PIS",
  "CST COFINS",
  "Aliquota COFINS",
  "Aliquota FCP",
  "CST IPI",
  "Aliquota IPI",
  "EX TIPI",
  "cEnq",
  "CST IBS/CBS",
  "cClassTrib",
  "Aliquota IBS UF",
  "Aliquota IBS Municipio",
  "Aliquota CBS",
  "cBenef",
  "vTotTrib"
];

function cleanExportProductName(item) {
  const original = String(item?.descricao_original || item?.descricao_tratada || "").trim();
  return original.replace(/^\s*\d+\s*[\-.)]\s*/, "").trim() || original;
}

function buildExportCompanyRows(company = getCompany()) {
  return [
    ["Empresa", companyExportName(company)],
    ["CNPJ", company?.cnpj || ""],
    ["UF", company?.uf || ""],
    ["Municipio", company?.municipio || ""],
    ["Regime", company?.regime_tributario || ""],
    ["Gerado em", new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })]
  ];
}

function buildExportRows() {
  return listClassifications({ limit: 1000 }).map((item) => ({
    Produto: cleanExportProductName(item),
    SKU: item.sku || item.codigo_produto || "",
    EAN: item.ean || item.codigo_barras || "",
    Unidade: item.unidade || "UN",
    UF: item.uf || "",
    Operacao: item.operation_type === "compra" ? "Compra" : "Venda",
    NCM: item.ncm || "",
    CEST: item.cest || "",
    "CFOP interno": item.cfop_interno || "",
    "CFOP interestadual": item.cfop_interestadual || "",
    "CST ICMS": item.cst_icms || "",
    "Aliquota ICMS": item.aliquota_icms ?? "",
    "ICMS/ST": item.icms_st || "",
    CSOSN: item.csosn || "",
    Origem: item.origem || "",
    "CST PIS": item.cst_pis || "",
    "Aliquota PIS": item.aliquota_pis ?? "",
    "CST COFINS": item.cst_cofins || "",
    "Aliquota COFINS": item.aliquota_cofins ?? "",
    "Aliquota FCP": item.aliquota_fcp ?? "",
    "CST IPI": item.cst_ipi || "",
    "Aliquota IPI": item.ipi ?? "",
    "EX TIPI": item.ex_tipi || "",
    cEnq: item.cenq || "",
    "CST IBS/CBS": item.ibs_cbs_cst || "",
    cClassTrib: item.cclass_trib || "",
    "Aliquota IBS UF": item.aliquota_ibs_uf ?? "",
    "Aliquota IBS Municipio": item.aliquota_ibs_municipio ?? "",
    "Aliquota CBS": item.aliquota_cbs ?? "",
    cBenef: item.cbenef || "",
    vTotTrib: item.vtottrib ?? ""
  }));
}

function buildCsvExport() {
  const rows = buildExportRows();
  const headers = EXPORT_PRODUCT_HEADERS;
  return [
    ...buildExportCompanyRows().map((row) => row.map(escapeCsv).join(";")),
    "",
    headers.map(escapeCsv).join(";"),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(";"))
  ].join("\r\n");
}

async function buildXlsxExport() {
  let XLSX;
  try {
    XLSX = await import("xlsx");
  } catch {
    const error = new Error("Para exportar Excel instale as dependencias do backend com npm install.");
    error.status = 422;
    throw error;
  }
  const company = getCompany();
  const rows = buildExportRows();
  const companyRows = buildExportCompanyRows(company);
  const worksheetRows = [
    ...companyRows,
    [],
    EXPORT_PRODUCT_HEADERS,
    ...rows.map((row) => EXPORT_PRODUCT_HEADERS.map((header) => row[header]))
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetRows);
  const headerRowNumber = companyRows.length + 2;
  const lastColumn = XLSX.utils.encode_col(EXPORT_PRODUCT_HEADERS.length - 1);
  worksheet["!autofilter"] = { ref: `A${headerRowNumber}:${lastColumn}${headerRowNumber}` };
  worksheet["!cols"] = [
    { wch: 44 },
    { wch: 10 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 18 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 },
    { wch: 10 },
    { wch: 14 },
    { wch: 12 }
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Dados fiscais");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function getNcmParentRows(codigo, rowsByCode) {
  const digits = String(codigo || "").replace(/\D/g, "");
  const parentLengths = [6, 4, 2].filter((length) => length < digits.length);
  return parentLengths.map((length) => rowsByCode.get(digits.slice(0, length))).filter(Boolean);
}

function extractNcmKeywordTokens(textParts = []) {
  const tokens = [];
  for (const text of textParts) {
    const parts = String(text || "").split(/[;:.]/);
    for (const part of parts) {
      for (const token of extractTokens(part)) {
        if (!tokens.includes(token)) tokens.push(token);
      }
    }
  }
  return tokens.slice(0, 48);
}

async function syncNcmOfficial(actor = "sistema") {
  const response = await fetch(NCM_JSON_URL);
  if (!response.ok) throw new Error(`Falha ao baixar NCM oficial: HTTP ${response.status}`);
  const payload = await response.json();
  const items = Array.isArray(payload)
    ? payload
    : payload.Nomenclaturas || payload.nomenclaturas || payload.data || payload.items || [];
  const rows = items
    .map((item) => {
      const dataFim = item.Data_Fim || item.data_fim || item.dtFim || null;
      return {
        codigo: String(item.Codigo || item.codigo || item.CoNcm || item.coNcm || item.NCM || "").replace(/\D/g, ""),
        descricao: String(item.Descricao || item.descricao || item.noNcm || item.nome || item.description || "").trim(),
        data_inicio: item.Data_Inicio || item.data_inicio || item.dtInicio || null,
        data_fim: dataFim,
        ativo: isFiscalRowActive(dataFim)
      };
    })
    .filter((item) => item.codigo && item.descricao);
  const rowsByCode = new Map(rows.map((item) => [item.codigo, item]));

  const upsert = db.prepare(`
    INSERT INTO ncm_oficial (codigo, descricao, data_inicio, data_fim, ativo, keywords_json, source)
    VALUES (?, ?, ?, ?, ?, ?, 'siscomex_json')
    ON CONFLICT(codigo) DO UPDATE SET
      descricao = excluded.descricao,
      data_inicio = excluded.data_inicio,
      data_fim = excluded.data_fim,
      ativo = excluded.ativo,
      keywords_json = excluded.keywords_json,
      source = 'siscomex_json'
  `);
  for (const item of rows) {
    const contextRows = getNcmParentRows(item.codigo, rowsByCode);
    const keywords = extractNcmKeywordTokens([item.descricao, ...contextRows.map((row) => row.descricao)]);
    upsert.run(item.codigo, item.descricao, item.data_inicio, item.data_fim, item.ativo, asJson(keywords));
  }
  upsertCuratedNcmRows("siscomex_json_curated");
  logAudit("catalog", null, "sync_ncm", actor, null, { source: NCM_JSON_URL, imported: rows.length }, {
    source_table: "ncm_oficial",
    table_version: "download_json",
    effective_date: now().slice(0, 10)
  });
  return { imported: rows.length, source: NCM_JSON_URL };
}

const MERCADO_PAGO_WEBHOOK_PATHS = new Set([
  "/",
  "/api/billing/mercado-pago/webhook",
  "/api/mercado-pago/webhook",
  "/api/webhooks/mercado-pago",
  "/webhooks/mercado-pago",
  "/webhook/mercado-pago",
  "/mercado-pago/webhook",
  "/mercadopago/webhook",
  "/webhook"
]);

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/") {
    return sendJson(res, 200, {
      ok: true,
      service: "Aikkie AutoClass Fiscal",
      health: "/health",
      mercado_pago_webhook: "/webhooks/mercado-pago"
    });
  }

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, { ok: true, service: "Aikkie AutoClass Fiscal", db: DB_PATH });
  }

  if (req.method === "GET" && path === "/api/dashboard") {
    return sendJson(res, 200, getDashboard());
  }

  if (req.method === "GET" && path === "/api/company") {
    return sendJson(res, 200, getCompany());
  }

  if (req.method === "PUT" && path === "/api/company") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    return sendJson(res, 200, upsertCompany(payload));
  }

  if (req.method === "GET" && path === "/api/catalogs") {
    return sendJson(res, 200, getCatalogs());
  }

  if (req.method === "GET" && path === "/api/search/fiscal") {
    return sendJson(
      res,
      200,
      searchFiscal(url.searchParams.get("q") || "", url.searchParams.get("limit") || 20)
    );
  }

  if (req.method === "GET" && path === "/api/ncm-robot/config") {
    return sendJson(res, 200, ncmRobotConfig());
  }

  if (req.method === "GET" && path === "/api/ai-ncm/config") {
    return sendJson(res, 200, aiNcmConfig());
  }

  if (req.method === "GET" && path === "/api/billing/config") {
    return sendJson(res, 200, aiBillingConfig());
  }

  const billingEventMatch = path.match(/^\/api\/billing\/events\/(\d+)$/);
  if (billingEventMatch && req.method === "GET") {
    let event = getAiBillingEvent(Number(billingEventMatch[1]));
    if (!event) return sendJson(res, 404, { error: "Cobranca nao encontrada." });

    let billing = publicBillingFromEvent(event);
    if (!billing.ai_processing && !billing.ai_processed && !billing.ai_error && event.status !== "error") {
      try {
        billing = await refreshMercadoPagoBillingEvent(event);
        event = getAiBillingEvent(event.id) || event;
      } catch (error) {
        billing = {
          ...billing,
          refresh_error: error.message,
          message: `Aguardando confirmacao do Mercado Pago. Nao foi possivel atualizar agora: ${error.message}`
        };
      }
    }
    if (shouldStartAiFromBillingStatus(event, billing)) {
      processPaidAiBillingEvent(event.id, "billing_status_poll").catch((error) => {
        markBillingAiProcessingError(event.id, error);
        console.error("Falha ao iniciar auto classificacao pelo polling de cobranca:", error.message);
      });
      event = getAiBillingEvent(event.id) || event;
      billing = publicBillingFromEvent(event);
    }

    return sendJson(res, 200, billing);
  }

  if (req.method === "POST" && path === "/api/billing/toggle") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertResetPassword(payload);
    return sendJson(res, 200, setAiBillingEnabled(Boolean(payload.enabled), payload.actor || "contador"));
  }

  if (req.method === "GET" && MERCADO_PAGO_WEBHOOK_PATHS.has(path)) {
    return sendJson(res, 200, {
      ok: true,
      service: "mercado_pago_webhook",
      message: "Endpoint do webhook Mercado Pago ativo. Configure este mesmo endereço como URL de notificacao."
    });
  }

  if (req.method === "POST" && MERCADO_PAGO_WEBHOOK_PATHS.has(path)) {
    const rawBody = decodeText(await readBody(req));
    const payload = rawBody ? parseJson(rawBody, {}) : {};
    const query = Object.fromEntries(url.searchParams.entries());
    return sendJson(res, 200, await handleMercadoPagoBillingWebhook(payload, query));
  }

  if (req.method === "POST" && path === "/api/catalogs/sync/ncm") {
    const payload = decodeText(await readBody(req));
    const actor = payload ? parseJson(payload, {})?.actor : "sistema";
    return sendJson(res, 200, await syncNcmOfficial(actor || "sistema"));
  }

  if (req.method === "GET" && path === "/api/classifications") {
    return sendJson(res, 200, {
      items: listClassifications({
        status: url.searchParams.get("status") || "all",
        q: url.searchParams.get("q") || "",
        limit: url.searchParams.get("limit") || 250
      })
    });
  }

  if (req.method === "POST" && path === "/api/classifications/clear") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertResetPassword(payload);
    assertAiProcessingUnlocked();
    return sendJson(res, 200, clearReviewTable(payload.actor || "contador"));
  }

  if (req.method === "POST" && path === "/api/classifications/ai-ncm") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked(payload.billing_event_id || payload.billingEventId);
    return sendJson(res, 200, await checkReviewTableAiNcm(payload, payload.actor || "contador"));
  }

  if (req.method === "POST" && path === "/api/training/clear") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertResetPassword(payload);
    assertAiProcessingUnlocked();
    return sendJson(res, 200, clearTrainingRules(payload.actor || "contador", false));
  }

  if (req.method === "POST" && path === "/api/training/clear-invalid") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertResetPassword(payload);
    assertAiProcessingUnlocked();
    return sendJson(res, 200, clearTrainingRules(payload.actor || "contador", true));
  }

  const classificationMatch = path.match(/^\/api\/classifications\/(\d+)$/);
  if (classificationMatch && req.method === "PATCH") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    const updated = updateClassification(Number(classificationMatch[1]), payload, payload.actor || "contador");
    if (!updated) return sendJson(res, 404, { error: "Classificacao nao encontrada." });
    return sendJson(res, 200, updated);
  }

  const aiNcmMatch = path.match(/^\/api\/classifications\/(\d+)\/ai-ncm$/);
  if (aiNcmMatch && req.method === "POST") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked(payload.billing_event_id || payload.billingEventId);
    const updated = await checkClassificationAiNcm(Number(aiNcmMatch[1]), payload, payload.actor || "contador");
    if (!updated) return sendJson(res, 404, { error: "Classificacao nao encontrada." });
    return sendJson(res, 200, updated);
  }

  const approveMatch = path.match(/^\/api\/classifications\/(\d+)\/approve$/);
  if (approveMatch && req.method === "POST") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    const approved = approveClassification(Number(approveMatch[1]), payload.actor || "contador");
    if (!approved) return sendJson(res, 404, { error: "Classificacao nao encontrada." });
    return sendJson(res, 200, approved);
  }

  if (req.method === "POST" && path === "/api/products/manual") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    const result = importProducts({
      products: [payload],
      filename: "cadastro-manual",
      sourceType: "manual",
      operationType: payload.operation_type || "venda",
      uf: payload.uf || getCompany()?.uf || "SP",
      importedBy: payload.actor || "contador"
    });
    return sendJson(res, 201, result);
  }

  if (req.method === "POST" && path === "/api/imports") {
    assertAiProcessingUnlocked();
    const contentType = req.headers["content-type"] || "";
    const body = await readBody(req);
    if (contentType.includes("multipart/form-data")) {
      const form = parseMultipart(body, contentType);
      const file = form.files[0];
      if (!file) return sendJson(res, 422, { error: "Envie um arquivo para importar." });
      const products = await parseProductsFromFile(file.filename, file.buffer);
      const result = importProducts({
        products,
        filename: file.filename,
        sourceType: extname(file.filename).replace(".", "") || "arquivo",
        operationType: form.fields.operation_type || "venda",
        uf: form.fields.uf || getCompany()?.uf || "SP",
        importedBy: form.fields.imported_by || "contador"
      });
      return sendJson(res, 201, result);
    }

    const payload = JSON.parse(decodeText(body) || "{}");
    if (!Array.isArray(payload.products)) return sendJson(res, 422, { error: "Informe products como lista." });
    const result = importProducts({
      products: payload.products,
      filename: payload.filename || "json",
      sourceType: payload.source_type || "json",
      operationType: payload.operation_type || "venda",
      uf: payload.uf || getCompany()?.uf || "SP",
      importedBy: payload.imported_by || "contador"
    });
    return sendJson(res, 201, result);
  }

  if (req.method === "GET" && path === "/api/audit") {
    const rows = db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 300").all().map((row) => ({
      ...row,
      previous: parseJson(row.previous_json, null),
      next: parseJson(row.next_json, null)
    }));
    return sendJson(res, 200, { items: rows });
  }

  if (req.method === "GET" && path === "/api/export/classifications.csv") {
    assertAiProcessingUnlocked();
    const csv = buildCsvExport();
    const filename = exportFilename("csv");
    sendText(res, 200, csv, "text/csv; charset=utf-8", filename);
    clearReviewTable("exportacao_csv");
    return;
  }

  if (req.method === "GET" && path === "/api/export/classifications.xlsx") {
    assertAiProcessingUnlocked();
    const buffer = await buildXlsxExport();
    return sendBuffer(
      res,
      200,
      buffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      exportFilename("xlsx")
    );
  }

  if (req.method === "GET" && !path.startsWith("/api/") && tryServeFront(url, res)) {
    return;
  }

  return sendJson(res, 404, { error: "Rota nao encontrada." });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Erro interno." });
  });
});

server.listen(PORT, () => {
  console.log(`Aikkie AutoClass Fiscal API rodando em http://localhost:${PORT}`);
});
