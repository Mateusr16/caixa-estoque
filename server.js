const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createStore, lock } = require('./src/db');

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';
const SENHA = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || SENHA || 'dev';
const EXIGIR_CAIXA = process.env.EXIGIR_CAIXA_ABERTO !== 'false';

const db = createStore();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- utilidades ---------------- */
const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const agora = () => fmt.format(new Date()).replace('T', ' '); // "2026-11-03 13:36:00"
const hoje = () => agora().slice(0, 10);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const novoId = (p) => p + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
const clean = (o) => { const { _row, ...rest } = o; return rest; };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ erro: e.status ? e.message : 'Erro interno: ' + e.message });
});

/* ---------------- autenticação simples por senha ---------------- */
const tokenFor = () => crypto.createHmac('sha256', SECRET).update('caixa:' + SENHA).digest('hex');
app.post('/api/login', (req, res) => {
  if (!SENHA) return res.json({ token: 'livre' });
  if ((req.body.senha || '') !== SENHA) return res.status(401).json({ erro: 'Senha incorreta' });
  res.json({ token: tokenFor() });
});
app.get('/api/health', (req, res) => res.json({ ok: true, banco: db.kind, hora: agora() }));
app.use('/api', (req, res, next) => {
  if (!SENHA) return next();
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (t && crypto.timingSafeEqual(Buffer.from(t.padEnd(64).slice(0, 64)), Buffer.from(tokenFor()))) return next();
  res.status(401).json({ erro: 'Não autorizado' });
});
app.get('/api/config', (req, res) => res.json({ banco: db.kind, exigirCaixa: EXIGIR_CAIXA, auth: !!SENHA }));

/* ---------------- produtos ---------------- */
function validarProduto(b) {
  if (!b.nome || !String(b.nome).trim()) throw new HttpError(400, 'Informe o nome do produto');
  if (Number(b.preco_venda) < 0 || isNaN(Number(b.preco_venda))) throw new HttpError(400, 'Preço de venda inválido');
}

app.get('/api/produtos', wrap(async (req, res) => {
  const todos = await db.all('Produtos');
  const lista = req.query.todos ? todos : todos.filter((p) => p.ativo);
  res.json(lista.map(clean).sort((a, b) => a.nome.localeCompare(b.nome)));
}));

app.post('/api/produtos', wrap(async (req, res) => lock(async () => {
  const b = req.body; validarProduto(b);
  const todos = await db.all('Produtos');
  const codigo = String(b.codigo || '').trim();
  if (codigo && todos.some((p) => p.ativo && p.codigo === codigo)) throw new HttpError(400, 'Já existe um produto com esse código');
  const p = {
    id: novoId('P'), codigo, nome: String(b.nome).trim(), categoria: String(b.categoria || '').trim(),
    preco_custo: r2(b.preco_custo), preco_venda: r2(b.preco_venda), estoque: Number(b.estoque) || 0,
    estoque_minimo: Number(b.estoque_minimo) || 0, unidade: b.unidade || 'un', ativo: true, atualizado_em: agora(),
  };
  await db.append('Produtos', [p]);
  if (p.estoque) {
    await db.append('Movimentacoes', [{ id: novoId('M'), data: agora(), produto_id: p.id, nome: p.nome, tipo: 'entrada', quantidade: p.estoque, estoque_apos: p.estoque, motivo: 'Estoque inicial' }]);
  }
  res.status(201).json(p);
})));

app.put('/api/produtos/:id', wrap(async (req, res) => lock(async () => {
  const b = req.body; validarProduto(b);
  const todos = await db.all('Produtos');
  const p = todos.find((x) => x.id === req.params.id);
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  const codigo = String(b.codigo || '').trim();
  if (codigo && todos.some((x) => x.ativo && x.id !== p.id && x.codigo === codigo)) throw new HttpError(400, 'Já existe um produto com esse código');
  Object.assign(p, {
    codigo, nome: String(b.nome).trim(), categoria: String(b.categoria || '').trim(),
    preco_custo: r2(b.preco_custo), preco_venda: r2(b.preco_venda), estoque_minimo: Number(b.estoque_minimo) || 0,
    unidade: b.unidade || p.unidade || 'un', atualizado_em: agora(),
  });
  // estoque é alterado apenas por movimentações, para manter o histórico
  await db.update([{ sheet: 'Produtos', obj: p }]);
  res.json(clean(p));
})));

