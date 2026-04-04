#!/usr/bin/env node
/**
 * updateOptions.mjs
 *
 * Baixa o arquivo de instrumentos consolidados da B3 (InstrumentsConsolidated)
 * e gera o optionsB3.json com todas as opções de ações listadas.
 *
 * Endpoint oficial da B3:
 *   1. POST para obter token: /api/download/requestname?fileName=InstrumentsConsolidated&date=YYYY-MM-DD
 *   2. GET com token: /api/download/?token=<token>
 *
 * Uso:
 *   node scripts/updateOptions.mjs                      # último dia útil
 *   node scripts/updateOptions.mjs --date 2026-04-01    # data específica
 *   npm run update-options                               # via npm
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "src", "optionsB3.json");

// ── Config ────────────────────────────────────────────────────────

const B3_API_BASE = "https://arquivos.b3.com.br";

// Ativos que queremos rastrear (pode expandir conforme necessário)
const ATIVOS_ALVO = new Set([
  "ALLOS", "AMBEV", "AURE", "AZUL", "B3SA", "BBAS", "BBDC", "BBSE",
  "BEEF", "BPAC", "BRAV", "BRFS", "BRKM", "CASH", "CBAV", "CCRO",
  "CMIN", "CMIG", "COGN", "CPFE", "CPLE", "CRFB", "CSAN", "CSNA",
  "CXSE", "CYRE", "DIRR", "ELET", "EMBR", "ENEV", "ENGI", "EQTL",
  "GGBR", "GOAU", "HAPV", "HYPE", "IGTI", "IRBR", "ITSA", "ITUB",
  "JBSS", "KLBN", "LREN", "LWSA", "MGLU", "MRFG", "MRVE", "MULT",
  "NTCO", "PCAR", "PETR", "PETZ", "POSI", "PRIO", "QUAL", "RADL",
  "RAIL", "RAIZ", "RDOR", "RECV", "RENT", "RRRP", "SANB", "SAPR",
  "SBSP", "SLCE", "SMTO", "SOMA", "STBP", "SUZB", "TAEE", "TIMS",
  "TOTS", "UGPA", "USIM", "VALE", "VAMO", "VBBR", "VIVT", "WEGE", "YDUQ"
]);

// ── Helpers ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) opts.date = args[++i];
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    if (args[i] === "--all-ativos") opts.allAtivos = true;
    if (args[i] === "--help") { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log(`
  updateOptions.mjs - Atualiza optionsB3.json com dados da B3

  Uso:
    node scripts/updateOptions.mjs [opções]

  Opções:
    --date YYYY-MM-DD    Data de referência (padrão: último dia útil)
    --output caminho     Caminho do arquivo de saída
    --all-ativos         Incluir TODOS os ativos (não apenas os pré-selecionados)
    --help               Mostra esta ajuda
  `);
}

function lastBusinessDay(from = new Date()) {
  const d = new Date(from);
  // Se for fim de semana ou antes das 19h BRT, pegar dia anterior
  const brHour = d.getUTCHours() - 3;
  if (brHour < 19) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

function diffDays(dateStr) {
  const target = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((target - today) / 86400000));
}

// ── Passo 1: Obter token de download da B3 ──────────────────────

async function getDownloadToken(date) {
  const url = `${B3_API_BASE}/api/download/requestname?fileName=InstrumentsConsolidated&date=${date}`;

  console.log(`  🔑 Obtendo token para ${date}...`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Falha ao obter token: HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data.token) {
    throw new Error("Token não encontrado na resposta da B3");
  }

  console.log(`  ✅ Token obtido (arquivo: ${data.file?.name || "?"})`);
  return data.token;
}

// ── Passo 2: Baixar CSV com o token ──────────────────────────────

async function downloadCSV(token) {
  const url = `${B3_API_BASE}/api/download/?token=${token}`;

  console.log("  📥 Baixando arquivo de instrumentos...");

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!res.ok) {
    throw new Error(`Falha no download: HTTP ${res.status}`);
  }

  const text = await res.text();
  const sizeMB = (new TextEncoder().encode(text).length / 1024 / 1024).toFixed(1);
  const lineCount = text.split("\n").length;

  console.log(`  ✅ Download concluído: ${sizeMB} MB, ${lineCount.toLocaleString("pt-BR")} linhas`);
  return text;
}

// ── Passo 3: Parsear CSV e extrair opções de ações ──────────────

function parseInstrumentsCSV(csvText, filterAtivos = true) {
  const lines = csvText.split("\n");

  // Linha 0: "Status do Arquivo: Final"
  // Linha 1: Header com campos separados por ;
  if (lines.length < 3) {
    throw new Error("CSV vazio ou inválido");
  }

  const headerLine = lines.find(l => l.startsWith("RptDt;"));
  if (!headerLine) {
    throw new Error("Header do CSV não encontrado");
  }

  const headers = headerLine.split(";").map(h => h.trim());
  const headerIdx = {};
  headers.forEach((h, i) => (headerIdx[h] = i));

  // Campos que precisamos:
  // TckrSymb (1)  - Ticker da opção (ex: PETRA215)
  // Asst (2)      - Ativo-objeto (ex: PETR4)
  // AsstDesc (3)  - Descrição do ativo (ex: PETR)
  // SctyCtgyNm (6)- Categoria (OPTION ON EQUITIES)
  // XprtnDt (7)   - Data de vencimento (2027-01-15)
  // OptnTp (19)   - Tipo (Call / Put)
  // ExrcPric (35) - Preço de exercício (strike)
  // OptnStyle (36)- Estilo (EURO / AMER)

  const iTicker   = headerIdx["TckrSymb"];
  const iAsst     = headerIdx["Asst"];
  const iAsstDesc = headerIdx["AsstDesc"];
  const iCategory = headerIdx["SctyCtgyNm"];
  const iExpiry   = headerIdx["XprtnDt"];
  const iOptnTp   = headerIdx["OptnTp"];
  const iStrike   = headerIdx["ExrcPric"];
  const iStyle    = headerIdx["OptnStyle"];
  const iSgmt     = headerIdx["SgmtNm"];

  if (iTicker === undefined || iCategory === undefined) {
    throw new Error("Campos obrigatórios não encontrados no header");
  }

  const options = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 20) continue;

    const cols = line.split(";");
    const category = cols[iCategory] || "";

    // Filtrar apenas opções de ações
    if (category !== "OPTION ON EQUITIES") continue;

    const ticker   = (cols[iTicker] || "").trim();
    const asst     = (cols[iAsst] || "").trim();      // Ex: PETR4
    const asstDesc = (cols[iAsstDesc] || "").trim();   // Ex: PETR
    const expiry   = (cols[iExpiry] || "").trim();     // Ex: 2027-01-15
    const optnTp   = (cols[iOptnTp] || "").trim();     // Call ou Put
    const strikeRaw = (cols[iStrike] || "").trim();     // Ex: 215 ou 36.50
    const style    = (cols[iStyle] || "").trim();       // EURO ou AMER
    const sgmt     = (cols[iSgmt] || "").trim();

    if (!ticker || !expiry) continue;

    // Filtrar por ativos alvo
    if (filterAtivos && !ATIVOS_ALVO.has(asstDesc)) {
      skipped++;
      continue;
    }

    // Parse do strike (pode ser inteiro ou decimal, e usar vírgula ou ponto)
    const strike = parseFloat(strikeRaw.replace(",", ".")) || 0;

    // Calcular dias até vencimento
    const dias = diffDays(expiry);

    // Pular expiradas direto no parse (não salvar no JSON)
    if (dias <= 0) {
      skipped++;
      continue;
    }

    options.push({
      ativo: asstDesc || asst.replace(/\d+$/, ""),  // PETR (sem número)
      ativoObj: asst,                                 // PETR4 (com número)
      ticker: ticker,                                 // PETRA215
      tipo: optnTp.toLowerCase() === "put" ? "put" : "call",
      estilo: style === "AMER" ? "americana" : "europeia",
      strike: strike,                                 // 215
      venc: expiry,                                   // 2027-01-15
    });
  }

  console.log(`  📊 Parseado: ${options.length.toLocaleString("pt-BR")} opções de ações`);
  if (skipped > 0) {
    console.log(`  ⏭️  ${skipped.toLocaleString("pt-BR")} opções de outros ativos ignoradas`);
  }

  return options;
}

// ── Ordenar e formatar saída ──────────────────────────────────────

function sortOptions(options) {
  return options.sort((a, b) => {
    if (a.ativo !== b.ativo) return a.ativo.localeCompare(b.ativo);
    if (a.tipo !== b.tipo) return a.tipo === "call" ? -1 : 1;
    if (a.venc !== b.venc) return a.venc.localeCompare(b.venc);
    if (a.strike !== b.strike) return a.strike - b.strike;
    return a.ticker.localeCompare(b.ticker);
  });
}

// ── Retry com backoff ─────────────────────────────────────────────

async function retry(fn, maxAttempts = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.log(`  ⚠️ Tentativa ${attempt}/${maxAttempts} falhou: ${err.message}`);
      console.log(`  ⏳ Aguardando ${delayMs / 1000}s antes de tentar novamente...`);
      await new Promise(r => setTimeout(r, delayMs));
      delayMs *= 2; // exponential backoff
    }
  }
}

// ── Tentar múltiplas datas (caso o dia solicitado não tenha dados) ─

async function fetchWithDateFallback(startDate, maxDaysBack = 5) {
  const d = new Date(startDate);

  for (let i = 0; i < maxDaysBack; i++) {
    const dateStr = d.toISOString().slice(0, 10);

    // Pular fins de semana
    if (d.getDay() === 0 || d.getDay() === 6) {
      d.setDate(d.getDate() - 1);
      continue;
    }

    try {
      console.log(`\n📅 Tentando data: ${dateStr}`);
      const token = await retry(() => getDownloadToken(dateStr));
      const csv = await retry(() => downloadCSV(token));
      return { csv, date: dateStr };
    } catch (err) {
      console.log(`  ❌ ${dateStr}: ${err.message}`);
      d.setDate(d.getDate() - 1);
    }
  }

  throw new Error(`Nenhum dado disponível nos últimos ${maxDaysBack} dias úteis`);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const refDate = args.date || lastBusinessDay();
  const outputPath = args.output || OUTPUT_PATH;
  const filterAtivos = !args.allAtivos;

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  📊 Atualizador de Opções B3                    ║");
  console.log("║  Fonte: InstrumentsConsolidated (arquivos.b3)   ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  📅 Data referência: ${refDate}`);
  console.log(`  📁 Saída: ${outputPath}`);
  console.log(`  🔍 Filtro: ${filterAtivos ? ATIVOS_ALVO.size + " ativos selecionados" : "TODOS os ativos"}`);

  // Baixar dados
  const { csv, date: actualDate } = await fetchWithDateFallback(refDate);

  // Parsear (já filtra expiradas durante o parse)
  console.log("\n🔧 Parseando dados...");
  let options = parseInstrumentsCSV(csv, filterAtivos);

  // Ordenar
  options = sortOptions(options);

  // Salvar
  const json = JSON.stringify(options);
  writeFileSync(outputPath, json);

  // Estatísticas finais
  const ativos = [...new Set(options.map(o => o.ativo))];
  const calls = options.filter(o => o.tipo === "call").length;
  const puts = options.filter(o => o.tipo === "put").length;
  const americanas = options.filter(o => o.estilo === "americana").length;
  const europeias = options.filter(o => o.estilo === "europeia").length;
  const sizeMB = (json.length / 1024 / 1024).toFixed(1);

  console.log("\n══════════════════════════════════════════════════");
  console.log("  📊 RESUMO (somente opções ativas)");
  console.log("══════════════════════════════════════════════════");
  console.log(`  📅 Data dos dados: ${actualDate}`);
  console.log(`  📁 Arquivo: ${outputPath}`);
  console.log(`  📦 Tamanho: ${sizeMB} MB`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  📈 Total:      ${options.length.toLocaleString("pt-BR")} opções ativas`);
  console.log(`  📞 Calls:      ${calls.toLocaleString("pt-BR")}`);
  console.log(`  📉 Puts:       ${puts.toLocaleString("pt-BR")}`);
  console.log(`  🇺🇸 Americanas: ${americanas.toLocaleString("pt-BR")}`);
  console.log(`  🇪🇺 Europeias:  ${europeias.toLocaleString("pt-BR")}`);
  console.log(`  🏢 Ativos:     ${ativos.length} (${ativos.slice(0, 10).join(", ")}...)`);
  console.log("══════════════════════════════════════════════════");
}

main().catch(err => {
  console.error("\n❌ Erro fatal:", err.message);
  process.exit(1);
});
