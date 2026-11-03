// Camada de dados: Google Sheets (produção) ou arquivo JSON local (modo demo/desenvolvimento)
const fs = require('fs');
const path = require('path');

const SCHEMA = {
  Produtos: ['id', 'codigo', 'nome', 'categoria', 'preco_custo', 'preco_venda', 'estoque', 'estoque_minimo', 'unidade', 'ativo', 'atualizado_em'],
  // caixa_id / operador ficam no fim para não desalinhar planilhas já existentes
  Vendas: ['id', 'data', 'subtotal', 'desconto', 'total', 'forma_pagamento', 'valor_recebido', 'troco', 'itens_qtd', 'status', 'obs', 'caixa_id', 'operador'],
  ItensVenda: ['venda_id', 'data', 'produto_id', 'codigo', 'nome', 'quantidade', 'preco_unit', 'total'],
  Movimentacoes: ['id', 'data', 'produto_id', 'nome', 'tipo', 'quantidade', 'estoque_apos', 'motivo'],
  Caixa: ['id', 'data', 'tipo', 'valor', 'obs', 'caixa_id', 'operador'],
};

const NUMERIC = new Set(['preco_custo', 'preco_venda', 'estoque', 'estoque_minimo', 'subtotal', 'desconto', 'total',
  'valor_recebido', 'troco', 'itens_qtd', 'quantidade', 'preco_unit', 'estoque_apos', 'valor']);

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v == null) return 0;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // formato brasileiro 1.234,56
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function rowToObj(sheet, row, rowNumber) {
  const obj = { _row: rowNumber };
  SCHEMA[sheet].forEach((h, i) => {
    let v = row[i] === undefined ? '' : row[i];
    if (NUMERIC.has(h)) v = toNumber(v);
    else if (h === 'ativo') v = !(v === false || String(v).toUpperCase() === 'FALSE' || v === '0');
    else v = v === null ? '' : String(v);
    obj[h] = v;
  });
  return obj;
}

function objToRow(sheet, obj) {
  return SCHEMA[sheet].map((h) => {
    const v = obj[h];
    if (v === undefined || v === null) return '';
    if (h === 'ativo') return v ? 'TRUE' : 'FALSE';
    return v;
  });
}

// Fila simples para serializar escritas (evita corrida entre vendas simultâneas)
let chain = Promise.resolve();
function lock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/* ---------------- Google Sheets ---------------- */
class SheetsStore {
  constructor({ spreadsheetId, credentials }) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.api = google.sheets({ version: 'v4', auth });
    this.id = spreadsheetId;
    this.cache = {};
    this.ttl = Number(process.env.CACHE_SECONDS || 20) * 1000;
    this.kind = 'google-sheets';
  }

  async init() {
    const meta = await this.api.spreadsheets.get({ spreadsheetId: this.id, fields: 'sheets.properties.title' });
    const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
    const missing = Object.keys(SCHEMA).filter((s) => !existing.has(s));
    if (missing.length) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.id,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) },
      });
    }
    // Garante cabeçalhos
    const ranges = Object.keys(SCHEMA).map((s) => `${s}!1:1`);
    const res = await this.api.spreadsheets.values.batchGet({ spreadsheetId: this.id, ranges });
    const data = [];
    res.data.valueRanges.forEach((vr, i) => {
      const sheet = Object.keys(SCHEMA)[i];
      const head = (vr.values && vr.values[0]) || [];
      if (head.join('|') !== SCHEMA[sheet].join('|')) {
        data.push({ range: `${sheet}!A1:${colLetter(SCHEMA[sheet].length)}1`, values: [SCHEMA[sheet]] });
      }
    });
    if (data.length) {
      await this.api.spreadsheets.values.batchUpdate({ spreadsheetId: this.id, requestBody: { valueInputOption: 'RAW', data } });
    }
  }

  async all(sheet) {
    const c = this.cache[sheet];
    if (c && Date.now() - c.t < this.ttl) return c.rows.map((r) => ({ ...r }));
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.id,
      range: `${sheet}!A2:${colLetter(SCHEMA[sheet].length)}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const rows = (res.data.values || [])
      .map((r, i) => rowToObj(sheet, r, i + 2))
      .filter((o) => SCHEMA[sheet].some((h) => o[h] !== '' && o[h] !== 0 && h !== 'ativo'));
    this.cache[sheet] = { t: Date.now(), rows };
    return rows.map((r) => ({ ...r }));
  }

  async append(sheet, objs) {
    if (!objs.length) return;
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.id,
      range: `${sheet}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: objs.map((o) => objToRow(sheet, o)) },
    });
    delete this.cache[sheet];
  }

  // updates: [{ sheet, obj }] onde obj._row é a linha na planilha
  async update(updates) {
    if (!updates.length) return;
    const data = updates.map(({ sheet, obj }) => ({
      range: `${sheet}!A${obj._row}:${colLetter(SCHEMA[sheet].length)}${obj._row}`,
      values: [objToRow(sheet, obj)],
    }));
    await this.api.spreadsheets.values.batchUpdate({ spreadsheetId: this.id, requestBody: { valueInputOption: 'RAW', data } });
    updates.forEach(({ sheet }) => delete this.cache[sheet]);
  }
}

/* ---------------- Arquivo local (demo) ---------------- */
class LocalStore {
  constructor(file) {
    this.file = file;
    this.kind = 'local';
  }
  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      const empty = {};
      Object.keys(SCHEMA).forEach((s) => (empty[s] = []));
      fs.writeFileSync(this.file, JSON.stringify(empty, null, 2));
    }
    this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    Object.keys(SCHEMA).forEach((s) => (this.data[s] = this.data[s] || []));
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  async all(sheet) { return this.data[sheet].map((r, i) => rowToObj(sheet, r, i + 2)); }
  async append(sheet, objs) { objs.forEach((o) => this.data[sheet].push(objToRow(sheet, o))); this.save(); }
  async update(updates) {
    updates.forEach(({ sheet, obj }) => { this.data[sheet][obj._row - 2] = objToRow(sheet, obj); });
    this.save();
  }
}

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  }
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') };
  }
  return null;
}

function createStore() {
  const credentials = loadCredentials();
  if (process.env.SHEET_ID && credentials) {
    return new SheetsStore({ spreadsheetId: process.env.SHEET_ID, credentials });
  }
  console.warn('⚠️  SHEET_ID/credenciais não configurados — usando banco LOCAL (data/local-db.json). Use só para testes.');
  return new LocalStore(path.join(__dirname, '..', 'data', 'local-db.json'));
}

module.exports = { createStore, lock, SCHEMA };