app.delete('/api/produtos/:id', wrap(async (req, res) => lock(async () => {
  const p = (await db.all('Produtos')).find((x) => x.id === req.params.id);
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  p.ativo = false; p.atualizado_em = agora();
  await db.update([{ sheet: 'Produtos', obj: p }]);
  res.json({ ok: true });
})));

/* ---------------- estoque ---------------- */
app.post('/api/estoque/movimentar', wrap(async (req, res) => lock(async () => {
  const { produto_id, tipo, motivo } = req.body;
  const qtd = Number(req.body.quantidade);
  if (!['entrada', 'saida', 'ajuste'].includes(tipo)) throw new HttpError(400, 'Tipo inválido');
  if (isNaN(qtd) || qtd < 0 || (tipo !== 'ajuste' && qtd === 0)) throw new HttpError(400, 'Quantidade inválida');
  const p = (await db.all('Produtos')).find((x) => x.id === produto_id && x.ativo);
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  let delta;
  if (tipo === 'entrada') delta = qtd;
  else if (tipo === 'saida') delta = -qtd;
  else delta = qtd - p.estoque; // ajuste: define o estoque final
  p.estoque = r2(p.estoque + delta); p.atualizado_em = agora();
  await db.update([{ sheet: 'Produtos', obj: p }]);
  const mov = { id: novoId('M'), data: agora(), produto_id: p.id, nome: p.nome, tipo, quantidade: r2(delta), estoque_apos: p.estoque, motivo: motivo || '' };
  await db.append('Movimentacoes', [mov]);
  res.json({ produto: clean(p), movimentacao: mov });
})));

app.get('/api/movimentacoes', wrap(async (req, res) => {
  let movs = (await db.all('Movimentacoes')).map(clean).reverse();
  if (req.query.produto_id) movs = movs.filter((m) => m.produto_id === req.query.produto_id);
  res.json(movs.slice(0, Number(req.query.limit) || 200));
}));

/* ---------------- caixa (vários caixas abertos ao mesmo tempo) ---------------- */
// Cada abertura cria um caixa próprio: caixa_id = id da linha de abertura, com o nome do operador.
// Linhas antigas (sem caixa_id) continuam funcionando como um caixa único "legado".
function resumoSessao(s) {
  const porForma = {};
  s.vendas.forEach((v) => { porForma[v.forma_pagamento] = r2((porForma[v.forma_pagamento] || 0) + v.total); });
  const soma = (t) => r2(s.movimentos.filter((m) => m.tipo === t).reduce((x, m) => x + m.valor, 0));
  const suprimentos = soma('suprimento'), sangrias = soma('sangria');
  const esperadoDinheiro = r2(s.abertura.valor + suprimentos - sangrias + (porForma['Dinheiro'] || 0));
  return {
    caixa_id: s.caixa_id, operador: s.operador, aberto: !s.fechamento, abertura: s.abertura, fechamento: s.fechamento,
    movimentos: s.movimentos, vendasQtd: s.vendas.length, totalVendas: r2(s.vendas.reduce((x, v) => x + v.total, 0)),
    porForma, suprimentos, sangrias, esperadoDinheiro,
    contado: s.fechamento ? s.fechamento.valor : null,
    diferenca: s.fechamento ? r2(s.fechamento.valor - esperadoDinheiro) : null,
  };
}

