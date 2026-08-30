import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = process.cwd();
const DATA_DIR = resolve(ROOT, "data");
const DB_PATH = resolve(process.env.DATABASE_PATH || join(DATA_DIR, "autoclass.sqlite"));

const rows = JSON.parse(readFileSync(join(DATA_DIR, "cest_import_data.json"), "utf8"));

const db = new DatabaseSync(DB_PATH);

db.exec("BEGIN");
try {
  const before = db.prepare("SELECT COUNT(*) AS c FROM cest").get().c;
  if (before > 0) {
    console.log(`Tabela cest ja tem ${before} linha(s); apagando antes de reimportar para evitar duplicatas.`);
    db.exec("DELETE FROM cest");
  }
  const insert = db.prepare(
    "INSERT INTO cest (codigo_cest, ncm, descricao, segmento, item_segmento) VALUES (?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    insert.run(row.codigo_cest, row.ncm, row.descricao, row.segmento, row.item_segmento);
  }
  db.exec("COMMIT");
  const after = db.prepare("SELECT COUNT(*) AS c FROM cest").get().c;
  console.log(`Importado com sucesso: ${after} linhas na tabela cest.`);
} catch (err) {
  db.exec("ROLLBACK");
  console.error("Falhou, rollback aplicado:", err);
  process.exit(1);
}

// Verificacao rapida: NCM da lampada de LED do exemplo original
const check = db.prepare("SELECT * FROM cest WHERE ncm = ? OR ncm LIKE ? ORDER BY codigo_cest").all("85395200", "8539%");
console.log("Checagem NCM 85395200 (lampada LED):", JSON.stringify(check, null, 2));

db.close();
