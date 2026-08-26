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
const OPENAI_NCM_MAX_CANDIDATES = Math.min(Math.max(Number(process.env.OPENAI_NCM_MAX_CANDIDATES || 8), 3), 15);
const OPENAI_NCM_TIMEOUT_MS = Math.min(Math.max(Number(process.env.OPENAI_NCM_TIMEOUT_MS || 30000), 8000), 90000);
const OPENAI_NCM_MAX_OUTPUT_TOKENS = Math.min(Math.max(Number(process.env.OPENAI_NCM_MAX_OUTPUT_TOKENS || 4200), 600), 8000);
const OPENAI_NCM_WEB_SEARCH_ENABLED = String(process.env.OPENAI_NCM_WEB_SEARCH_ENABLED || "true").toLowerCase() !== "false";
const OPENAI_NCM_CONCURRENCY_INPUT = Number(process.env.OPENAI_NCM_CONCURRENCY || 3);
const OPENAI_NCM_CONCURRENCY = Math.min(
  Math.max(Number.isFinite(OPENAI_NCM_CONCURRENCY_INPUT) ? Math.round(OPENAI_NCM_CONCURRENCY_INPUT) : 3, 1),
  8
);
const AI_LEARNING_ENABLED = String(process.env.AI_LEARNING_ENABLED || "false").toLowerCase() === "true";
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
      ipi REAL,
      ex_tipi TEXT,
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

  ensureTableColumns("classifications", [
    { name: "operation_type", type: "TEXT NOT NULL DEFAULT 'venda'" },
    { name: "sku", type: "TEXT" },
    { name: "ean", type: "TEXT" },
    { name: "aliquota_icms", type: "REAL" },
    { name: "icms_st", type: "TEXT" },
    { name: "aliquota_fcp", type: "REAL" },
    { name: "ex_tipi", type: "TEXT" }
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

function shouldAskForSpecification(tokens, row, hits) {
  const meaningfulHits = new Set(hits.map((hit) => normalizeText(hit)).filter((hit) => !isGenericHitTerm(hit)));
  return tokens.length <= 1 && isGenericNcmRow(row) && meaningfulHits.size > 0 && meaningfulHits.size <= 1;
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
    uf: String(input.uf ?? current.uf ?? "SP").toUpperCase(),
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
  const generic = shouldAskForSpecification(tokens, row, [...meaningfulHits.map((hit) => hit.term), ...phraseHits]);
  const curatedGeneric = isCuratedGenericNcmRow(keywords);
  const curatedSource = ["seed_mvp", "siscomex_json_curated"].includes(row.source);
  const genericBonus = generic ? (curatedGeneric ? 0.18 : 0.04) : 0;
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
          genericBonus +
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
    curated_generic: curatedGeneric,
    needs_specification: generic,
    specification_message: generic
      ? `Produto genérico encontrado em ${row.descricao}. Deseja especificar melhor? Exemplo: Queijo Minas, camarao de agua fria.`
      : null
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
        curated_generic: scored.curated_generic,
        needs_specification: scored.needs_specification,
        specification_message: scored.specification_message
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

function findValidatedRule(tokens, companyId = 1, operationType = "venda") {
  if (!AI_LEARNING_ENABLED) return null;
  const operation = normalizeOperationType(operationType);
  const rules = db
    .prepare(
      `
      SELECT *
      FROM validated_rules
      WHERE empresa_id = ?
        AND COALESCE(ncm, '') != '00000000'
        AND (tipo_operacao IS NULL OR tipo_operacao = '' OR tipo_operacao = ?)
      ORDER BY CASE WHEN tipo_operacao = ? THEN 0 ELSE 1 END, data_validacao DESC
    `
    )
    .all(companyId, operation, operation);
  let best = null;
  for (const rule of rules) {
    const keywords = parseJson(rule.palavras_chave, []);
    if (!keywords.length) continue;
    const hits = keywords.filter((keyword) => tokens.some((token) => tokenMatchesKeyword(token, keyword)));
    const operationBonus = rule.tipo_operacao && normalizeOperationType(rule.tipo_operacao) === operation ? 0.05 : 0;
    const score = Math.min(1, hits.length / keywords.length + operationBonus);
    if (!best || score > best.score) best = { ...rule, score, hits };
  }
  return best && best.score >= 0.55 ? best : null;
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
    curated_generic: scored.curated_generic,
    needs_specification: scored.needs_specification,
    specification_message: scored.specification_message
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
    if (scored.needs_specification && !best.needs_specification) return true;
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
      compareDescValue(Number(a.needs_specification), Number(b.needs_specification)) ||
      compareDescValue(Number(a.needs_specification && a.curated_generic), Number(b.needs_specification && b.curated_generic)) ||
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
    compareDescValue(Number(a.needs_specification), Number(b.needs_specification)) ||
    a.codigo.localeCompare(b.codigo)
  );
}

function ncmSearchRank(row, tokenCount) {
  return (
    (tokenCount <= 1 && row.needs_specification ? 1000 : 0) +
    (tokenCount <= 1 && row.needs_specification && row.curated_generic ? 100 : 0) +
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
    pis_cofins: db.prepare("SELECT * FROM regras_pis_cofins_por_ncm WHERE ncm = ? OR ncm = '00000000' ORDER BY ncm DESC LIMIT 10").all(exactNcm),
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
    ...(AI_LEARNING_ENABLED ? [{
      key: "validated_rules",
      label: "Regras validadas pelo contador",
      table: "validated_rules",
      fields: ["descricao_base", "tipo_operacao", "segmento", "ncm", "cest", "cclass_trib", "aliquota_icms", "aliquota_pis", "aliquota_cofins", "aliquota_fcp"]
    }] : []),
    { key: "cfop_oficial", label: "CFOP oficial", table: "cfop_oficial", fields: ["codigo", "descricao", "tipo", "entrada_saida"] },
    { key: "regras_cfop", label: "Regras CFOP", table: "regras_cfop", fields: ["tipo_operacao", "uf_origem", "uf_destino", "origem_mercadoria", "cfop"] },
    { key: "origem_mercadoria", label: "Origem da mercadoria", table: "origem_mercadoria", fields: ["codigo", "descricao"] },
    { key: "cst_icms", label: "CST ICMS", table: "cst_icms", fields: ["codigo", "descricao"] },
    { key: "csosn", label: "CSOSN", table: "csosn", fields: ["codigo", "descricao"] },
    { key: "cst_pis", label: "CST PIS", table: "cst_pis", fields: ["codigo", "descricao"] },
    { key: "cst_cofins", label: "CST COFINS", table: "cst_cofins", fields: ["codigo", "descricao"] },
    { key: "ibs_cbs_cst", label: "CST IBS/CBS", table: "ibs_cbs_cst", fields: ["codigo", "descricao"] },
    { key: "ibs_cbs_classificacao", label: "cClassTrib IBS/CBS", table: "ibs_cbs_classificacao", fields: ["cclass_trib", "descricao", "cst_permitido", "indicadores"] },
    { key: "cest", label: "CEST/ST", table: "cest", fields: ["codigo_cest", "ncm", "descricao", "segmento", "item_segmento"] },
    { key: "tipi", label: "TIPI/IPI", table: "tipi", fields: ["ncm", "descricao", "ex_tipi", "vigencia"] },
    { key: "regras_pis_cofins_por_ncm", label: "Regras PIS/COFINS por NCM", table: "regras_pis_cofins_por_ncm", fields: ["ncm", "tipo_incidencia"] },
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
    return { query: rawQuery, ncm: [], validated_rules: [], base_results: [] };
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
        needs_specification: scored.needs_specification,
        specification_message: scored.specification_message,
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

  const validated_rules = AI_LEARNING_ENABLED
    ? db
        .prepare("SELECT * FROM validated_rules ORDER BY data_validacao DESC LIMIT 300")
        .all()
        .map((rule) => {
          const keywords = parseJson(rule.palavras_chave, []);
          const hits = keywords.filter((keyword) => tokens.some((token) => tokenMatchesKeyword(token, keyword)));
          const descriptionHit = tokens.some((token) => normalizeText(rule.descricao_base).includes(token));
          return {
            ...rule,
            palavras_chave: keywords,
            score: hits.length + (descriptionHit ? 1 : 0),
            hits
          };
        })
        .filter((rule) => rule.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
    : [];

  return { query: rawQuery, ncm, validated_rules, base_results: searchAllBases(rawQuery, tokens) };
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
      policy: "A web so roda quando a base local ficar incerta ou divergente, e entra apenas como evidencia."
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
    max_candidates: OPENAI_NCM_MAX_CANDIDATES,
    max_output_tokens: OPENAI_NCM_MAX_OUTPUT_TOKENS,
    concurrency: OPENAI_NCM_CONCURRENCY,
    api_url: OPENAI_NCM_API_URL.replace(/\/v1\/responses.*/, "/v1/responses"),
    web_search_enabled: OPENAI_NCM_WEB_SEARCH_ENABLED,
    key_hint: OPENAI_API_KEY ? `${OPENAI_API_KEY.slice(0, 7)}...${OPENAI_API_KEY.slice(-4)}` : null,
    billing: aiBillingConfig(),
    engine: "aikkie_fiscal_2_0",
    layers: ["produto", "empresa", "operacao"],
    learning: {
      enabled: AI_LEARNING_ENABLED,
      mode: AI_LEARNING_ENABLED ? "contador_validado" : "disabled"
    },
    policy: "O classificador usa whitelist da NCM oficial vigente, escolhe apenas entre candidatos validados e so aplica automaticamente com 90% ou mais, sem pergunta bloqueante."
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
  const number = Number(value);
  if (!Number.isFinite(number)) return OPENAI_NCM_CONCURRENCY;
  return Math.min(8, Math.max(1, Math.round(number)));
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

function buildOfficialEvidence(row, role = "candidate") {
  if (!row?.codigo || normalizeNcmCode(row.codigo) === "00000000") return null;
  return {
    type: "official",
    role,
    title: `Tabela oficial NCM Siscomex - ${formatNcm(row.codigo)}`,
    url: NCM_JSON_URL,
    snippet: `${row.codigo} - ${row.descricao}`,
    source: row.source || "ncm_oficial",
    checked_at: now()
  };
}

function shouldUseWebEvidence(checkStatus) {
  return ["divergent", "missing", "invalid", "uncertain", "needs_specification"].includes(checkStatus);
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

function buildFiscalSearchQueries(productName) {
  const cleanProduct = String(productName || "").replace(/\s+/g, " ").trim() || "produto";
  return {
    ncm: `${cleanProduct} NCM`,
    cest: `${cleanProduct} CEST`,
    cest_required: `${cleanProduct} CEST obrigatorio`,
    ncm_cest: `${cleanProduct} NCM CEST`,
    ex_tipi: `${cleanProduct} NCM EX TIPI TIPI IPI`,
    unidade: `${cleanProduct} unidade comercial unidade tributavel NCM`,
    cfop: `${cleanProduct} CFOP venda compra dentro fora do estado`,
    icms_st_fcp: `${cleanProduct} ICMS ST FCP CEST`,
    pis_cofins: `${cleanProduct} PIS COFINS CST aliquota NCM`,
    ibs_cbs: `${cleanProduct} IBS CBS CST cClassTrib LC 214 2025 reducao aliquota zero beneficio fiscal`,
    fiscal_full: `${cleanProduct} NCM CEST EX TIPI CFOP ICMS ST FCP PIS COFINS IPI IBS CBS cClassTrib beneficio fiscal`
  };
}

async function fetchWebEvidence(productName, candidate, options = {}) {
  const query = buildFiscalSearchQueries(productName).fiscal_full;
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

function strongNcmCandidate(candidate) {
  return (
    candidate?.codigo &&
    candidate.codigo !== "00000000" &&
    Number(candidate.score || 0) >= 0.68 &&
    Number(candidate.meaningful_hit_count || 0) > 0
  );
}

function evaluateNcmCheck({ currentCode, currentRow, currentScore, candidate }) {
  const candidateStrong = strongNcmCandidate(candidate);
  const candidateCode = normalizeNcmCode(candidate?.codigo);

  if (candidate?.needs_specification) {
    return {
      status: "needs_specification",
      severity: "warning",
      message: candidate.specification_message || "Produto generico. Especifique melhor antes de aprovar o NCM."
    };
  }

  if (!currentCode || currentCode === "00000000") {
    return candidateStrong
      ? {
          status: "missing",
          severity: "warning",
          message: `Produto sem NCM. O robo encontrou ${candidateCode} na base oficial/local para revisao.`
        }
      : {
          status: "uncertain",
          severity: "warning",
          message: "Produto sem NCM e sem semelhanca suficiente na base local."
        };
  }

  if (!currentRow) {
    return candidateStrong
      ? {
          status: "invalid",
          severity: "danger",
          message: `NCM atual ${currentCode} nao esta ativo na tabela oficial. Candidato local: ${candidateCode}.`
        }
      : {
          status: "invalid",
          severity: "danger",
          message: `NCM atual ${currentCode} nao esta ativo na tabela oficial e o robo nao encontrou candidato forte.`
        };
  }

  if (candidateCode && candidateCode === currentCode && Number(currentScore?.score || 0) >= 0.45) {
    return {
      status: "ok",
      severity: "ok",
      message: "NCM atual bate com a melhor sugestao da base oficial/local."
    };
  }

  if (candidateStrong && candidateCode !== currentCode) {
    return {
      status: "divergent",
      severity: "danger",
      message: `NCM atual ${currentCode} diverge da melhor sugestao local ${candidateCode}. Revisar antes de aprovar.`
    };
  }

  return {
    status: "uncertain",
    severity: "warning",
    message: "NCM existe na base oficial, mas a descricao do produto nao deu confianca suficiente."
  };
}

function getNcmCheckCandidates(productText, limit = 5) {
  return searchFiscal(productText, limit).ncm.map((item) => ({
    codigo: item.codigo,
    descricao: item.descricao,
    score: item.score,
    source: item.source,
    hits: item.hits,
    occurrence_count: item.occurrence_count,
    meaningful_hit_count: item.meaningful_hit_count,
    phrase_hits: item.phrase_hits,
    curated_source: item.curated_source,
    needs_specification: item.needs_specification,
    specification_message: item.specification_message
  }));
}

async function buildNcmCheck(classification, options = {}) {
  const productText = `${classification.descricao_original || ""} ${classification.marca || ""} ${classification.categoria || ""}`.trim();
  const tokens = extractTokens(productText);
  const currentCode = normalizeNcmCode(classification.ncm);
  const currentRow = getOfficialNcmRow(currentCode);
  const currentScore = currentRow ? scoreNcmCandidate(currentRow, tokens, productText) : null;
  const candidate = findNcmMatch({ ...classification, ncm_importado: "" }, tokens, { useImportedNcm: false });
  const candidateRow = getOfficialNcmRow(candidate.codigo) || candidate;
  const candidates = getNcmCheckCandidates(productText, 5);
  const evaluation = evaluateNcmCheck({ currentCode, currentRow, currentScore, candidate });
  const official_sources = [
    buildOfficialEvidence(currentRow, "current"),
    buildOfficialEvidence(candidateRow, "candidate")
  ].filter(Boolean);
  const useWeb = Boolean(options.use_web || options.useWeb);
  const web = await fetchWebEvidence(productText, candidate, {
    useWeb: useWeb && shouldUseWebEvidence(evaluation.status)
  });
  const confidence = Math.min(0.99, Math.max(0.18, Number(candidate.score || 0) / 1.35));

  return {
    checked_at: now(),
    product: {
      id: classification.product_id,
      descricao: classification.descricao_original
    },
    current: {
      codigo: currentCode || "00000000",
      exists_in_official: Boolean(currentRow),
      descricao: currentRow?.descricao || null,
      source: currentRow?.source || null,
      score: currentScore ? Number(currentScore.score.toFixed(2)) : 0,
      hits: currentScore?.hits || []
    },
    candidate: {
      ...candidate,
      score: Number(candidate.score || 0),
      formatted: formatNcm(candidate.codigo)
    },
    candidates,
    confidence: Number(confidence.toFixed(2)),
    status: evaluation.status,
    severity: evaluation.severity,
    message: evaluation.message,
    official_sources,
    web,
    policy: "A evidencia web nao aprova NCM automaticamente; ela so ajuda o contador na revisao."
  };
}

function updateClassificationNcmCheck(id, check, options = {}, actor = "contador") {
  const previous = getClassification(id);
  if (!previous) return null;
  const currentSuggestion = previous.sugestao || {};
  const nextSuggestion = { ...currentSuggestion, ncm_check: check };
  const canApply =
    Boolean(options.apply_suggestion || options.applySuggestion) &&
    previous.status !== "approved" &&
    strongNcmCandidate(check.candidate) &&
    ["missing", "divergent", "invalid"].includes(check.status);
  const nextNcm = canApply ? check.candidate.codigo : previous.ncm;
  const nextConfidence = canApply ? Math.max(Number(previous.confianca || 0), check.confidence) : previous.confianca;
  const nextStatus = previous.status === "approved" ? previous.status : "pending_review";
  const nextObservation = canApply
    ? `NCM sugerido pelo robo para revisao: ${check.candidate.codigo} - ${check.candidate.descricao}`
    : previous.observacao;

  db.prepare(
    `
    UPDATE classifications SET
      ncm = ?, confianca = ?, status = ?, observacao = ?, sugestao_json = ?, updated_at = ?
    WHERE id = ?
  `
  ).run(nextNcm, nextConfidence, nextStatus, nextObservation, asJson(nextSuggestion), now(), id);

  const updated = getClassification(id);
  logAudit("classification", id, "ncm_robot_check", actor, previous, updated, {
    source_table: "ncm_oficial",
    table_version: check.official_sources?.[0]?.url || NCM_JSON_URL,
    effective_date: check.checked_at?.slice(0, 10)
  });
  return updated;
}

async function checkClassificationNcm(id, options = {}, actor = "contador") {
  const previous = getClassification(id);
  if (!previous) return null;
  const check = await buildNcmCheck(previous, options);
  return updateClassificationNcmCheck(id, check, options, actor);
}

async function checkReviewTableNcm(options = {}, actor = "contador") {
  const limit = Math.min(Math.max(Number(options.limit || 500), 1), 1000);
  const rows = db.prepare("SELECT id FROM classifications ORDER BY id LIMIT ?").all(limit);
  const items = [];
  const counts = {};
  for (const row of rows) {
    const updated = await checkClassificationNcm(row.id, options, actor);
    if (!updated) continue;
    const check = updated.sugestao?.ncm_check;
    const status = check?.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
    items.push(updated);
  }
  logAudit("review_table", null, "ncm_robot_check_all", actor, { total: rows.length }, { total: items.length, counts });
  return {
    checked: items.length,
    counts,
    use_web: Boolean(options.use_web || options.useWeb),
    apply_suggestion: Boolean(options.apply_suggestion || options.applySuggestion),
    web: ncmRobotConfig().web_evidence,
    items
  };
}

const AI_NCM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "ncm",
    "confidence",
    "status",
    "should_apply",
    "needs_review",
    "product_category",
    "reason",
    "warnings",
    "sources",
    "product_profile",
    "field_scores",
    "smart_questions",
    "fiscal_layers",
    "field_suggestions",
    "why"
  ],
  properties: {
    ncm: { type: "string" },
    confidence: { type: "number" },
    status: { type: "string", enum: ["apply", "review", "uncertain", "insufficient_info", "invalid_ncm"] },
    should_apply: { type: "boolean" },
    needs_review: { type: "boolean" },
    product_category: { type: "string" },
    reason: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    sources: {
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
    product_profile: {
      type: "object",
      additionalProperties: false,
      required: [
        "produto_base",
        "marca",
        "composicao",
        "material",
        "finalidade",
        "embalagem",
        "volume",
        "unidade",
        "funcao_principal",
        "funcionamento",
        "uso",
        "caracteristicas",
        "missing_characteristics"
      ],
      properties: {
        produto_base: { type: "string" },
        marca: { type: "string" },
        composicao: { type: "string" },
        material: { type: "string" },
        finalidade: { type: "string" },
        embalagem: { type: "string" },
        volume: { type: "string" },
        unidade: { type: "string" },
        funcao_principal: { type: "string" },
        funcionamento: { type: "string" },
        uso: { type: "string" },
        caracteristicas: { type: "array", items: { type: "string" } },
        missing_characteristics: { type: "array", items: { type: "string" } }
      }
    },
    field_scores: {
      type: "object",
      additionalProperties: false,
      required: ["ncm", "cest", "cfop", "csosn_cst", "icms", "icms_st", "fcp", "ibs_cbs", "pis_cofins", "ipi", "cbenef"],
      properties: {
        ncm: { type: "number" },
        cest: { type: "number" },
        cfop: { type: "number" },
        csosn_cst: { type: "number" },
        icms: { type: "number" },
        icms_st: { type: "number" },
        fcp: { type: "number" },
        ibs_cbs: { type: "number" },
        pis_cofins: { type: "number" },
        ipi: { type: "number" },
        cbenef: { type: "number" }
      }
    },
    smart_questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "question", "options", "reason", "blocks_auto_apply"],
        properties: {
          field: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          blocks_auto_apply: { type: "boolean" }
        }
      }
    },
    fiscal_layers: {
      type: "object",
      additionalProperties: false,
      required: ["produto", "empresa", "operacao"],
      properties: {
        produto: {
          type: "object",
          additionalProperties: false,
          required: ["ncm", "descricao_fiscal", "cest", "cest_obrigatorio", "unidade", "ex_tipi", "caracteristicas"],
          properties: {
            ncm: { type: "string" },
            descricao_fiscal: { type: "string" },
            cest: { type: "string" },
            cest_obrigatorio: { type: "string", enum: ["sim", "nao", "incerto"] },
            unidade: { type: "string" },
            ex_tipi: { type: "string" },
            caracteristicas: { type: "array", items: { type: "string" } }
          }
        },
        empresa: {
          type: "object",
          additionalProperties: false,
          required: ["regime", "uf", "impacto"],
          properties: {
            regime: { type: "string" },
            uf: { type: "string" },
            impacto: { type: "string" }
          }
        },
        operacao: {
          type: "object",
          additionalProperties: false,
          required: ["tipo", "cfop_interno", "cfop_interestadual", "dependencias"],
          properties: {
            tipo: { type: "string" },
            cfop_interno: { type: "string" },
            cfop_interestadual: { type: "string" },
            dependencias: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    field_suggestions: {
      type: "object",
      additionalProperties: false,
      required: [
        "ncm",
        "ncm_description",
        "sku",
        "ean",
        "unidade",
        "cest",
        "cest_required",
        "cest_confidence",
        "cest_reason",
        "cfop_internal",
        "cfop_interstate",
        "cfop_confidence",
        "cfop_reason",
        "csosn",
        "cst_icms",
        "aliquota_icms",
        "icms_st",
        "icms_st_reason",
        "origem",
        "cst_pis",
        "aliquota_pis",
        "pis_cofins_reason",
        "cst_cofins",
        "aliquota_cofins",
        "aliquota_fcp",
        "ibs_cbs_cst",
        "cclass_trib",
        "ibs_cbs_reason",
        "ipi",
        "ipi_reason",
        "ex_tipi",
        "cbenef",
        "benefit_reason",
        "vtottrib",
        "observations"
      ],
      properties: {
        ncm: { type: "string" },
        ncm_description: { type: "string" },
        sku: { type: "string" },
        ean: { type: "string" },
        unidade: { type: "string" },
        cest: { type: "string" },
        cest_required: { type: "string", enum: ["sim", "nao", "incerto"] },
        cest_confidence: { type: "number" },
        cest_reason: { type: "string" },
        cfop_internal: { type: "string" },
        cfop_interstate: { type: "string" },
        cfop_confidence: { type: "number" },
        cfop_reason: { type: "string" },
        csosn: { type: "string" },
        cst_icms: { type: "string" },
        aliquota_icms: { type: "number" },
        icms_st: { type: "string", enum: ["sim", "nao", "incerto"] },
        icms_st_reason: { type: "string" },
        origem: { type: "string" },
        cst_pis: { type: "string" },
        aliquota_pis: { type: "number" },
        pis_cofins_reason: { type: "string" },
        cst_cofins: { type: "string" },
        aliquota_cofins: { type: "number" },
        aliquota_fcp: { type: "number" },
        ibs_cbs_cst: { type: "string" },
        cclass_trib: { type: "string" },
        ibs_cbs_reason: { type: "string" },
        ipi: { type: "string" },
        ipi_reason: { type: "string" },
        ex_tipi: { type: "string" },
        cbenef: { type: "string" },
        benefit_reason: { type: "string" },
        vtottrib: { type: "string" },
        observations: { type: "array", items: { type: "string" } }
      }
    },
    why: {
      type: "object",
      additionalProperties: false,
      required: ["identified_as", "official_basis", "evidence_summary", "discarded_alternatives", "review_recommendation"],
      properties: {
        identified_as: { type: "string" },
        official_basis: { type: "string" },
        evidence_summary: { type: "string" },
        discarded_alternatives: { type: "array", items: { type: "string" } },
        review_recommendation: { type: "string" }
      }
    }
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
    "Voce e um motor de classificacao fiscal assistida para produtos vendidos no Brasil.",
    "Trabalhe em camadas: primeiro Produto, depois Empresa, depois Operacao. Nao misture CFOP/CSOSN/CST com NCM sem explicar a dependencia.",
    "Use as consultas em search_queries. Pesquise o produto com NCM, CEST, EX TIPI/TIPI, unidade comercial, CST/CSOSN, CFOP, ICMS/ST/FCP, PIS/COFINS, IPI, IBS/CBS, cClassTrib, beneficios e reducoes fiscais.",
    "Use todos os dados enviados: base oficial/local NCM, candidatos ranqueados, contexto de empresa/operacao, tabelas fiscais locais e evidencia web quando existir. Ignore regras aprendidas antigas quando learning.enabled for false.",
    "O codigo final de NCM deve estar em ncm_policy.allowed_ncms. Nunca retorne NCM fora dessa whitelist; se nenhum candidato da whitelist for compativel, retorne ncm '00000000', status 'insufficient_info' ou 'invalid_ncm' e should_apply false.",
    "Nao invente codigos. Quando a web apontar claramente um NCM, ele so pode ser usado se o backend colocou esse codigo em ncm_policy.allowed_ncms. Quando a web indicar que nao ha CEST especifico obrigatorio, reflita isso em field_suggestions e why.",
    "Se faltar composicao, material, finalidade, funcionamento ou uso e essa informacao puder mudar o NCM, NAO CLASSIFIQUE automaticamente. Retorne smart_questions bloqueantes, status 'insufficient_info' e should_apply false.",
    "Retorne smart_questions com 2 ou 3 perguntas somente quando a resposta puder mudar NCM, CEST ou regra fiscal. Marque blocks_auto_apply true sempre que a ambiguidade impedir aplicar com 90% ou mais de confianca.",
    "Se a confianca de NCM ficar abaixo de 0.90, deixe should_apply false e status review ou uncertain. Nao feche automaticamente abaixo de 90%.",
    "Diferencie produto base de acessorio ou uso: cabo eletrico, cabo de dados e cabo de fibra optica podem ter NCM diferente; lapis escolar nao e apontador; lapis de maquiagem e cosmetico; rolo de pintura nao e reagente; racao de gatos ou cachorros e alimento para animais.",
    "Priorize frase especifica, funcao principal, composicao, material, finalidade, funcionamento e uso sobre repeticao de palavra solta.",
    "Para CEST e ICMS/ST: se existir CEST aplicavel ao NCM/produto/apresentacao, retorne o codigo e icms_st 'sim'; se a evidencia indicar que nao existe CEST obrigatorio especifico, retorne cest_required 'nao', cest 'SEM CEST OBRIGATORIO' e icms_st 'nao'.",
    "Para SKU e EAN: preserve os identificadores enviados pelo produto; nao invente EAN. Se o codigo de barras vier vazio, retorne string vazia.",
    "Para ICMS e FCP: preencha aliquota_icms e aliquota_fcp somente quando houver regra/tabela/evidencia clara para produto, UF e regime. Se depender de UF destino, beneficio estadual, ST ou consumidor final, use 0 e explique em observations/warnings.",
    "Para CFOP: use o tipo de operacao e UF enviados, mas indique baixa confianca quando depender de destinatario, finalidade, consumidor final ou operacao nao informada.",
    "Para IBS/CBS: nunca use CST 000 + cClassTrib 000001 como fallback generico. Pesquise a tabela vigente de cClassTrib/LC 214/2025 e beneficios/reducoes por NCM. Se houver reducao, aliquota zero ou cesta basica aplicavel, retorne o CST/cClassTrib especifico. Se nao houver certeza, deixe ibs_cbs_cst e cclass_trib vazios e explique.",
    "Para IPI/EX TIPI: pesquise TIPI pelo NCM; retorne aliquota IPI e EX TIPI somente quando houver evidencia. Se nao houver EX, retorne string vazia.",
    "Preencha why para o contador entender: identificado como, base oficial usada, evidencia, alternativas descartadas e recomendacao de revisao.",
    "Explique no campo reason por que aplicou ou bloqueou, citando categoria do produto e sinais dos candidatos/fontes.",
    "Retorne apenas JSON no formato do schema."
  ].join(" ");
}

function compactAiCandidate(candidate) {
  return {
    codigo: candidate.codigo,
    descricao: candidate.descricao,
    score: Number(candidate.score || 0),
    source: candidate.source || "ncm_oficial",
    hits: candidate.hits || [],
    phrase_hits: candidate.phrase_hits || [],
    curated: Boolean(candidate.curated_source),
    needs_specification: Boolean(candidate.needs_specification),
    specification_message: candidate.specification_message || null
  };
}

function compactValidatedRule(rule) {
  return {
    id: rule.id,
    descricao_base: rule.descricao_base,
    tipo_operacao: rule.tipo_operacao || "",
    ncm: rule.ncm,
    cest: rule.cest,
    csosn: rule.csosn,
    cst_icms: rule.cst_icms,
    aliquota_icms: rule.aliquota_icms,
    aliquota_pis: rule.aliquota_pis,
    aliquota_cofins: rule.aliquota_cofins,
    aliquota_fcp: rule.aliquota_fcp,
    score: rule.score,
    hits: rule.hits || []
  };
}

function compactAiBaseResults(baseResults = []) {
  return baseResults.slice(0, 8).map((base) => ({
    key: base.key,
    label: base.label,
    count: base.count,
    items: (base.items || []).slice(0, 3).map((item) => {
      const compact = {};
      for (const [key, value] of Object.entries(item)) {
        if (
          [
            "score",
            "hits",
            "codigo",
            "codigo_cest",
            "ncm",
            "descricao",
            "segmento",
            "tipo_incidencia",
            "csosn",
            "cst_icms",
            "aliquota_icms",
            "aliquota_pis",
            "aliquota_cofins",
            "aliquota_fcp"
          ].includes(key)
        ) {
          compact[key] = value;
        }
      }
      return compact;
    })
  }));
}

function compactFiscalTableRows(rows = [], fields = []) {
  return rows.slice(0, 5).map((row) => {
    const compact = {};
    for (const field of fields) compact[field] = row[field] ?? "";
    return compact;
  });
}

function compactFiscalTablesForAi(tables = {}) {
  return {
    cest: compactFiscalTableRows(tables.cest, ["codigo_cest", "ncm", "descricao", "segmento"]),
    tipi: compactFiscalTableRows(tables.tipi, ["ncm", "aliquota_ipi", "ex_tipi", "descricao", "vigencia"]),
    pis_cofins: compactFiscalTableRows(tables.pis_cofins, ["ncm", "aliquota_pis", "aliquota_cofins", "tipo_incidencia"]),
    cbenef: compactFiscalTableRows(tables.cbenef, ["uf", "codigo_beneficio", "descricao", "cst"]),
    ibs_cbs_cst: compactFiscalTableRows(tables.ibs_cbs_cst, ["codigo", "descricao"]),
    ibs_cbs_classificacao: compactFiscalTableRows(tables.ibs_cbs_classificacao, ["cclass_trib", "descricao", "cst_permitido"])
  };
}

function getNcmCatalogMetadata() {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ativo = 1 THEN 1 ELSE 0 END) AS ativos,
        MAX(data_inicio) AS ultima_data_inicio,
        MAX(source) AS source
      FROM ncm_oficial
    `
    )
    .get();
  const lastSync = db
    .prepare("SELECT created_at FROM audit_logs WHERE entity_type = 'catalog' AND action = 'sync_ncm' ORDER BY id DESC LIMIT 1")
    .get();
  return {
    source: NCM_JSON_URL,
    source_table: row?.source || "ncm_oficial",
    total_rows: Number(row?.total || 0),
    active_rows: Number(row?.ativos || 0),
    latest_start_date: row?.ultima_data_inicio || "",
    last_sync_at: lastSync?.created_at || "",
    checked_at: now()
  };
}

async function buildAiNcmContext(classification, options = {}) {
  const productText = `${classification.descricao_original || ""} ${classification.marca || ""} ${classification.categoria || ""}`.trim();
  const searchQueries = buildFiscalSearchQueries(productText);
  const currentCode = normalizeNcmCode(classification.ncm);
  const currentRow = getOfficialNcmRow(currentCode);
  const fiscal = searchFiscal(productText, OPENAI_NCM_MAX_CANDIDATES);
  const candidates = fiscal.ncm.slice(0, OPENAI_NCM_MAX_CANDIDATES).map(compactAiCandidate);
  const localCandidate = findNcmMatch({ ...classification, ncm_importado: "" }, extractTokens(productText), { useImportedNcm: false });
  const company = getCompany();
  const operation = getOperationForClassification(classification);
  const cfops = getCfopPair(operation, company);
  const bestNcm = normalizeNcmCode(localCandidate?.codigo || currentCode);
  const localFiscalTables = bestNcm && bestNcm !== "00000000" ? compactFiscalTablesForAi(getFiscalTablesForNcm(bestNcm)) : compactFiscalTablesForAi({});
  const useWeb = Boolean(options.use_web || options.useWeb);
  const web = await fetchWebEvidence(productText, localCandidate, { useWeb });
  return {
    generated_at: now(),
    official_ncm_source: NCM_JSON_URL,
    ncm_catalog: getNcmCatalogMetadata(),
    search_query: searchQueries.ncm,
    search_queries: searchQueries,
    question: String(options.question || "").trim(),
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
      categoria: classification.categoria || null
    },
    company: {
      nome: company.nome_fantasia || company.razao_social || "",
      cnpj: company.cnpj || "",
      uf: company.uf || "SP",
      municipio: company.municipio || "",
      regime_tributario: company.regime_tributario || "",
      crt: company.crt || "",
      contribuinte_icms: Boolean(company.contribuinte_icms)
    },
    operation: {
      type: operation,
      cfop_interno_default: cfops.interno,
      cfop_interestadual_default: cfops.interestadual,
      missing_context: ["destinatario", "uf_destino", "consumidor_final", "finalidade_da_operacao"]
    },
    learning: {
      enabled: AI_LEARNING_ENABLED,
      source: AI_LEARNING_ENABLED ? "validated_rules" : "disabled"
    },
    current: {
      ncm: currentCode || "00000000",
      exists_in_official: Boolean(currentRow),
      descricao: currentRow?.descricao || null
    },
    local_best: compactAiCandidate(localCandidate),
    candidates,
    validated_rules: AI_LEARNING_ENABLED ? fiscal.validated_rules.slice(0, 5).map(compactValidatedRule) : [],
    local_fiscal_tables: localFiscalTables,
    base_results: compactAiBaseResults(fiscal.base_results),
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

function shouldUseOpenAiWebSearch(context) {
  if (!OPENAI_NCM_WEB_SEARCH_ENABLED) return false;
  const status = context.web_evidence?.status;
  return Boolean(status && status !== "not_requested" && status !== "ok");
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

async function callOpenAiNcmWebSearch(context) {
  if (!shouldUseOpenAiWebSearch(context)) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_NCM_TIMEOUT_MS);
  const request = {
    model: OPENAI_NCM_MODEL,
    instructions:
      "Pesquise na web o pacote fiscal brasileiro do produto: NCM, CEST/ICMS-ST, EX TIPI/TIPI, IPI, unidade comercial quando a descricao indicar peso ou unidade, PIS/COFINS, FCP, IBS/CBS, cClassTrib, beneficios e reducoes fiscais. Use search_queries.fiscal_full e as consultas especificas. Priorize Receita Federal, Portal NF-e, Siscomex, Confaz/Convenios ICMS e tabelas fiscais confiaveis com descricao especifica. Responda curto citando codigos encontrados por campo e indicando incertezas. Nao invente codigo.",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              search_query: context.search_query,
              search_queries: context.search_queries,
              product: context.product,
              company: context.company,
              operation: context.operation,
              current: context.current,
              local_best: context.local_best,
              candidates: (context.candidates || []).slice(0, 5),
              local_fiscal_tables: context.local_fiscal_tables
            })
          }
        ]
      }
    ],
    max_output_tokens: 900,
    tools: [
      {
        type: "web_search",
        search_context_size: "low",
        user_location: {
          type: "approximate",
          country: "BR",
          timezone: "America/Sao_Paulo"
        }
      }
    ],
    tool_choice: "required",
    include: ["web_search_call.results"]
  };

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
    if (!response.ok) return [];
    return collectOpenAiWebEvidence(payload);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
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
            text: JSON.stringify(context)
          }
        ]
      }
    ],
    max_output_tokens: OPENAI_NCM_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "ncm_classification",
        strict: true,
        schema: AI_NCM_SCHEMA
      }
    }
  };

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
    const parsed = parseOpenAiJsonOutput(outputText);
    return {
      response_id: payload.id || null,
      model: payload.model || OPENAI_NCM_MODEL,
      usage: payload.usage || null,
      raw_text: outputText,
      parsed,
      parse_error: parsed ? null : "O classificador automatico respondeu sem JSON valido para o NCM."
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
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : fallback;
}

function nonGenericFiscalValue(value, genericValues = []) {
  const clean = asCleanString(value);
  if (!clean) return "";
  return genericValues.some((generic) => normalizeText(generic) === normalizeText(clean)) ? "" : clean;
}

function normalizeSimNaoIncerto(value, fallback = "incerto") {
  const text = normalizeText(value);
  if (["sim", "yes", "true", "obrigatorio", "obrigatoria"].includes(text)) return "sim";
  if (["nao", "não", "no", "false", "sem", "inexistente"].includes(text)) return "nao";
  if (text.includes("nao") || text.includes("sem cest") || text.includes("nao possui")) return "nao";
  if (text.includes("sim") || text.includes("obrig")) return "sim";
  return fallback;
}

function isNoCestSignal(value, required = "") {
  const text = normalizeText(`${value || ""} ${required || ""}`);
  return (
    required === "nao" ||
    text.includes("sem cest") ||
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

function buildDefaultProductProfile(context = {}, ai = {}) {
  const product = context.product || {};
  const profile = ai.product_profile || {};
  return {
    produto_base: asCleanString(profile.produto_base, asCleanString(ai.product_category, product.descricao || "")),
    marca: asCleanString(profile.marca, product.marca || ""),
    composicao: asCleanString(profile.composicao),
    material: asCleanString(profile.material),
    finalidade: asCleanString(profile.finalidade),
    embalagem: asCleanString(profile.embalagem),
    volume: asCleanString(profile.volume),
    unidade: asCleanString(profile.unidade, product.unidade || ""),
    funcao_principal: asCleanString(profile.funcao_principal, asCleanString(ai.product_category, product.descricao || "")),
    funcionamento: asCleanString(profile.funcionamento),
    uso: asCleanString(profile.uso),
    caracteristicas: asStringArray(profile.caracteristicas),
    missing_characteristics: asStringArray(profile.missing_characteristics)
  };
}

function buildFieldScores(ai = {}, confidence = 0) {
  const scores = ai.field_scores || {};
  return {
    ncm: clampScore(scores.ncm, confidence),
    cest: clampScore(scores.cest, 0.35),
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

function normalizeSmartQuestions(ai = {}, context = {}, confidence = 0) {
  const questions = (Array.isArray(ai.smart_questions) ? ai.smart_questions : [])
    .map((item) => ({
      field: asCleanString(item?.field, "produto"),
      question: asCleanString(item?.question),
      options: asStringArray(item?.options, 4),
      reason: asCleanString(item?.reason),
      blocks_auto_apply: Boolean(item?.blocks_auto_apply)
    }))
    .filter((item) => item.question)
    .slice(0, 3);

  if (!questions.length && confidence < OPENAI_NCM_APPLY_THRESHOLD) {
    questions.push({
      field: "produto",
      question: "Informe composicao, material, finalidade ou funcionamento do produto para aumentar a precisao fiscal.",
      options: ["Adicionar detalhes tecnicos", "Manter para revisao manual"],
      reason: "A confianca ficou abaixo de 90%.",
      blocks_auto_apply: true
    });
  }

  return questions;
}

function normalizedIncludesAny(text, terms = []) {
  const normalized = normalizeText(text);
  return terms.some((term) => normalized.includes(normalizeText(term)));
}

function addSmartQuestionOnce(questions, question) {
  if (!question?.question) return;
  const normalizedQuestion = normalizeText(question.question);
  if (questions.some((item) => normalizeText(item.question) === normalizedQuestion)) return;
  questions.push(question);
}

function buildBackendBlockingQuestions(context = {}, profile = {}, confidence = 0) {
  const productText = normalizeText(
    `${context.product?.descricao || ""} ${context.product?.marca || ""} ${context.product?.categoria || ""}`
  );
  const tokens = extractTokens(productText);
  const questions = [];
  const missing = asStringArray(profile.missing_characteristics, 8);

  if (tokens.length <= 1) {
    addSmartQuestionOnce(questions, {
      field: "produto",
      question: "Informe composicao, material, finalidade ou funcionamento do produto.",
      options: ["Adicionar detalhes tecnicos", "Manter para revisao manual"],
      reason: "Descricao muito curta para escolher uma NCM com seguranca.",
      blocks_auto_apply: true
    });
  }

  if (missing.length >= 3 && confidence < 0.93) {
    addSmartQuestionOnce(questions, {
      field: "produto",
      question: "Complete as caracteristicas fiscais faltantes do produto.",
      options: missing.slice(0, 4),
      reason: "As caracteristicas faltantes podem mudar NCM, CEST ou tratamento fiscal.",
      blocks_auto_apply: true
    });
  }

  if (
    productText.includes("cabo") &&
    (!normalizedIncludesAny(productText, ["cobre", "condutor", "condutores", "dados", "energia", "carregamento", "carregar", "fibra", "optica", "optico", "eletrico", "ethernet", "coaxial"]) ||
      (productText.includes("usb") && !normalizedIncludesAny(productText, ["cobre", "condutor", "condutores", "dados", "energia", "carregamento", "carregar", "fibra", "optica", "optico"])))
  ) {
    addSmartQuestionOnce(questions, {
      field: "produto",
      question: "O cabo possui condutores eletricos, transmite dados/energia ou e fibra optica?",
      options: ["Condutor eletrico/dados", "Fibra optica", "Outro tipo de cabo"],
      reason: "Cabos eletricos, cabos de dados e cabos de fibra optica podem cair em posicoes NCM diferentes.",
      blocks_auto_apply: true
    });
  }

  if (productText.includes("lapis") && !normalizedIncludesAny(productText, ["grafite", "escolar", "cor", "colorido", "maquiagem", "olho", "sobrancelha", "carpinteiro", "mecanico"])) {
    addSmartQuestionOnce(questions, {
      field: "produto",
      question: "O lapis e escolar/grafite, de cor, maquiagem ou uso tecnico?",
      options: ["Escolar/grafite", "De cor", "Maquiagem/uso cosmetico", "Uso tecnico"],
      reason: "A palavra lapis sozinha pode representar mercadorias fiscais diferentes.",
      blocks_auto_apply: true
    });
  }

  if (normalizedIncludesAny(productText, ["queijo", "queijos"]) && !normalizedIncludesAny(productText, ["minas", "frescal", "mussarela", "mozarela", "prato", "parmesao", "ralado", "requeijao", "coalho", "gorgonzola"])) {
    addSmartQuestionOnce(questions, {
      field: "produto",
      question: "Qual e o tipo do queijo?",
      options: ["Minas frescal", "Mussarela", "Prato/parmesao", "Outro queijo"],
      reason: "O tipo do queijo pode alterar o enquadramento dentro da posicao 0406.",
      blocks_auto_apply: true
    });
  }

  if (normalizedIncludesAny(productText, ["racao", "ração"]) && !normalizedIncludesAny(productText, ["gato", "gatos", "cao", "caes", "cachorro", "cachorros", "ave", "aves", "peixe", "peixes"])) {
    addSmartQuestionOnce(questions, {
      field: "produto",
      question: "A racao e destinada a qual animal?",
      options: ["Gatos", "Caes", "Aves/peixes", "Outro animal"],
      reason: "A especie de destino ajuda a validar NCM e possivel CEST.",
      blocks_auto_apply: true
    });
  }

  if (
    normalizedIncludesAny(productText, ["oculos de realidade virtual", "realidade virtual", "vr"]) &&
    !normalizedIncludesAny(productText, ["autonomo", "all in one", "console", "computador", "smartphone", "periferico", "jogos"])
  ) {
    addSmartQuestionOnce(questions, {
      field: "produto",
      question: "O oculos VR e autonomo, periferico de computador/console ou depende de smartphone?",
      options: ["Autonomo", "Periferico de computador/console", "Depende de smartphone"],
      reason: "O funcionamento do equipamento pode mudar o enquadramento fiscal.",
      blocks_auto_apply: true
    });
  }

  return questions.slice(0, 3);
}

function mergeSmartQuestions(primary = [], secondary = []) {
  const merged = [...primary];
  for (const question of secondary) addSmartQuestionOnce(merged, question);
  return merged.slice(0, 3);
}

function specificationOptionId(label) {
  return normalizeText(label)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function cleanProductBaseDescription(value) {
  const text = String(value || "").trim();
  return text.replace(/^\s*\d+\s*[\-.)]\s*/, "").trim() || text;
}

function addSpecificationOption(options, label, baseDescription, details = {}) {
  const cleanLabel = asCleanString(label);
  if (!cleanLabel) return;
  if (options.some((item) => normalizeText(item.label) === normalizeText(cleanLabel))) return;
  const ncmHint = normalizeNcmCode(details.ncm_hint);
  options.push({
    id: details.id || specificationOptionId(cleanLabel),
    label: cleanLabel,
    description: asCleanString(details.description),
    refined_description: asCleanString(details.refined_description, cleanLabel),
    append_text: asCleanString(details.append_text, cleanLabel),
    ncm_hint: ncmHint && getOfficialNcmRow(ncmHint) ? ncmHint : "",
    confidence_hint: clampScore(details.confidence_hint, 0.55)
  });
}

function addDetailQuestion(detailQuestions, question) {
  if (!question?.field || !question?.label) return;
  if (detailQuestions.some((item) => item.field === question.field)) return;
  detailQuestions.push({
    field: question.field,
    label: question.label,
    options: asStringArray(question.options, 8),
    required_for: asCleanString(question.required_for, "descricao fiscal"),
    blocks_auto_apply: Boolean(question.blocks_auto_apply)
  });
}

function buildSpecificationMenu(context = {}, profile = {}, questions = []) {
  const baseDescription = cleanProductBaseDescription(context.product?.descricao || profile.produto_base || "");
  const productText = normalizeText(`${baseDescription} ${context.product?.marca || ""} ${context.product?.categoria || ""}`);
  const productOptions = [];
  const detailQuestions = [];

  if (normalizedIncludesAny(productText, ["arroz"])) {
    addSpecificationOption(productOptions, "Arroz tipo 1", baseDescription, {
      description: "Arroz beneficiado comum para venda ao consumidor.",
      ncm_hint: "10063021",
      confidence_hint: 0.82
    });
    addSpecificationOption(productOptions, "Arroz parboilizado", baseDescription, {
      description: "Arroz submetido ao processo de parboilizacao.",
      ncm_hint: "10063021",
      confidence_hint: 0.78
    });
    addSpecificationOption(productOptions, "Arroz integral", baseDescription, {
      description: "Arroz descascado/integral, quando essa for a caracteristica real.",
      ncm_hint: "10062020",
      confidence_hint: 0.72
    });
    addSpecificationOption(productOptions, "Arroz arboreo para risoto", baseDescription, {
      description: "Arroz especial para preparo de risoto.",
      ncm_hint: "10063021",
      confidence_hint: 0.7
    });
    addDetailQuestion(detailQuestions, {
      field: "peso_embalagem",
      label: "Peso/embalagem",
      options: ["1 kg", "2 kg", "5 kg", "Fardo 5 kg", "Fardo 30 kg"],
      required_for: "descricao e unidade",
      blocks_auto_apply: false
    });
  }

  if (productText.includes("cabo")) {
    addSpecificationOption(productOptions, "Cabo USB de cobre para dados e energia", baseDescription, {
      description: "Cabo com condutores eletricos e conectores para transmissao de dados/energia.",
      confidence_hint: 0.8
    });
    addSpecificationOption(productOptions, "Cabo eletrico com condutores", baseDescription, {
      description: "Condutor eletrico isolado, sem ser fibra optica.",
      confidence_hint: 0.76
    });
    addSpecificationOption(productOptions, "Cabo de fibra optica", baseDescription, {
      description: "Cabo composto por fibra optica para transmissao luminosa.",
      confidence_hint: 0.76
    });
    addSpecificationOption(productOptions, "Cabo coaxial", baseDescription, {
      description: "Cabo coaxial para sinal/comunicacao.",
      confidence_hint: 0.68
    });
    addDetailQuestion(detailQuestions, {
      field: "comprimento",
      label: "Comprimento",
      options: ["1 m", "2 m", "3 m", "5 m"],
      required_for: "descricao comercial",
      blocks_auto_apply: false
    });
  }

  if (productText.includes("lapis")) {
    addSpecificationOption(productOptions, "Lapis grafite escolar", baseDescription, {
      description: "Lapis para escrita/desenho com mina de grafite.",
      ncm_hint: "96091000",
      confidence_hint: 0.82
    });
    addSpecificationOption(productOptions, "Lapis de cor escolar", baseDescription, {
      description: "Lapis colorido para uso escolar ou artistico.",
      ncm_hint: "96091000",
      confidence_hint: 0.8
    });
    addSpecificationOption(productOptions, "Lapis de maquiagem para olhos", baseDescription, {
      description: "Produto cosmetico para maquiagem.",
      confidence_hint: 0.72
    });
    addDetailQuestion(detailQuestions, {
      field: "apresentacao",
      label: "Apresentacao",
      options: ["Unidade", "Caixa com 12", "Caixa com 24"],
      required_for: "descricao comercial",
      blocks_auto_apply: false
    });
  }

  if (normalizedIncludesAny(productText, ["queijo", "queijos"])) {
    addSpecificationOption(productOptions, "Queijo Minas frescal", baseDescription, {
      description: "Queijo fresco tipo Minas frescal.",
      ncm_hint: "04061090",
      confidence_hint: 0.84
    });
    addSpecificationOption(productOptions, "Queijo mussarela", baseDescription, {
      description: "Mozarela/mussarela.",
      ncm_hint: "04061010",
      confidence_hint: 0.82
    });
    addSpecificationOption(productOptions, "Queijo parmesao ralado", baseDescription, {
      description: "Queijo duro/ralado, quando essa for a apresentacao real.",
      confidence_hint: 0.72
    });
    addSpecificationOption(productOptions, "Outros queijos", baseDescription, {
      description: "Categoria generica quando o tipo nao for identificado.",
      ncm_hint: "04069090",
      confidence_hint: 0.62
    });
    addDetailQuestion(detailQuestions, {
      field: "apresentacao",
      label: "Apresentacao",
      options: ["Peca", "Fatiado", "Ralado", "500 g", "1 kg"],
      required_for: "descricao e CEST",
      blocks_auto_apply: false
    });
  }

  if (normalizedIncludesAny(productText, ["racao", "ração"])) {
    addSpecificationOption(productOptions, "Racao para gatos", baseDescription, {
      description: "Alimento preparado para gatos.",
      ncm_hint: "23091000",
      confidence_hint: 0.82
    });
    addSpecificationOption(productOptions, "Racao para caes", baseDescription, {
      description: "Alimento preparado para caes.",
      ncm_hint: "23091000",
      confidence_hint: 0.82
    });
    addSpecificationOption(productOptions, "Racao para aves", baseDescription, {
      description: "Alimento/preparacao para aves.",
      confidence_hint: 0.68
    });
    addDetailQuestion(detailQuestions, {
      field: "peso_embalagem",
      label: "Peso/embalagem",
      options: ["1 kg", "3 kg", "10 kg", "15 kg", "20 kg"],
      required_for: "descricao e CEST",
      blocks_auto_apply: false
    });
  }

  if (normalizedIncludesAny(productText, ["realidade virtual", "oculos vr", "vr"])) {
    addSpecificationOption(productOptions, "Oculos VR autonomo para jogos", baseDescription, {
      description: "Equipamento independente, proprio para jogos/conteudo.",
      confidence_hint: 0.72
    });
    addSpecificationOption(productOptions, "Oculos VR periferico de computador ou console", baseDescription, {
      description: "Dispositivo dependente de computador ou console.",
      confidence_hint: 0.68
    });
    addSpecificationOption(productOptions, "Oculos VR para smartphone", baseDescription, {
      description: "Suporte/visualizador dependente de smartphone.",
      confidence_hint: 0.62
    });
  }

  for (const question of questions) {
    for (const option of asStringArray(question.options, 4)) {
      if (normalizedIncludesAny(option, ["revisao manual", "manter para revisao", "adicionar detalhes"])) continue;
      addSpecificationOption(productOptions, option, baseDescription, {
        description: question.reason || "",
        confidence_hint: question.blocks_auto_apply ? 0.6 : 0.7
      });
    }
  }

  const officialCandidates = (context.ncm_policy?.allowed_ncms || [])
    .slice(0, 8)
    .map((item) => ({
      ncm: item.codigo,
      descricao: item.descricao,
      sources: item.sources || [],
      evidence_count: item.evidence_count || 0
    }));

  return {
    visible: Boolean(productOptions.length || detailQuestions.length || officialCandidates.length),
    title: "Especificar produto",
    description:
      "Escolha a alternativa que melhor descreve o produto e complete os detalhes comerciais quando fizer sentido.",
    base_description: baseDescription,
    product_options: productOptions.slice(0, 8),
    detail_questions: detailQuestions.slice(0, 3),
    official_candidates: officialCandidates
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
  const suggestion = ai.field_suggestions || {};
  const trustedCode = normalizeNcmCode(code);
  const tables = trustedCode && trustedCode !== "00000000" ? getFiscalTablesForNcm(trustedCode) : getFiscalTablesForNcm("");
  const localCest = tables.cest?.[0]?.codigo_cest || "";
  const webCest = getCestsFromWebEvidence(context.web_evidence)[0]?.codigo || "";
  const webNoCest = webEvidenceSaysNoCest(context.web_evidence);
  const rawCestRequired = normalizeSimNaoIncerto(suggestion.cest_required, webNoCest ? "nao" : webCest || localCest ? "sim" : "incerto");
  const cestRequired = isNoCestSignal(suggestion.cest, rawCestRequired) ? "nao" : rawCestRequired;
  const cest = normalizeCestSuggestion(suggestion.cest || webCest || localCest, cestRequired);
  const icmsSt = normalizeSimNaoIncerto(
    suggestion.icms_st,
    cestRequired === "nao" ? "nao" : cest || localCest || webCest ? "sim" : "incerto"
  );
  const cfopInternal = asCleanString(suggestion.cfop_internal, context.operation?.cfop_interno_default || "");
  const cfopInterstate = asCleanString(suggestion.cfop_interstate, context.operation?.cfop_interestadual_default || "");
  const pisCofins = trustedCode && trustedCode !== "00000000" ? getPisCofins(trustedCode) : getPisCofins("00000000");
  const tipiRow = tables.tipi?.[0] || null;

  return {
    ncm: trustedCode && trustedCode !== "00000000" ? trustedCode : "00000000",
    ncm_description: asCleanString(suggestion.ncm_description, description),
    sku: asCleanString(suggestion.sku, context.product?.codigo_produto || ""),
    ean: asCleanString(suggestion.ean, context.product?.codigo_barras || ""),
    unidade: asCleanString(suggestion.unidade, context.product?.unidade || ""),
    cest: cestRequired === "nao" ? "SEM CEST OBRIGATORIO" : cest,
    cest_required: cestRequired,
    cest_confidence: clampScore(suggestion.cest_confidence, webCest ? 0.82 : localCest ? 0.72 : webNoCest ? 0.78 : 0.35),
    cest_reason: asCleanString(
      suggestion.cest_reason,
      cestRequired === "nao"
        ? "Pesquisa/evidencia nao indicou CEST obrigatorio especifico."
        : localCest
          ? "CEST encontrado em tabela local pelo NCM."
          : "CEST depende de tabela por segmento/mercadoria e precisa de revisao."
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
    origem: asCleanString(suggestion.origem, "0"),
    cst_pis: asCleanString(suggestion.cst_pis, getPisCofinsCst(pisCofins)),
    aliquota_pis: numberOrFallback(suggestion.aliquota_pis, Number(pisCofins?.aliquota_pis ?? 1.65)),
    pis_cofins_reason: asCleanString(
      suggestion.pis_cofins_reason,
      pisCofins?.tipo_incidencia ? `Regra PIS/COFINS local por NCM: ${pisCofins.tipo_incidencia}.` : "PIS/COFINS precisa de validacao por NCM/regime."
    ),
    cst_cofins: asCleanString(suggestion.cst_cofins, getPisCofinsCst(pisCofins)),
    aliquota_cofins: numberOrFallback(suggestion.aliquota_cofins, Number(pisCofins?.aliquota_cofins ?? 7.6)),
    aliquota_fcp: numberOrFallback(suggestion.aliquota_fcp, null),
    ibs_cbs_cst: nonGenericFiscalValue(suggestion.ibs_cbs_cst, ["000"]),
    cclass_trib: nonGenericFiscalValue(suggestion.cclass_trib, ["000001"]),
    ibs_cbs_reason: asCleanString(
      suggestion.ibs_cbs_reason,
      "IBS/CBS deve ser cruzado com NCM, LC 214/2025, reducoes, aliquota zero e cClassTrib vigente."
    ),
    ipi: asCleanString(suggestion.ipi, tipiRow?.aliquota_ipi ?? ""),
    ipi_reason: asCleanString(
      suggestion.ipi_reason,
      tipiRow ? "IPI encontrado em tabela TIPI local pelo NCM." : "IPI/EX TIPI precisa de consulta TIPI por NCM."
    ),
    ex_tipi: asCleanString(suggestion.ex_tipi, tipiRow?.ex_tipi || ""),
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
      uf: asCleanString(layers.empresa?.uf, context.company?.uf || ""),
      impacto: asCleanString(layers.empresa?.impacto, "Regime, UF e contribuinte ICMS afetam CST/CSOSN, beneficios e regras estaduais.")
    },
    operacao: {
      tipo: asCleanString(layers.operacao?.tipo, context.operation?.type || ""),
      cfop_interno: asCleanString(layers.operacao?.cfop_interno, fieldSuggestions.cfop_internal || ""),
      cfop_interestadual: asCleanString(layers.operacao?.cfop_interestadual, fieldSuggestions.cfop_interstate || ""),
      dependencias: asStringArray(layers.operacao?.dependencias, 6)
    }
  };
}

function buildWhy(ai = {}, context = {}, code = "", description = "", questions = []) {
  const why = ai.why || {};
  const alternatives = asStringArray(why.discarded_alternatives, 6);
  if (!alternatives.length) {
    for (const candidate of (context.candidates || []).slice(0, 4)) {
      const candidateCode = normalizeNcmCode(candidate?.codigo);
      if (candidateCode && candidateCode !== code) alternatives.push(`${candidateCode} - ${candidate.descricao || "alternativa descartada"}`);
    }
  }
  return {
    identified_as: asCleanString(why.identified_as, asCleanString(ai.product_category, context.product?.descricao || "")),
    official_basis: asCleanString(why.official_basis, description ? `NCM oficial: ${description}` : "Base oficial/local NCM e evidencia web consultadas."),
    evidence_summary: asCleanString(why.evidence_summary, asCleanString(ai.reason, "Classificacao feita por candidatos oficiais, regras locais e pesquisa web.")),
    discarded_alternatives: alternatives.slice(0, 6),
    review_recommendation: asCleanString(
      why.review_recommendation,
      questions.some((item) => item.blocks_auto_apply)
        ? "Responder as perguntas antes de aprovar."
        : "Revisar antes da primeira utilizacao fiscal."
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

function addAllowedNcm(allowed, code, source, evidenceCount = 0) {
  const cleanCode = normalizeNcmCode(code);
  if (!cleanCode || cleanCode.length !== 8 || cleanCode === "00000000") return;
  const row = getOfficialNcmRow(cleanCode);
  if (!row) return;
  const existing = allowed.get(cleanCode) || {
    codigo: cleanCode,
    descricao: row.descricao || "",
    sources: [],
    evidence_count: 0
  };
  if (source && !existing.sources.includes(source)) existing.sources.push(source);
  existing.evidence_count = Math.max(existing.evidence_count, Number(evidenceCount || 0));
  allowed.set(cleanCode, existing);
}

function buildNcmDecisionPolicy(context = {}) {
  const allowed = new Map();
  addAllowedNcm(allowed, context.local_best?.codigo, "local_best");

  for (const candidate of context.candidates || []) {
    addAllowedNcm(allowed, candidate?.codigo, "candidate");
  }

  if (context.learning?.enabled) {
    for (const rule of context.validated_rules || []) {
      addAllowedNcm(allowed, rule?.ncm, "validated_rule");
    }
  }

  const currentCode = normalizeNcmCode(context.current?.ncm);
  if (context.current?.exists_in_official) addAllowedNcm(allowed, currentCode, "current");

  for (const webCode of getOfficialNcmsFromWebEvidence(context.web_evidence)) {
    addAllowedNcm(allowed, webCode.codigo, "web_evidence", webCode.count);
  }

  return {
    source: NCM_JSON_URL,
    table_version: context.ncm_catalog?.latest_start_date || "",
    apply_threshold: OPENAI_NCM_APPLY_THRESHOLD,
    rule: "O NCM final deve existir na tabela oficial vigente e estar em allowed_ncms. Se faltar informacao do produto, retorne status insufficient_info e should_apply false.",
    allowed_ncms: [...allowed.values()].slice(0, 18)
  };
}

function attachNcmDecisionPolicy(context = {}) {
  return {
    ...context,
    ncm_policy: buildNcmDecisionPolicy(context)
  };
}

function findAllowedNcmPolicyEntry(context = {}, code = "") {
  const cleanCode = normalizeNcmCode(code);
  const allowed = context.ncm_policy?.allowed_ncms || buildNcmDecisionPolicy(context).allowed_ncms;
  return allowed.find((item) => normalizeNcmCode(item.codigo) === cleanCode) || null;
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

function buildAiWarnings(ai, context, code) {
  const warnings = Array.isArray(ai?.warnings) ? ai.warnings.map((item) => String(item)).filter(Boolean) : [];
  const genericCandidate = [context.local_best, ...(context.candidates || [])].find(
    (candidate) => normalizeNcmCode(candidate?.codigo) === code && candidate?.needs_specification
  );
  if (genericCandidate) {
    const message =
      genericCandidate.specification_message ||
      "Produto pouco especificado; NCM aplicado pela categoria generica mais proxima.";
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
  }
  return warnings.slice(0, 6);
}

function officialCodeFromCandidate(candidate) {
  const code = normalizeNcmCode(candidate?.codigo);
  return code && code !== "00000000" && getOfficialNcmRow(code) ? code : null;
}

function pickFallbackNcmCode(context, rawText = "") {
  for (const code of extractNcmCodesFromText(rawText)) {
    if (findAllowedNcmPolicyEntry(context, code)) return { code, source: "openai_text" };
  }

  const webCode = pickWebEvidenceNcm(context.web_evidence, null) || getNcmsFromWebEvidence(context.web_evidence)[0];
  if (webCode?.codigo && findAllowedNcmPolicyEntry(context, webCode.codigo)) return { code: webCode.codigo, source: "web_evidence" };

  const localBest = officialCodeFromCandidate(context.local_best);
  if (localBest && findAllowedNcmPolicyEntry(context, localBest)) return { code: localBest, source: "local_best" };

  const candidate = (context.candidates || []).find((item) => officialCodeFromCandidate(item));
  const candidateCode = officialCodeFromCandidate(candidate);
  if (candidateCode && findAllowedNcmPolicyEntry(context, candidateCode)) return { code: candidateCode, source: "candidate" };

  return { code: "00000000", source: "none" };
}

function buildFallbackAiNcmResult(context, rawText = "", parseError = null) {
  const picked = pickFallbackNcmCode(context, rawText);
  const code = picked.code;
  const row = getOfficialNcmRow(code);
  const hasNcm = code && code !== "00000000";
  const confidence = hasNcm ? 0.65 : 0.2;
  const base = {
    ncm: hasNcm ? code : "00000000",
    confidence,
    status: hasNcm ? "review" : "uncertain",
    should_apply: false,
    needs_review: true,
    product_category: context.product?.descricao || "",
    reason: hasNcm
      ? `Classificador automatico nao retornou JSON valido; NCM sugerido por fallback usando ${picked.source}, sem aplicacao automatica.`
      : `Classificador automatico nao retornou JSON valido e nenhum NCM oficial seguro foi encontrado. ${parseError || ""}`.trim(),
    warnings: [
      parseError || "Classificador automatico respondeu fora do JSON esperado.",
      hasNcm ? "Fallback tecnico nao aplica automaticamente; contador deve conferir a classificacao." : "Revisar manualmente."
    ],
    sources: hasNcm
      ? [
          {
            type: picked.source,
            code,
            description: row?.descricao || "NCM encontrado em evidencia externa",
            url: picked.source === "web_evidence" ? "" : context.official_ncm_source || NCM_JSON_URL,
            confidence: 0.75
          }
        ]
      : []
  };
  const productProfile = buildDefaultProductProfile(context, base);
  const fieldSuggestions = buildFieldSuggestions(base, context, base.ncm, row?.descricao || "", confidence);
  const smartQuestions = mergeSmartQuestions(
    normalizeSmartQuestions(base, context, confidence),
    buildBackendBlockingQuestions(context, productProfile, confidence)
  );
  return {
    ...base,
    product_profile: productProfile,
    field_scores: buildFieldScores(base, confidence),
    smart_questions: smartQuestions,
    specification_menu: buildSpecificationMenu(context, productProfile, smartQuestions),
    fiscal_layers: buildFiscalLayers(base, context, fieldSuggestions, productProfile),
    field_suggestions: fieldSuggestions,
    why: buildWhy(base, context, base.ncm, row?.descricao || "", smartQuestions)
  };
}

function normalizeAiNcmResult(ai, context) {
  const aiNcm = normalizeNcmCode(ai?.ncm);
  const aiReturnedNcm = aiNcm && aiNcm !== "00000000" ? aiNcm : "";
  const aiOfficial = aiReturnedNcm ? getOfficialNcmRow(aiReturnedNcm) : null;
  const aiPolicyEntry = aiReturnedNcm ? findAllowedNcmPolicyEntry(context, aiReturnedNcm) : null;
  const webEvidenceNcm = aiPolicyEntry
    ? pickWebEvidenceNcm(context.web_evidence, aiReturnedNcm)
    : pickWebEvidenceNcm(context.web_evidence, null);
  const webPolicyEntry = webEvidenceNcm?.codigo ? findAllowedNcmPolicyEntry(context, webEvidenceNcm.codigo) : null;
  const cleanNcm = aiPolicyEntry ? aiReturnedNcm : !aiReturnedNcm && webPolicyEntry ? webEvidenceNcm.codigo : aiReturnedNcm;
  const official = getOfficialNcmRow(cleanNcm);
  const policyEntry = cleanNcm ? findAllowedNcmPolicyEntry(context, cleanNcm) : null;
  const sourceList = policyEntry?.sources || [];
  const validNcm = Boolean(cleanNcm && cleanNcm.length === 8 && cleanNcm !== "00000000" && official);
  const whitelistAllowed = Boolean(policyEntry);
  const fromCandidates = sourceList.some((source) => ["candidate", "local_best", "current", "validated_rule"].includes(source));
  const fromWebEvidence = sourceList.includes("web_evidence") || webEvidenceSupportsNcm(context.web_evidence, cleanNcm);
  const fromAiSources = aiSourcesSupportNcm(ai?.sources || [], cleanNcm);
  const researchedNcm = Boolean(validNcm && whitelistAllowed);
  const hasBackendCandidates = (context.ncm_policy?.allowed_ncms || []).some((item) =>
    (item.sources || []).some((source) => ["candidate", "local_best", "current", "validated_rule"].includes(source))
  );
  const webOnlyNcm = Boolean(sourceList.includes("web_evidence") && !fromCandidates);
  const autoApplySourceAllowed = Boolean(fromCandidates || (webOnlyNcm && !hasBackendCandidates && Number(policyEntry?.evidence_count || 0) >= 2));
  const invalidReturnedNcm = Boolean(aiReturnedNcm && (!aiOfficial || !aiPolicyEntry));
  const confidence = clampConfidence(ai?.confidence);
  const sourceDescription = aiSourceDescription(ai?.sources || [], cleanNcm);
  const productProfile = buildDefaultProductProfile(context, ai);
  let smartQuestions = mergeSmartQuestions(
    normalizeSmartQuestions(ai, context, confidence),
    buildBackendBlockingQuestions(context, productProfile, confidence)
  );
  const blocksAutoApply = smartQuestions.some((item) => item.blocks_auto_apply);
  const insufficientInfo = Boolean(
    blocksAutoApply ||
      normalizeText(ai?.status).includes("insufficient") ||
      (productProfile.missing_characteristics.length >= 3 && confidence < 0.93)
  );
  const outputNcm = researchedNcm ? cleanNcm : "00000000";
  const description = official?.descricao || sourceDescription || webEvidenceNcm?.row?.descricao || "NCM nao validado na whitelist oficial";
  const warnings = buildAiWarnings(ai, context, cleanNcm);
  if (invalidReturnedNcm) {
    const message = aiOfficial
      ? `NCM ${aiReturnedNcm} existe na tabela oficial, mas nao estava entre os candidatos permitidos para este produto.`
      : `NCM ${aiReturnedNcm} nao existe na tabela oficial vigente e foi bloqueado.`;
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
  }
  if (!researchedNcm && cleanNcm) {
    const message = `NCM ${cleanNcm} nao passou pela whitelist oficial/candidatos da pesquisa.`;
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
  }
  if (researchedNcm && !autoApplySourceAllowed) {
    const message = `NCM ${cleanNcm} veio apenas como evidencia externa e precisa de revisao contra os candidatos oficiais.`;
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
  }
  if (insufficientInfo) {
    const message = "Informacoes insuficientes para aplicar automaticamente com seguranca.";
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
  }
  const fieldSuggestions = buildFieldSuggestions(ai, context, outputNcm || "00000000", researchedNcm ? description : "", confidence);
  const fieldScores = buildFieldScores(ai, confidence);
  const safeToApply = Boolean(researchedNcm && autoApplySourceAllowed && confidence >= OPENAI_NCM_APPLY_THRESHOLD && !insufficientInfo);
  const normalizedAiStatus = ["apply", "review", "uncertain", "insufficient_info", "invalid_ncm"].includes(ai?.status)
    ? ai.status
    : "uncertain";
  const status = safeToApply
    ? "apply"
    : invalidReturnedNcm || (cleanNcm && !researchedNcm)
      ? "invalid_ncm"
      : insufficientInfo
        ? "insufficient_info"
        : researchedNcm
          ? "review"
          : normalizedAiStatus;
  return {
    ncm: outputNcm,
    formatted: formatNcm(outputNcm),
    descricao: researchedNcm ? description : "NCM nao aplicado",
    confidence,
    status,
    should_apply: safeToApply,
    needs_review: !safeToApply,
    product_category: String(ai?.product_category || ""),
    reason: String(ai?.reason || ""),
    warnings: warnings.slice(0, 6),
    sources: normalizeSources(ai?.sources || [], outputNcm, context),
    product_profile: productProfile,
    field_scores: fieldScores,
    smart_questions: smartQuestions,
    specification_menu: buildSpecificationMenu(context, productProfile, smartQuestions),
    fiscal_layers: buildFiscalLayers(ai, context, fieldSuggestions, productProfile),
    field_suggestions: fieldSuggestions,
    why: buildWhy(ai, context, outputNcm, researchedNcm ? description : "", smartQuestions),
    eligible_to_apply: safeToApply,
    validation: {
      exists_in_official: Boolean(official),
      whitelist_allowed: whitelistAllowed,
      from_candidates: fromCandidates,
      from_web_evidence: fromWebEvidence,
      from_ai_sources: fromAiSources,
      web_evidence_ncm: webEvidenceNcm?.codigo || null,
      web_evidence_ncm_count: policyEntry?.evidence_count || webEvidenceNcm?.count || 0,
      threshold: OPENAI_NCM_APPLY_THRESHOLD,
      blocks_auto_apply: blocksAutoApply,
      insufficient_info: insufficientInfo,
      researched_ncm: researchedNcm,
      auto_apply_source_allowed: autoApplySourceAllowed,
      returned_ncm: aiReturnedNcm || null,
      selected_ncm: outputNcm !== "00000000" ? outputNcm : null,
      rejected_ncm: outputNcm === "00000000" && cleanNcm ? cleanNcm : null,
      allowed_ncms: (context.ncm_policy?.allowed_ncms || []).map((item) => item.codigo)
    }
  };
}

async function buildAiNcmSuggestion(classification, options = {}) {
  const context = await buildAiNcmContext(classification, options);
  const openAiWebEvidence = await callOpenAiNcmWebSearch(context);
  const enrichedContext = attachNcmDecisionPolicy(mergeOpenAiWebEvidence(context, openAiWebEvidence));
  const response = await callOpenAiNcm(enrichedContext);
  const parsed = response.parsed || buildFallbackAiNcmResult(enrichedContext, response.raw_text, response.parse_error);
  const result = normalizeAiNcmResult(parsed, enrichedContext);
  return {
    checked_at: now(),
    provider: "openai",
    model: response.model,
    response_id: response.response_id,
    usage: response.usage,
    parse_error: response.parse_error,
    context: enrichedContext,
    result,
    billing: options.billing || null,
    message: result.eligible_to_apply
      ? `Classificador automatico aplicou ${result.ncm} com ${Math.round(result.confidence * 100)}% de confianca.`
      : `Classificador automatico deixou para revisao: ${result.reason || "sem confianca suficiente."}`,
    policy: "O backend aplica automaticamente quando o NCM existe na tabela oficial/local e foi sustentado por candidato ou evidencia web permitida, sem aprendizado automatico por padrao."
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

function isGenericIbsCbsPair(cst, cclass) {
  return asCleanString(cst) === "000" && asCleanString(cclass) === "000001";
}

function trustedPreviousIbsCbsValue(previous, field) {
  const cst = asCleanString(previous?.ibs_cbs_cst);
  const cclass = asCleanString(previous?.cclass_trib);
  if (!cst || !cclass || isGenericIbsCbsPair(cst, cclass)) return "";
  return asCleanString(previous?.[field]);
}

function resolveIbsCbsPatch(previous, suggested = {}) {
  const suggestedCst = asCleanString(suggested.ibs_cbs_cst);
  const suggestedClass = asCleanString(suggested.cclass_trib);
  if (suggestedCst && suggestedClass && !isGenericIbsCbsPair(suggestedCst, suggestedClass)) {
    return { ibs_cbs_cst: suggestedCst, cclass_trib: suggestedClass };
  }
  return {
    ibs_cbs_cst: trustedPreviousIbsCbsValue(previous, "ibs_cbs_cst") || null,
    cclass_trib: trustedPreviousIbsCbsValue(previous, "cclass_trib") || null
  };
}

function buildFiscalPatchFromNcm(previous, ncm, aiResult = null) {
  const company = getCompany();
  const operation = getOperationForClassification(previous);
  const cfops = getCfopPair(operation, company);
  const tables = getFiscalTablesForNcm(ncm);
  const pisCofins = getPisCofins(ncm);
  const pisCofinsCst = getPisCofinsCst(pisCofins);
  const cbenef = pickFiscalBenefit(tables, company);
  const simples = company.regime_tributario === "simples_nacional" || company.crt === "1" || company.crt === "4";
  const cstIcms = cbenef?.cst || previous.cst_icms || "00";
  const suggested = aiResult?.field_suggestions || {};
  const ibsCbsPatch = resolveIbsCbsPatch(previous, suggested);
  const suggestedCest = normalizeCestSuggestion(suggested.cest, suggested.cest_required);
  const noCestRequired = isNoCestSignal(suggestedCest, suggested.cest_required);
  const finalCest = noCestRequired
    ? "SEM CEST OBRIGATORIO"
    : suggestedCest || tables.cest?.[0]?.codigo_cest || previous.cest;
  const finalIcmsSt = normalizeSimNaoIncerto(
    suggested.icms_st,
    noCestRequired ? "nao" : finalCest && finalCest !== "SEM CEST OBRIGATORIO" ? "sim" : previous.icms_st || "incerto"
  );
  const finalCfopInterno = asCleanString(suggested.cfop_internal, cfops.interno);
  const finalCfopInterestadual = asCleanString(suggested.cfop_interstate, cfops.interestadual);
  const finalPis = asCleanString(suggested.cst_pis, pisCofinsCst);
  const finalCofins = asCleanString(suggested.cst_cofins, pisCofinsCst);
  const suggestedCsosn = asCleanString(suggested.csosn);
  const suggestedCstIcms = asCleanString(suggested.cst_icms);
  const finalCsosn = simples
    ? suggestedCsosn || (String(cstIcms) === "60" || (tables.cest?.length && !noCestRequired) ? "500" : previous.csosn || "102")
    : null;

  return {
    unidade: asCleanString(suggested.unidade, previous.unidade || null),
    sku: asCleanString(suggested.sku, previous.sku || previous.codigo_produto || null),
    ean: asCleanString(suggested.ean, previous.ean || previous.codigo_barras || null),
    ncm,
    cest: finalCest,
    cfop_interno: finalCfopInterno,
    cfop_interestadual: finalCfopInterestadual,
    cst_icms: simples ? null : suggestedCstIcms || cstIcms,
    aliquota_icms: numberOrFallback(suggested.aliquota_icms, previous.aliquota_icms),
    icms_st: finalIcmsSt,
    csosn: finalCsosn,
    origem: asCleanString(suggested.origem, previous.origem || "0"),
    cst_pis: finalPis,
    aliquota_pis: numberOrFallback(suggested.aliquota_pis, pisCofins?.aliquota_pis ?? previous.aliquota_pis),
    cst_cofins: finalCofins,
    aliquota_cofins: numberOrFallback(suggested.aliquota_cofins, pisCofins?.aliquota_cofins ?? previous.aliquota_cofins),
    aliquota_fcp: numberOrFallback(suggested.aliquota_fcp, previous.aliquota_fcp),
    ibs_cbs_cst: ibsCbsPatch.ibs_cbs_cst,
    cclass_trib: ibsCbsPatch.cclass_trib,
    ipi: asCleanString(suggested.ipi, tables.tipi?.[0]?.aliquota_ipi ?? previous.ipi),
    ex_tipi: asCleanString(suggested.ex_tipi, tables.tipi?.[0]?.ex_tipi || previous.ex_tipi),
    cbenef: asCleanString(suggested.cbenef, cbenef?.codigo_beneficio || previous.cbenef),
    vtottrib: getIbptEstimate(ncm, company, previous.preco) ?? previous.vtottrib
  };
}

function updateClassificationAiNcm(id, aiCheck, options = {}, actor = "contador") {
  const previous = getClassification(id);
  if (!previous) return null;
  const currentSuggestion = previous.sugestao || {};
  const shouldTryApply = options.apply_suggestion !== false && options.applySuggestion !== false;
  const canApply = shouldTryApply && previous.status !== "approved" && aiCheck.result?.eligible_to_apply;
  const fiscalPatch = canApply ? buildFiscalPatchFromNcm(previous, aiCheck.result.ncm, aiCheck.result) : previous;
  const nextAiCheck = canApply ? { ...aiCheck, applied_fiscal: fiscalPatch } : aiCheck;
  const nextSuggestion = { ...currentSuggestion, ai_ncm: nextAiCheck };
  const confidence = canApply ? Math.max(Number(previous.confianca || 0), aiCheck.result.confidence) : previous.confianca;
  const observation = canApply
    ? `NCM e fiscal aplicados pelo classificador automatico: ${aiCheck.result.ncm} - ${aiCheck.result.descricao || aiCheck.result.reason}`
    : `${previous.observacao || ""}${previous.observacao ? " " : ""}Auto classificacao: ${aiCheck.result?.reason || "revisar manualmente."}`.trim();

  db.prepare(
    `
    UPDATE classifications SET
      sku = ?, ean = ?, ncm = ?, cest = ?, cfop_interno = ?, cfop_interestadual = ?,
      cst_icms = ?, aliquota_icms = ?, icms_st = ?, csosn = ?, origem = ?, cst_pis = ?,
      aliquota_pis = ?, cst_cofins = ?, aliquota_cofins = ?, aliquota_fcp = ?,
      ibs_cbs_cst = ?, cclass_trib = ?, ipi = ?, ex_tipi = ?, cbenef = ?, vtottrib = ?,
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
    fiscalPatch.ipi,
    fiscalPatch.ex_tipi,
    fiscalPatch.cbenef,
    fiscalPatch.vtottrib,
    Number(confidence || 0),
    previous.status === "approved" ? previous.status : "pending_review",
    observation,
    asJson(nextSuggestion),
    now(),
    id
  );
  if (canApply && fiscalPatch.unidade && fiscalPatch.unidade !== previous.unidade) {
    db.prepare("UPDATE products SET unidade = ? WHERE id = ?").run(fiscalPatch.unidade, previous.product_id);
  }

  const updated = getClassification(id);
  logAudit("classification", id, "openai_ncm_check", actor, previous, updated, {
    source_table: "openai_responses+ncm_oficial",
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
  const billing = options.skip_billing
    ? options.billing || null
    : await resolveAiBillingForUse({ classificationId: id, quantity: 1, actor, context: "item", options });
  if (billing?.enabled && billing.requires_payment) {
    return updateClassificationAiBilling(id, billing, actor);
  }
  const check = await buildAiNcmSuggestion(previous, { ...options, billing });
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
  const billing = rows.length
    ? await resolveAiBillingForUse({ quantity: rows.length, actor, context: "table", options })
    : { enabled: billingEnabled(), status: "empty", paid: true, requires_payment: false, quantity: 0, amount_cents: 0, amount_brl: 0 };
  if (billing?.enabled && billing.requires_payment) {
    logAudit("review_table", null, "openai_ncm_billing", actor, { total: rows.length }, { billing });
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
  const paidQuantity = billing?.enabled ? Math.max(0, Number(billing.quantity || 0)) : rows.length;
  const billableRows = billing?.enabled ? rows.slice(0, paidQuantity) : rows;
  const concurrency = billableRows.length
    ? Math.min(normalizeAiNcmConcurrency(options.concurrency ?? OPENAI_NCM_CONCURRENCY), billableRows.length)
    : 0;
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
      const updated = await checkClassificationAiNcm(row.id, { ...options, skip_billing: true, billing }, actor);
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
  const unpaidItems = Math.max(0, rows.length - billableRows.length);
  logAudit("review_table", null, "openai_ncm_check_all", actor, { total: rows.length }, { total: items.length, applied, counts, unpaidItems });
  return {
    checked: items.length,
    applied,
    counts,
    failed,
    concurrency: concurrency || 1,
    paid_items: billableRows.length,
    unpaid_items: unpaidItems,
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
  const origem = company.uf || "SP";
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

function getPisCofins(ncm) {
  const exact = db.prepare("SELECT * FROM regras_pis_cofins_por_ncm WHERE ncm = ? LIMIT 1").get(ncm);
  const fallback = db.prepare("SELECT * FROM regras_pis_cofins_por_ncm WHERE ncm = '00000000' LIMIT 1").get();
  return exact || fallback || { aliquota_pis: 1.65, aliquota_cofins: 7.6, tipo_incidencia: "basica" };
}

function getPisCofinsCst(pisCofins = {}) {
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
    .get(company.uf || "SP", ncm, `${String(ncm || "").slice(0, 4)}%`, ncm);
  if (!row) return null;
  const totalRate = Number(row.aliquota_federal || 0) + Number(row.aliquota_estadual || 0) + Number(row.aliquota_municipal || 0);
  return Number(((itemPrice * totalRate) / 100).toFixed(2));
}

function pickFiscalBenefit(tables, company) {
  const benefits = tables.cbenef || [];
  return benefits.find((item) => item.uf === company.uf) || benefits.find((item) => item.uf === "*") || benefits[0] || null;
}

function pickIbsCbsClassification(tables, cst) {
  const rows = tables.ibs_cbs_classificacao || [];
  return rows.find((item) => String(item.cst_permitido || "").split(/[,\s]+/).includes(cst)) || rows[0] || null;
}

function classifyProduct(product, operationType = "venda") {
  const company = getCompany();
  const operation = normalizeOperationType(operationType);
  const tokens = extractTokens(`${product.descricao_original} ${product.marca || ""} ${product.categoria || ""}`);
  const validated = findValidatedRule(tokens, 1, operation);
  const ncmMatch = findNcmMatch(product, tokens);
  const cfops = getCfopPair(operation, company);
  const pisCofins = getPisCofins(ncmMatch.codigo);
  const simples = company.regime_tributario === "simples_nacional" || company.crt === "1" || company.crt === "4";

  const confidenceParts = [
    ncmMatch.score,
    validated ? validated.score : 0,
    product.ncm_importado ? 0.1 : 0,
    product.codigo_barras ? 0.04 : 0,
    product.categoria ? 0.04 : 0
  ];
  const confidence = Math.min(0.98, Math.max(0.18, confidenceParts.reduce((sum, item) => sum + item, 0)));

  return {
    operation_type: operation,
    sku: product.codigo_produto || null,
    ean: product.codigo_barras || null,
    ncm: validated?.ncm || ncmMatch.codigo,
    cest: validated?.cest || null,
    cfop_interno: validated?.cfop_padrao_interno || cfops.interno,
    cfop_interestadual: validated?.cfop_padrao_interestadual || cfops.interestadual,
    cst_icms: simples ? null : validated?.cst_icms || "00",
    aliquota_icms: numberOrFallback(validated?.aliquota_icms, null),
    icms_st: validated?.cest ? "sim" : "incerto",
    csosn: simples ? validated?.csosn || "102" : null,
    origem: "0",
    cst_pis: validated?.pis || "01",
    aliquota_pis: numberOrFallback(validated?.aliquota_pis, pisCofins.aliquota_pis),
    cst_cofins: validated?.cofins || "01",
    aliquota_cofins: numberOrFallback(validated?.aliquota_cofins, pisCofins.aliquota_cofins),
    aliquota_fcp: numberOrFallback(validated?.aliquota_fcp, null),
    ibs_cbs_cst: validated?.ibs_cbs_cst || null,
    cclass_trib: validated?.cclass_trib || null,
    ipi: null,
    ex_tipi: null,
    cbenef: null,
    vtottrib: null,
    confianca: Number(confidence.toFixed(2)),
    status: confidence >= 0.88 && validated ? "suggested_high_confidence" : "pending_review",
    observacao: validated
      ? "Sugerido por regra validada anteriormente pelo contador."
      : "Sugestao automatica. Revisar antes de exportar.",
    sugestao_json: {
      tokens,
      ncm: ncmMatch,
      regra_validada_id: validated?.id || null,
      empresa: {
        crt: company.crt,
        regime_tributario: company.regime_tributario,
        uf: company.uf,
        contribuinte_icms: Boolean(company.contribuinte_icms)
      },
      operacao: operation,
      pis_cofins: pisCofins
    }
  };
}

function createImportBatch({ filename, sourceType, operationType, importedBy, rowCount }) {
  const operation = normalizeOperationType(operationType);
  const result = db.prepare(`
    INSERT INTO import_batches (filename, source_type, operation_type, imported_by, row_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(filename || null, sourceType, operation, importedBy || "sistema", rowCount || 0, now());
  return Number(result.lastInsertRowid);
}

function insertProduct(batchId, product, operationType) {
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
  const classification = classifyProduct({ ...product, descricao_tratada: descricaoTratada }, operation);
  db.prepare(`
    INSERT INTO classifications (
      product_id, operation_type, sku, ean, ncm, cest, cfop_interno, cfop_interestadual, cst_icms,
      aliquota_icms, icms_st, csosn, origem, cst_pis, aliquota_pis, cst_cofins, aliquota_cofins,
      aliquota_fcp, ibs_cbs_cst,
      cclass_trib, ipi, ex_tipi, cbenef, vtottrib, confianca, status, observacao, sugestao_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    operation,
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
    classification.ipi,
    classification.ex_tipi,
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

function importProducts({ products, filename, sourceType, operationType, importedBy }) {
  const cleanProducts = products
    .map((product, index) => mapProductRow(product, index))
    .filter((product) => product.descricao_original);
  const operation = normalizeOperationType(operationType);
  const batchId = createImportBatch({
    filename,
    sourceType,
    operationType: operation,
    importedBy,
    rowCount: cleanProducts.length
  });
  const ids = cleanProducts.map((product) => insertProduct(batchId, product, operation));
  logAudit("import_batch", batchId, "import", importedBy || "sistema", null, {
    filename,
    sourceType,
    operationType: operation,
    rowCount: cleanProducts.length
  });
  return { batchId, imported: ids.length, operationType: operation };
}

function rowToClassification(row) {
  return {
    id: row.classification_id,
    product_id: row.product_id,
    batch_id: row.batch_id,
    operation_type: normalizeOperationType(row.operation_type || row.batch_operation_type || "venda"),
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
    ipi: row.ipi,
    ex_tipi: row.ex_tipi,
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
      ib.operation_type AS batch_operation_type
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
      ib.operation_type AS batch_operation_type
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
    "ipi",
    "ex_tipi",
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
  if (Object.prototype.hasOwnProperty.call(patch, "operation_type") && next.operation_type !== previous.operation_type) {
    const cfops = getCfopPair(next.operation_type, getCompany());
    next.cfop_interno = cfops.interno;
    next.cfop_interestadual = cfops.interestadual;
    const operationNote = `Operacao alterada para ${next.operation_type}; CFOP recalculado automaticamente.`;
    next.observacao = next.observacao ? `${next.observacao} ${operationNote}` : operationNote;
  }
  db.prepare(`
    UPDATE classifications SET
      operation_type = ?, sku = ?, ean = ?, ncm = ?, cest = ?, cfop_interno = ?, cfop_interestadual = ?,
      cst_icms = ?, aliquota_icms = ?, icms_st = ?, csosn = ?, origem = ?, cst_pis = ?,
      aliquota_pis = ?, cst_cofins = ?, aliquota_cofins = ?, aliquota_fcp = ?,
      ibs_cbs_cst = ?, cclass_trib = ?, ipi = ?, ex_tipi = ?, cbenef = ?, vtottrib = ?,
      confianca = ?, status = ?, observacao = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.operation_type,
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
    next.ipi,
    next.ex_tipi,
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

function reclassifyClassification(id, actor = "contador") {
  const previous = getClassification(id);
  if (!previous) return null;
  const operation = getOperationForClassification(previous);
  const suggestion = classifyProduct(previous, operation);
  db.prepare(`
    UPDATE classifications SET
      operation_type = ?, sku = ?, ean = ?, ncm = ?, cest = ?, cfop_interno = ?, cfop_interestadual = ?,
      cst_icms = ?, aliquota_icms = ?, icms_st = ?, csosn = ?, origem = ?, cst_pis = ?,
      aliquota_pis = ?, cst_cofins = ?, aliquota_cofins = ?, aliquota_fcp = ?,
      ibs_cbs_cst = ?, cclass_trib = ?, ipi = ?, ex_tipi = ?, cbenef = ?, vtottrib = ?,
      confianca = ?, status = ?, observacao = ?, sugestao_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    suggestion.operation_type,
    suggestion.sku,
    suggestion.ean,
    suggestion.ncm,
    suggestion.cest,
    suggestion.cfop_interno,
    suggestion.cfop_interestadual,
    suggestion.cst_icms,
    suggestion.aliquota_icms,
    suggestion.icms_st,
    suggestion.csosn,
    suggestion.origem,
    suggestion.cst_pis,
    suggestion.aliquota_pis,
    suggestion.cst_cofins,
    suggestion.aliquota_cofins,
    suggestion.aliquota_fcp,
    suggestion.ibs_cbs_cst,
    suggestion.cclass_trib,
    suggestion.ipi,
    suggestion.ex_tipi,
    suggestion.cbenef,
    suggestion.vtottrib,
    suggestion.confianca,
    "pending_review",
    "Reclassificado automaticamente para nova revisão do contador.",
    asJson(suggestion.sugestao_json),
    now(),
    id
  );
  const updated = getClassification(id);
  logAudit("classification", id, "reclassify", actor, previous, updated);
  return updated;
}

function refineClassificationDescription(id, description, actor = "contador") {
  const current = getClassification(id);
  if (!current) return null;
  const descricao = String(description || "").trim();
  if (!descricao) {
    const error = new Error("Informe uma descricao para especificar o produto.");
    error.status = 422;
    throw error;
  }
  db.prepare("UPDATE products SET descricao_original = ?, descricao_tratada = ? WHERE id = ?").run(
    descricao,
    normalizeText(descricao),
    current.product_id
  );
  logAudit("product", current.product_id, "refine_description", actor, current, { descricao_original: descricao });
  return reclassifyClassification(id, actor);
}

function reclassifyReviewTable(actor = "contador") {
  const rows = db
    .prepare("SELECT id FROM classifications WHERE status != 'approved' OR ncm = '00000000' ORDER BY id")
    .all();
  const updated = [];
  for (const row of rows) {
    const item = reclassifyClassification(row.id, actor);
    if (item) updated.push(item);
  }
  logAudit("review_table", null, "reclassify_all", actor, { total: rows.length }, { total: updated.length });
  return { reclassified: updated.length };
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
  if (AI_LEARNING_ENABLED) saveValidatedRule(approved, actor);
  logAudit("classification", id, "approve", actor, updated, approved);
  return approved;
}

function saveValidatedRule(classification, actor) {
  const tokens = extractTokens(classification.descricao_tratada || classification.descricao_original);
  db.prepare(`
    INSERT INTO validated_rules (
      descricao_base, palavras_chave, empresa_id, tipo_operacao, segmento, ncm, cfop_padrao_interno,
      cfop_padrao_interestadual, csosn, cst_icms, aliquota_icms, pis, aliquota_pis,
      cofins, aliquota_cofins, cest, aliquota_fcp, ibs_cbs_cst, cclass_trib,
      contador_id, data_validacao
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    classification.descricao_tratada || classification.descricao_original,
    asJson(tokens, []),
    normalizeOperationType(classification.operation_type),
    classification.categoria || null,
    classification.ncm,
    classification.cfop_interno,
    classification.cfop_interestadual,
    classification.csosn,
    classification.cst_icms,
    classification.aliquota_icms,
    classification.cst_pis,
    classification.aliquota_pis,
    classification.cst_cofins,
    classification.aliquota_cofins,
    classification.cest,
    classification.aliquota_fcp,
    classification.ibs_cbs_cst,
    classification.cclass_trib,
    actor,
    now()
  );
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
    ibs_cbs_classificacao: db.prepare("SELECT * FROM ibs_cbs_classificacao ORDER BY cclass_trib").all(),
    validated_rules: db.prepare("SELECT * FROM validated_rules ORDER BY data_validacao DESC LIMIT 100").all()
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
  "CST IBS/CBS",
  "cClassTrib",
  "IPI",
  "EX TIPI",
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
    "CST IBS/CBS": item.ibs_cbs_cst || "",
    cClassTrib: item.cclass_trib || "",
    IPI: item.ipi ?? "",
    "EX TIPI": item.ex_tipi || "",
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

  if (req.method === "POST" && path === "/api/classifications/reclassify") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    return sendJson(res, 200, reclassifyReviewTable(payload.actor || "contador"));
  }

  if (req.method === "POST" && path === "/api/classifications/ncm-check") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    return sendJson(res, 200, await checkReviewTableNcm(payload, payload.actor || "contador"));
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

  const reclassifyMatch = path.match(/^\/api\/classifications\/(\d+)\/reclassify$/);
  if (reclassifyMatch && req.method === "POST") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    const updated = reclassifyClassification(Number(reclassifyMatch[1]), payload.actor || "contador");
    if (!updated) return sendJson(res, 404, { error: "Classificacao nao encontrada." });
    return sendJson(res, 200, updated);
  }

  const ncmCheckMatch = path.match(/^\/api\/classifications\/(\d+)\/ncm-check$/);
  if (ncmCheckMatch && req.method === "POST") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    const updated = await checkClassificationNcm(Number(ncmCheckMatch[1]), payload, payload.actor || "contador");
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

  const refineMatch = path.match(/^\/api\/classifications\/(\d+)\/refine$/);
  if (refineMatch && req.method === "POST") {
    const payload = JSON.parse(decodeText(await readBody(req)) || "{}");
    assertAiProcessingUnlocked();
    const updated = refineClassificationDescription(
      Number(refineMatch[1]),
      payload.descricao || payload.descricao_original,
      payload.actor || "contador"
    );
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