async function sessoesCaixa() {
  const [movs, vendas] = await Promise.all([db.all('Caixa'), db.all('Vendas')]);
  const mapa = new Map();
  let legado = null;
  for (const m of movs) {
    if (m.tipo === 'abertura') {
      const id = m.caixa_id || m.id;
      const s = { caixa_id: id, operador: m.operador || 'Caixa', abertura: clean(m), movimentos: [], fechamento: null, vendas: [], legado: !m.caixa_id };
      mapa.set(id, s);
      if (s.legado) legado = s;
      continue;
    }
    const s = m.caixa_id ? mapa.get(m.caixa_id) : legado;
    if (!s || s.fechamento) continue;
    if (m.tipo === 'fechamento') { s.fechamento = clean(m); if (s === legado) legado = null; } else s.movimentos.push(clean(m));
  }
  const lista = [...mapa.values()];
  const legados = lista.filter((s) => s.legado);
  for (const v of vendas) {
    if (v.status === 'cancelada') continue;
    const s = v.caixa_id ? mapa.get(v.caixa_id)
      : legados.find((x) => v.data >= x.abertura.data && (!x.fechamento || v.data <= x.fechamento.data));
    if (s) s.vendas.push(v);
  }
  return lista.map(resumoSessao);
}

async function statusCaixa() {
  const todas = await sessoesCaixa();
  const abertos = todas.filter((s) => s.aberto);
  const d = hoje();
  const fechadosHoje = todas.filter((s) => !s.aberto && s.fechamento.data.startsWith(d)).reverse();
  return {
    aberto: abertos.length > 0, abertos, fechadosHoje,
    totalAbertos: r2(abertos.reduce((x, s) => x + s.totalVendas, 0)),
  };
}

app.get('/api/caixa', wrap(async (req, res) => res.json(await statusCaixa())));

app.post('/api/caixa', wrap(async (req, res) => lock(async () => {
  const { tipo, obs, caixa_id } = req.body;
  const valor = r2(req.body.valor);
  if (!['abertura', 'suprimento', 'sangria', 'fechamento'].includes(tipo)) throw new HttpError(400, 'Operação inválida');
  if (valor < 0) throw new HttpError(400, 'Valor inválido');
  const st = await statusCaixa();

  if (tipo === 'abertura') {
    const operador = String(req.body.operador || '').trim().replace(/\s+/g, ' ');
    if (!operador) throw new HttpError(400, 'Informe o nome de quem vai operar o caixa');
    if (st.abertos.some((s) => s.operador.toLowerCase() === operador.toLowerCase())) throw new HttpError(400, `Já existe um caixa aberto em nome de ${operador}`);
    const id = novoId('C');
    await db.append('Caixa', [{ id, data: agora(), tipo, valor, obs: obs || '', caixa_id: id, operador }]);
    return res.json({ ok: true, caixa_id: id, operador });
  }

  const s = st.abertos.find((x) => x.caixa_id === caixa_id);
  if (!s) throw new HttpError(400, 'Caixa não encontrado ou já fechado');
  if (tipo === 'sangria' && valor > s.esperadoDinheiro) throw new HttpError(400, `Sangria maior que o dinheiro na gaveta (${s.esperadoDinheiro.toFixed(2)})`);
  let observacao = obs || '';
  if (tipo === 'fechamento') {
    const dif = r2(valor - s.esperadoDinheiro);
    observacao = `${s.operador} | Esperado R$ ${s.esperadoDinheiro.toFixed(2)} | Contado R$ ${valor.toFixed(2)} | Diferença R$ ${dif.toFixed(2)} | Vendas R$ ${s.totalVendas.toFixed(2)} (${s.vendasQtd})${obs ? ' | ' + obs : ''}`;
  }
  await db.append('Caixa', [{ id: novoId('C'), data: agora(), tipo, valor, obs: observacao, caixa_id: s.caixa_id, operador: s.operador }]);
  res.json({ ok: true, resumo: tipo === 'fechamento' ? { ...s, contado: valor, diferenca: r2(valor - s.esperadoDinheiro) } : undefined });
})));

/* ---------------- vendas ---------------- */
app.post('/api/vendas', wrap(async (req, res) => lock(async () => {
  const { itens, forma_pagamento, obs } = req.body;
  if (!Array.isArray(itens) || !itens.length) throw new HttpError(400, 'Carrinho vazio');
  const st = await statusCaixa();
  const caixa = req.body.caixa_id ? st.abertos.find((x) => x.caixa_id === req.body.caixa_id) : null;
  if (req.body.caixa_id && !caixa) throw new HttpError(400, 'Este caixa foi fechado. Escolha ou abra outro caixa.');
  if (EXIGIR_CAIXA && !caixa) throw new HttpError(400, st.abertos.length ? 'Escolha em qual caixa você está vendendo' : 'Abra um caixa antes de vender');
  const produtos = await db.all('Produtos');
  const data = agora();
  const id = novoId('V');
  const linhas = [], atualiza = [];
  let subtotal = 0, qtdTotal = 0;
  for (const it of itens) {
    const p = produtos.find((x) => x.id === it.produto_id && x.ativo);
    const q = Number(it.quantidade);
    if (!p) throw new HttpError(400, 'Produto não encontrado no carrinho');
    if (!(q > 0)) throw new HttpError(400, `Quantidade inválida para ${p.nome}`);
    if (process.env.PERMITIR_ESTOQUE_NEGATIVO !== 'true' && p.estoque < q) throw new HttpError(400, `Estoque insuficiente: ${p.nome} (disponível ${p.estoque})`);
    const total = r2(p.preco_venda * q);
    subtotal += total; qtdTotal += q;
    p.estoque = r2(p.estoque - q); p.atualizado_em = data;
    linhas.push({ venda_id: id, data, produto_id: p.id, codigo: p.codigo, nome: p.nome, quantidade: q, preco_unit: p.preco_venda, total });
    if (!atualiza.includes(p)) atualiza.push(p);
  }
  subtotal = r2(subtotal);
  const desconto = Math.min(r2(req.body.desconto), subtotal);
  const total = r2(subtotal - desconto);
  const forma = forma_pagamento || 'Dinheiro';
  let recebido = r2(req.body.valor_recebido || total);
  if (forma === 'Dinheiro' && recebido < total) throw new HttpError(400, 'Valor recebido menor que o total');
  if (forma !== 'Dinheiro') recebido = total;
  const venda = { id, data, subtotal, desconto, total, forma_pagamento: forma, valor_recebido: recebido, troco: r2(recebido - total), itens_qtd: qtdTotal, status: 'concluida', obs: obs || '',
    caixa_id: caixa ? caixa.caixa_id : '', operador: caixa ? caixa.operador : '' };

  await db.update(atualiza.map((p) => ({ sheet: 'Produtos', obj: p })));
  await db.append('Vendas', [venda]);
  await db.append('ItensVenda', linhas);
  res.status(201).json({ ...venda, itens: linhas });
})));

app.get('/api/vendas', wrap(async (req, res) => {
  const de = req.query.de || hoje(), ate = req.query.ate || hoje();
  const vendas = (await db.all('Vendas')).filter((v) => v.data.slice(0, 10) >= de && v.data.slice(0, 10) <= ate).map(clean).reverse();
  res.json(vendas);
}));

app.get('/api/vendas/:id', wrap(async (req, res) => {
  const v = (await db.all('Vendas')).find((x) => x.id === req.params.id);
  if (!v) throw new HttpError(404, 'Venda não encontrada');
  const itens = (await db.all('ItensVenda')).filter((i) => i.venda_id === v.id).map(clean);
  res.json({ ...clean(v), itens });
}));

app.post('/api/vendas/:id/cancelar', wrap(async (req, res) => lock(async () => {
  const v = (await db.all('Vendas')).find((x) => x.id === req.params.id);
  if (!v) throw new HttpError(404, 'Venda não encontrada');
  if (v.status === 'cancelada') throw new HttpError(400, 'Venda já cancelada');
  const itens = (await db.all('ItensVenda')).filter((i) => i.venda_id === v.id);
  const produtos = await db.all('Produtos');
  const data = agora(), movs = [], atualiza = [];
  for (const it of itens) {
    const p = produtos.find((x) => x.id === it.produto_id);
    if (!p) continue;
    p.estoque = r2(p.estoque + it.quantidade); p.atualizado_em = data;
    if (!atualiza.includes(p)) atualiza.push(p);
    movs.push({ id: novoId('M'), data, produto_id: p.id, nome: p.nome, tipo: 'entrada', quantidade: it.quantidade, estoque_apos: p.estoque, motivo: `Cancelamento da venda ${v.id}` });
  }
  v.status = 'cancelada'; v.obs = [v.obs, `Cancelada em ${data}${req.body.motivo ? ': ' + req.body.motivo : ''}`].filter(Boolean).join(' | ');
  await db.update([{ sheet: 'Vendas', obj: v }, ...atualiza.map((p) => ({ sheet: 'Produtos', obj: p }))]);
  await db.append('Movimentacoes', movs);
  res.json({ ok: true });
})));

/* ---------------- painel ---------------- */
app.get('/api/resumo', wrap(async (req, res) => {
  const [vendas, itens, produtos] = await Promise.all([db.all('Vendas'), db.all('ItensVenda'), db.all('Produtos')]);
  const ok = vendas.filter((v) => v.status !== 'cancelada');
  const d = hoje();
  const vendasHoje = ok.filter((v) => v.data.startsWith(d));
  const totalHoje = r2(vendasHoje.reduce((s, v) => s + v.total, 0));
  const ids = new Set(vendasHoje.map((v) => v.id));
  const porProduto = {};
  const itensHoje = itens.filter((i) => ids.has(i.venda_id));
  itensHoje.forEach((i) => { const k = i.nome; porProduto[k] = porProduto[k] || { nome: k, quantidade: 0, total: 0 }; porProduto[k].quantidade += i.quantidade; porProduto[k].total = r2(porProduto[k].total + i.total); });
  // lucro estimado de hoje (preço de custo atual)
  const custo = {}; produtos.forEach((p) => (custo[p.id] = p.preco_custo));
  const lucroHoje = r2(itensHoje.reduce((s, i) => s + i.total - (custo[i.produto_id] || 0) * i.quantidade, 0) - vendasHoje.reduce((s, v) => s + v.desconto, 0));
  // últimos 7 dias
  const dias = [];
  for (let k = 6; k >= 0; k--) {
    const dt = fmt.format(new Date(Date.now() - k * 86400000)).slice(0, 10);
    const vs = ok.filter((v) => v.data.startsWith(dt));
    dias.push({ dia: dt, total: r2(vs.reduce((s, v) => s + v.total, 0)), qtd: vs.length });
  }
  const ativos = produtos.filter((p) => p.ativo);
  res.json({
    hoje: d, totalHoje, qtdHoje: vendasHoje.length, ticketMedio: vendasHoje.length ? r2(totalHoje / vendasHoje.length) : 0, lucroHoje,
    topProdutos: Object.values(porProduto).sort((a, b) => b.quantidade - a.quantidade).slice(0, 5),
    estoqueBaixo: ativos.filter((p) => p.estoque <= p.estoque_minimo).map(clean).sort((a, b) => a.estoque - b.estoque),
    totalProdutos: ativos.length,
    valorEstoque: r2(ativos.reduce((s, p) => s + Math.max(p.estoque, 0) * p.preco_custo, 0)),
    ultimos7: dias,
  });
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

db.init()
  .then(() => app.listen(PORT, () => console.log(`✅ Caixa rodando na porta ${PORT} (banco: ${db.kind})`)))
  .catch((e) => { console.error('Falha ao conectar no banco:', e.message); process.exit(1); });
