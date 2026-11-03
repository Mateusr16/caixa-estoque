/* ================= utilidades ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const brl = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (n) => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataBR = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) + ' ' + s.slice(11, 16) : '');
const hojeISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

let token = localStorage.getItem('token') || '';
async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { mostrarLogin(); throw new Error('Faça login'); }
  if (!res.ok) throw new Error(data.erro || 'Erro na requisição');
  return data;
}
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = 'toast'), 2800);
}
function modal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function fecharModal() { $('#modal').classList.add('hidden'); }
// No celular as tabelas viram "cartões": cada célula recebe o nome da coluna (data-label).
function rotular(alvo, principal = -1) {
  const t = typeof alvo === 'string' ? $(alvo) : alvo; if (!t) return;
  let cab = [];
  t.querySelectorAll('tr').forEach((tr) => {
    const cells = [...tr.children];
    if (cells.length && cells.every((c) => c.tagName === 'TH')) { tr.classList.add('cab'); cab = cells.map((c) => c.textContent.trim()); return; }
    cells.forEach((td, i) => { td.dataset.label = td.colSpan > 1 ? '' : cab[i] || ''; if (i === principal) td.classList.add('pri'); });
  });
  t.classList.add('resp');
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') fecharModal(); });

/* ================= estado ================= */
const S = { produtos: [], carrinho: [], forma: 'Dinheiro', categoria: '', caixa: null, config: {}, caixaId: localStorage.getItem('caixaId') || '' };

/* ================= login ================= */
function mostrarLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#loginSenha').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/login', { method: 'POST', body: { senha: $('#loginSenha').value } });
    token = r.token; localStorage.setItem('token', token);
    $('#login').classList.add('hidden'); iniciar();
  } catch (err) { $('#loginErro').textContent = err.message; }
});

/* ================= navegação ================= */
function irPara(tab) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + tab));
  ({ pdv: () => $('#pdvBusca').focus(), painel: carregarPainel, produtos: renderProdutos, estoque: carregarEstoque, vendas: carregarVendas, caixa: carregarCaixa }[tab] || (() => {}))();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.tab)));

async function carregarProdutos() { S.produtos = await api('/api/produtos'); renderPDV(); }

/* ================= PDV ================= */
function filtrados() {
  const q = $('#pdvBusca').value.trim().toLowerCase();
  return S.produtos.filter((p) => (!S.categoria || p.categoria === S.categoria) &&
    (!q || p.nome.toLowerCase().includes(q) || String(p.codigo).toLowerCase().includes(q)));
}
function renderPDV() {
  const cats = [...new Set(S.produtos.map((p) => p.categoria).filter(Boolean))].sort();
  $('#pdvCategorias').innerHTML = ['', ...cats].map((c) => `<button data-c="${esc(c)}" class="${c === S.categoria ? 'active' : ''}">${c ? esc(c) : 'Todos'}</button>`).join('');
  const lista = filtrados();
  $('#pdvGrid').innerHTML = lista.length ? lista.map((p, i) => `
    <button class="prod ${p.estoque <= 0 ? 'zero' : ''} ${i === 0 && $('#pdvBusca').value ? 'sel' : ''}" data-id="${p.id}">
      <div class="n">${esc(p.nome)}</div>
      <div class="p">${brl(p.preco_venda)}</div>
      <div class="e">${p.codigo ? esc(p.codigo) + ' · ' : ''}${num(p.estoque)} ${esc(p.unidade || 'un')}</div>
    </button>`).join('') : `<div class="vazio">Nenhum produto. ${S.produtos.length ? '' : 'Cadastre na aba <b>Produtos</b>.'}</div>`;
}
$('#pdvCategorias').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.categoria = b.dataset.c; renderPDV(); });
$('#pdvGrid').addEventListener('click', (e) => { const b = e.target.closest('.prod'); if (b) adicionar(b.dataset.id); });
$('#pdvBusca').addEventListener('input', renderPDV);
$('#pdvBusca').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = e.target.value.trim();
  if (!q) return;
  // leitor de código de barras: correspondência exata primeiro; "3*codigo" define quantidade
  let codigo = q, qtd = null;
  const m = q.match(/^(\d+(?:[.,]\d+)?)\*(.+)$/);
  if (m) { qtd = Number(m[1].replace(',', '.')); codigo = m[2].trim(); }
  const exato = S.produtos.find((p) => p.codigo && p.codigo.toLowerCase() === codigo.toLowerCase());
  const p = exato || filtrados()[0];
  if (!p) return toast('Produto não encontrado', true);
  adicionar(p.id, qtd);
});

function adicionar(id, qtd) {
  const p = S.produtos.find((x) => x.id === id); if (!p) return;
  const q = qtd || Number($('#pdvQtd').value) || 1;
  const it = S.carrinho.find((i) => i.produto_id === id);
  const novaQtd = (it ? it.quantidade : 0) + q;
  if (novaQtd > p.estoque) toast(`Atenção: estoque de ${p.nome} é ${num(p.estoque)}`, true);
  if (it) it.quantidade = novaQtd; else S.carrinho.push({ produto_id: id, quantidade: q });
  $('#pdvBusca').value = ''; $('#pdvQtd').value = 1;
  renderPDV(); renderCarrinho(); $('#pdvBusca').focus();
}
function calc() {
  const subtotal = S.carrinho.reduce((s, i) => { const p = S.produtos.find((x) => x.id === i.produto_id); return s + (p ? p.preco_venda * i.quantidade : 0); }, 0);
  const desconto = Math.min(Number($('#cDesconto').value) || 0, subtotal);
  const total = Math.round((subtotal - desconto) * 100) / 100;
  const recebido = Number($('#cRecebido').value) || 0;
  return { subtotal, desconto, total, recebido, troco: S.forma === 'Dinheiro' && recebido ? recebido - total : 0 };
}
function renderCarrinho() {
  $('#carrinho').innerHTML = S.carrinho.length ? S.carrinho.map((i, idx) => {
    const p = S.produtos.find((x) => x.id === i.produto_id) || { nome: '?', preco_venda: 0 };
    return `<div class="item">
      <div><div class="n">${esc(p.nome)}</div><div class="u">${brl(p.preco_venda)} / ${esc(p.unidade || 'un')}</div></div>
      <div class="q"><button data-a="-" data-i="${idx}">−</button><input data-i="${idx}" type="number" step="any" min="0" value="${i.quantidade}"><button data-a="+" data-i="${idx}">+</button></div>
      <div style="display:flex;align-items:center;gap:4px"><span class="t">${brl(p.preco_venda * i.quantidade)}</span><button class="x" data-a="x" data-i="${idx}" title="Remover">✕</button></div>
    </div>`;
  }).join('') : '<div class="vazio">Carrinho vazio<br><span class="muted">Leia um código ou clique num produto</span></div>';
  const c = calc();
  $('#cSubtotal').textContent = brl(c.subtotal);
  $('#cTotal').textContent = brl(c.total);
  if (c.total > 0) $('#btnFinalizar').dataset.total = brl(c.total); else delete $('#btnFinalizar').dataset.total;
  $('#cTroco').textContent = brl(Math.max(c.troco, 0));
  $('#cTroco').style.color = c.troco < 0 ? 'var(--red)' : '';
  $('#boxRecebido').style.display = S.forma === 'Dinheiro' ? '' : 'none';
  $('.troco').style.display = S.forma === 'Dinheiro' ? '' : 'none';
}
$('#carrinho').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const i = Number(b.dataset.i), it = S.carrinho[i];
  if (b.dataset.a === '+') it.quantidade += 1;
  if (b.dataset.a === '-') it.quantidade = Math.max(0, it.quantidade - 1);
  if (b.dataset.a === 'x' || it.quantidade <= 0) S.carrinho.splice(i, 1);
  renderCarrinho();
});
$('#carrinho').addEventListener('change', (e) => {
  if (e.target.tagName !== 'INPUT') return;
  const i = Number(e.target.dataset.i), v = Number(e.target.value);
  if (v > 0) S.carrinho[i].quantidade = v; else S.carrinho.splice(i, 1);
  renderCarrinho();
});
$('#cDesconto').addEventListener('input', renderCarrinho);
$('#cRecebido').addEventListener('input', renderCarrinho);
$('#formas').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.forma = b.dataset.forma;
  $$('#formas button').forEach((x) => x.classList.toggle('active', x === b));
  renderCarrinho();
});
function limparCarrinho() { S.carrinho = []; $('#cDesconto').value = 0; $('#cRecebido').value = ''; renderCarrinho(); $('#pdvBusca').focus(); }
$('#btnLimpar').addEventListener('click', limparCarrinho);

async function finalizar() {
  if (!S.carrinho.length) return toast('Carrinho vazio', true);
  if (!meuCaixa()) {
    await atualizarBadge();
    if (!meuCaixa() && (S.config.exigirCaixa || (S.caixa && S.caixa.abertos.length))) return escolherCaixa(true);
  }
  const c = calc();
  if (S.forma === 'Dinheiro' && c.recebido && c.recebido < c.total) return toast('Valor recebido menor que o total', true);
  const btn = $('#btnFinalizar'); btn.disabled = true; btn.textContent = 'Salvando...';
  try {
    const v = await api('/api/vendas', { method: 'POST', body: { itens: S.carrinho, desconto: c.desconto, forma_pagamento: S.forma, valor_recebido: c.recebido || c.total, caixa_id: S.caixaId || undefined } });
    limparCarrinho();
    await carregarProdutos();
    atualizarBadge();
    mostrarCupom(v);
  } catch (err) { toast(err.message, true); if (/caixa/i.test(err.message)) atualizarBadge(); }
  finally { btn.disabled = false; btn.innerHTML = 'Finalizar venda <kbd>F2</kbd>'; }
}
$('#btnFinalizar').addEventListener('click', finalizar);

function textoCupom(v) {
  const L = 40, line = '-'.repeat(L);
  const pad = (a, b) => a + ' '.repeat(Math.max(1, L - a.length - b.length)) + b;
  const centro = (x) => ' '.repeat(Math.max(0, Math.floor((L - x.length) / 2))) + x;
  let t = `${centro('PARÓQUIA')}\n${centro('NOSSA SENHORA DO LÍBANO')}\n${centro('Carmo do Cajuru - MG')}\n${line}\n${centro('CUPOM NÃO FISCAL')}\n${line}\nVenda: ${v.id}\nData: ${dataBR(v.data)}\n${v.operador ? `Caixa: ${v.operador}\n` : ''}${line}\n`;
  v.itens.forEach((i) => { t += `${i.nome.slice(0, L)}\n${pad(`  ${num(i.quantidade)} x ${brl(i.preco_unit)}`, brl(i.total))}\n`; });
  t += `${line}\n${pad('Subtotal', brl(v.subtotal))}\n`;
  if (v.desconto) t += `${pad('Desconto', '-' + brl(v.desconto))}\n`;
  t += `${pad('TOTAL', brl(v.total))}\n${pad('Pagamento', v.forma_pagamento)}\n`;
  if (v.forma_pagamento === 'Dinheiro') t += `${pad('Recebido', brl(v.valor_recebido))}\n${pad('Troco', brl(v.troco))}\n`;
  if (v.status === 'cancelada') t += `\n*** VENDA CANCELADA ***\n`;
  return t + `${line}\n${centro('Obrigado pela sua colaboração!')}\n${centro('Deus lhe abençoe.')}`;
}
function mostrarCupom(v, extra = '') {
  modal(`<h3>✅ Venda ${v.status === 'cancelada' ? '(cancelada)' : 'registrada'} — ${brl(v.total)}</h3>
    ${v.forma_pagamento === 'Dinheiro' && v.troco ? `<p style="font-size:22px;font-weight:800;color:var(--pri)">Troco: ${brl(v.troco)}</p>` : ''}
    <div class="cupom print-area">${esc(textoCupom(v))}</div>
    <div class="modal-acoes">${extra}<button class="btn" onclick="window.print()">🖨️ Imprimir</button><button class="btn primary" id="okCupom" onclick="fecharModal();document.querySelector('#pdvBusca').focus()">OK (Enter)</button></div>`);
  setTimeout(() => $('#okCupom') && $('#okCupom').focus(), 50);
}

/* ================= atalhos ================= */
document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') { e.preventDefault(); irPara('pdv'); }
  if (e.key === 'F2') { e.preventDefault(); if ($('#tab-pdv').classList.contains('active')) finalizar(); }
  if (e.key === 'Escape') { if (!$('#modal').classList.contains('hidden')) fecharModal(); else if ($('#tab-pdv').classList.contains('active')) limparCarrinho(); }
});

/* ================= produtos ================= */
function renderProdutos() {
  const q = $('#prodBusca').value.trim().toLowerCase();
  const lista = S.produtos.filter((p) => !q || p.nome.toLowerCase().includes(q) || String(p.codigo).toLowerCase().includes(q) || p.categoria.toLowerCase().includes(q));
  $('#tabProdutos').innerHTML = `<tr><th>Código</th><th>Produto</th><th>Categoria</th><th class="num">Custo</th><th class="num">Venda</th><th class="num">Margem</th><th class="num">Estoque</th><th></th></tr>` +
    (lista.map((p) => {
      const margem = p.preco_venda ? ((p.preco_venda - p.preco_custo) / p.preco_venda) * 100 : 0;
      const tag = p.estoque <= 0 ? 'red' : p.estoque <= p.estoque_minimo ? 'amber' : 'green';
      return `<tr><td>${esc(p.codigo)}</td><td><b>${esc(p.nome)}</b></td><td>${esc(p.categoria)}</td>
        <td class="num">${brl(p.preco_custo)}</td><td class="num">${brl(p.preco_venda)}</td><td class="num">${p.preco_custo ? margem.toFixed(0) + '%' : '—'}</td>
        <td class="num"><span class="tag ${tag}">${num(p.estoque)} ${esc(p.unidade)}</span></td>
        <td class="num"><button class="btn sm" data-edit="${p.id}">Editar</button> <button class="btn sm" data-mov="${p.id}">Estoque</button></td></tr>`;
    }).join('') || `<tr><td colspan="8" class="vazio">Nenhum produto cadastrado</td></tr>`);
  rotular('#tabProdutos', 1);
}
$('#prodBusca').addEventListener('input', renderProdutos);
$('#btnNovoProd').addEventListener('click', () => formProduto());
$('#tabProdutos').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.edit) formProduto(S.produtos.find((p) => p.id === b.dataset.edit));
  if (b.dataset.mov) { irPara('estoque'); $('#movProduto').value = b.dataset.mov; infoMov(); $('#movQtd').focus(); }
});

function formProduto(p) {
  const novo = !p; p = p || { unidade: 'un', estoque: 0, estoque_minimo: 0 };
  const cats = [...new Set(S.produtos.map((x) => x.categoria).filter(Boolean))];
  modal(`<h3>${novo ? 'Novo produto' : 'Editar produto'}</h3>
    <form id="fProd" class="form-grid">
      <label class="span2">Nome*<input name="nome" required value="${esc(p.nome)}"></label>
      <label>Código / cód. barras<input name="codigo" value="${esc(p.codigo)}"></label>
      <label>Categoria<input name="categoria" list="cats" value="${esc(p.categoria)}"><datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label>Preço de custo (R$)<input name="preco_custo" type="number" step="0.01" min="0" value="${p.preco_custo ?? ''}"></label>
      <label>Preço de venda (R$)*<input name="preco_venda" type="number" step="0.01" min="0" required value="${p.preco_venda ?? ''}"></label>
      ${novo ? `<label>Estoque inicial<input name="estoque" type="number" step="any" value="0"></label>` : `<label>Estoque atual<input disabled value="${num(p.estoque)}" title="Altere pela aba Estoque"></label>`}
      <label>Estoque mínimo (alerta)<input name="estoque_minimo" type="number" step="any" min="0" value="${p.estoque_minimo}"></label>
      <label>Unidade<select name="unidade">${['un', 'kg', 'g', 'L', 'ml', 'cx', 'pct', 'm'].map((u) => `<option ${u === p.unidade ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <div class="span2 modal-acoes">
        ${novo ? '' : '<button type="button" class="btn danger" id="btnExcluir" style="margin-right:auto">Excluir</button>'}
        <button type="button" class="btn" onclick="fecharModal()">Cancelar</button>
        <button class="btn primary">Salvar</button>
      </div>
    </form>`);
  $('#fProd [name=nome]').focus();
  $('#fProd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      await api(novo ? '/api/produtos' : '/api/produtos/' + p.id, { method: novo ? 'POST' : 'PUT', body });
      fecharModal(); toast('Produto salvo'); await carregarProdutos(); renderProdutos();
    } catch (err) { toast(err.message, true); }
  });
  if (!novo) $('#btnExcluir').addEventListener('click', async () => {
    if (!confirm(`Excluir "${p.nome}"? O histórico de vendas é mantido.`)) return;
    try { await api('/api/produtos/' + p.id, { method: 'DELETE' }); fecharModal(); toast('Produto excluído'); await carregarProdutos(); renderProdutos(); }
    catch (err) { toast(err.message, true); }
  });
}

/* ================= estoque ================= */
async function carregarEstoque() {
  const sel = $('#movProduto'), atual = sel.value;
  sel.innerHTML = '<option value="">Selecione...</option>' + S.produtos.map((p) => `<option value="${p.id}">${esc(p.nome)}${p.codigo ? ' (' + esc(p.codigo) + ')' : ''}</option>`).join('');
  sel.value = atual; infoMov();
  const movs = await api('/api/movimentacoes?limit=150');
  $('#tabMov').innerHTML = `<tr><th>Data</th><th>Produto</th><th>Tipo</th><th class="num">Qtd</th><th class="num">Saldo</th><th>Motivo</th></tr>` +
    (movs.map((m) => `<tr><td>${dataBR(m.data)}</td><td>${esc(m.nome)}</td><td><span class="tag ${m.tipo === 'entrada' ? 'green' : m.tipo === 'saida' ? 'red' : 'amber'}">${m.tipo}</span></td>
      <td class="num">${m.quantidade > 0 ? '+' : ''}${num(m.quantidade)}</td><td class="num">${num(m.estoque_apos)}</td><td class="muted">${esc(m.motivo)}</td></tr>`).join('') ||
      '<tr><td colspan="6" class="vazio">Sem movimentações</td></tr>');
  rotular('#tabMov', 1);
}
function infoMov() {
  const p = S.produtos.find((x) => x.id === $('#movProduto').value);
  $('#movInfo').textContent = p ? `Estoque atual: ${num(p.estoque)} ${p.unidade}` : '';
  $('#movQtdLabel').textContent = $('#movTipo').value === 'ajuste' ? 'Nova quantidade em estoque' : 'Quantidade';
}
$('#movProduto').addEventListener('change', infoMov);
$('#movTipo').addEventListener('change', infoMov);
$('#formMov').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/estoque/movimentar', { method: 'POST', body: { produto_id: $('#movProduto').value, tipo: $('#movTipo').value, quantidade: $('#movQtd').value, motivo: $('#movMotivo').value } });
    toast('Movimentação registrada'); $('#movQtd').value = ''; $('#movMotivo').value = '';
    await carregarProdutos(); carregarEstoque();
  } catch (err) { toast(err.message, true); }
});

/* ================= vendas ================= */
async function carregarVendas() {
  if (!$('#vDe').value) { $('#vDe').value = hojeISO(); $('#vAte').value = hojeISO(); }
  const vendas = await api(`/api/vendas?de=${$('#vDe').value}&ate=${$('#vAte').value}`);
  const ok = vendas.filter((v) => v.status !== 'cancelada');
  const porForma = {};
  ok.forEach((v) => (porForma[v.forma_pagamento] = (porForma[v.forma_pagamento] || 0) + v.total));
  $('#vendasTotais').innerHTML = `<b>${ok.length}</b> vendas · <b>${brl(ok.reduce((s, v) => s + v.total, 0))}</b> · ` + Object.entries(porForma).map(([f, t]) => `${f}: ${brl(t)}`).join(' · ');
  $('#tabVendas').innerHTML = `<tr><th>Data</th><th>Venda</th><th>Caixa</th><th class="num">Itens</th><th>Pagamento</th><th class="num">Desconto</th><th class="num">Total</th><th>Status</th><th></th></tr>` +
    (vendas.map((v) => `<tr class="${v.status}"><td>${dataBR(v.data)}</td><td class="muted">${v.id}</td><td>${esc(v.operador) || '<span class="muted">—</span>'}</td><td class="num">${num(v.itens_qtd)}</td><td>${esc(v.forma_pagamento)}</td>
      <td class="num">${v.desconto ? brl(v.desconto) : '—'}</td><td class="num"><b>${brl(v.total)}</b></td>
      <td><span class="tag ${v.status === 'cancelada' ? 'red' : 'green'}">${v.status}</span></td><td class="num"><button class="btn sm" data-v="${v.id}">Ver</button></td></tr>`).join('') ||
      '<tr><td colspan="9" class="vazio">Nenhuma venda no período</td></tr>');
  rotular('#tabVendas');
}
$('#btnFiltrarVendas').addEventListener('click', carregarVendas);
$('#tabVendas').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  const v = await api('/api/vendas/' + b.dataset.v);
  mostrarCupom(v, v.status !== 'cancelada' ? `<button class="btn danger" id="btnCancelarVenda" style="margin-right:auto">Cancelar venda</button>` : '');
  const bc = $('#btnCancelarVenda');
  if (bc) bc.addEventListener('click', async () => {
    const motivo = prompt('Motivo do cancelamento (o estoque será devolvido):');
    if (motivo === null) return;
    try { await api(`/api/vendas/${v.id}/cancelar`, { method: 'POST', body: { motivo } }); fecharModal(); toast('Venda cancelada'); await carregarProdutos(); carregarVendas(); }
    catch (err) { toast(err.message, true); }
  });
});

/* ================= caixa (vários caixas) ================= */
// Cada computador lembra qual caixa está usando (localStorage). Vários caixas podem estar abertos ao mesmo tempo.
const meuCaixa = () => (S.caixa && S.caixa.abertos.find((c) => c.caixa_id === S.caixaId)) || null;
function usarCaixa(id) {
  S.caixaId = id || '';
  if (id) localStorage.setItem('caixaId', id); else localStorage.removeItem('caixaId');
  renderBadge();
}

async function atualizarBadge() {
  try { S.caixa = await api('/api/caixa'); } catch (e) { return; }
  if (S.caixaId && !meuCaixa()) usarCaixa(''); // caixa foi fechado
  renderBadge();
}
function renderBadge() {
  const b = $('#caixaBadge'), op = $('#pdvOperador'), m = meuCaixa(), n = S.caixa ? S.caixa.abertos.length : 0;
  if (m) {
    b.className = 'badge ok'; b.textContent = `● ${m.operador} · ${brl(m.totalVendas)}`;
    op.className = 'operador'; op.textContent = `Caixa: ${m.operador} ▾`;
  } else if (n) {
    b.className = 'badge escolher'; b.textContent = `● Escolher caixa (${n} aberto${n > 1 ? 's' : ''})`;
    op.className = 'operador falta'; op.textContent = 'Escolher caixa ▾';
  } else {
    b.className = 'badge off'; b.textContent = '● Nenhum caixa aberto';
    op.className = 'operador falta'; op.textContent = 'Abrir caixa ▸';
  }
}
function escolherCaixa(paraVender) {
  const abertos = S.caixa ? S.caixa.abertos : [];
  if (!abertos.length) { if (paraVender) toast('Abra um caixa antes de vender', true); return irPara('caixa'); }
  modal(`<h3>Em qual caixa você está?</h3>
    <p class="muted">${paraVender ? 'Escolha o caixa para registrar esta venda. ' : ''}Este computador vai lembrar da escolha.</p>
    <div class="lista-caixas">${abertos.map((c) => `<button data-cx="${c.caixa_id}" class="${c.caixa_id === S.caixaId ? 'sel' : ''}">
      <span><span class="nm">${esc(c.operador)}</span><br><span class="muted">aberto ${dataBR(c.abertura.data)} · ${c.vendasQtd} vendas</span></span><b>${brl(c.totalVendas)}</b></button>`).join('')}</div>
    <div class="modal-acoes"><button class="btn" id="cxNovo" style="margin-right:auto">+ Abrir outro caixa</button><button class="btn" onclick="fecharModal()">Cancelar</button></div>`);
  $$('.lista-caixas button').forEach((bt) => bt.addEventListener('click', () => {
    usarCaixa(bt.dataset.cx); fecharModal(); toast('Usando o caixa de ' + meuCaixa().operador);
    if (paraVender) finalizar(); else if ($('#tab-caixa').classList.contains('active')) carregarCaixa(); else $('#pdvBusca').focus();
  }));
  $('#cxNovo').addEventListener('click', () => { fecharModal(); irPara('caixa'); $('#abNome').focus(); });
  setTimeout(() => { const f = $('.lista-caixas button.sel') || $('.lista-caixas button'); f && f.focus(); }, 50);
}
$('#caixaBadge').addEventListener('click', () => (S.caixa && S.caixa.abertos.length ? escolherCaixa() : irPara('caixa')));
$('#caixaBadge').style.cursor = 'pointer';
$('#pdvOperador').addEventListener('click', () => escolherCaixa());

function tabelaCaixa(c) {
  return `<table>
    <tr><td>Fundo de troco</td><td class="num">${brl(c.abertura.valor)}</td></tr>
    <tr><td>Vendas (${c.vendasQtd})</td><td class="num"><b>${brl(c.totalVendas)}</b></td></tr>
    ${Object.entries(c.porForma).map(([f, t]) => `<tr><td class="muted">&nbsp;&nbsp;${esc(f)}</td><td class="num muted">${brl(t)}</td></tr>`).join('')}
    ${c.suprimentos ? `<tr><td>Suprimentos</td><td class="num">+ ${brl(c.suprimentos)}</td></tr>` : ''}
    ${c.sangrias ? `<tr><td>Sangrias</td><td class="num">− ${brl(c.sangrias)}</td></tr>` : ''}
    <tr><td><b>Dinheiro esperado na gaveta</b></td><td class="num"><b style="font-size:17px;color:var(--azul)">${brl(c.esperadoDinheiro)}</b></td></tr>
  </table>`;
}

async function carregarCaixa() {
  await atualizarBadge();
  const { abertos, fechadosHoje, totalAbertos } = S.caixa;
  $('#caixasAbertos').innerHTML = `<h3>Caixas abertos</h3>` + (abertos.length ? `
    ${abertos.length > 1 ? `<div class="total-geral"><span>Total dos ${abertos.length} caixas abertos</span><b>${brl(totalAbertos)}</b></div>` : ''}
    ${abertos.map((c) => { const meu = c.caixa_id === S.caixaId; return `<div class="cx ${meu ? 'meu' : ''}">
      <div class="cx-topo"><span class="cx-nome">${esc(c.operador)}</span>
        ${meu ? '<span class="tag green">Neste computador</span>' : `<button class="btn sm" data-usar="${c.caixa_id}">Usar neste computador</button>`}</div>
      <div class="muted" style="margin-bottom:6px">Aberto em ${dataBR(c.abertura.data)}</div>
      ${tabelaCaixa(c)}
      <div class="cx-acoes">
        <button class="btn sm" data-op="suprimento" data-cx="${c.caixa_id}">+ Suprimento</button>
        <button class="btn sm" data-op="sangria" data-cx="${c.caixa_id}">− Sangria</button>
        <button class="btn sm primary" data-op="fechamento" data-cx="${c.caixa_id}">Fechar caixa</button>
      </div></div>`; }).join('')}`
    : '<div class="vazio">Nenhum caixa aberto.<br><span class="muted">Abra um caixa ao lado para começar a vender.</span></div>');

  $('#tabFechados').innerHTML = `<tr><th>Operador</th><th>Aberto</th><th>Fechado</th><th class="num">Vendas</th><th class="num">Total vendido</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferença</th></tr>` +
    (fechadosHoje.map((c) => `<tr><td><b>${esc(c.operador)}</b></td><td>${dataBR(c.abertura.data)}</td><td>${dataBR(c.fechamento.data)}</td>
      <td class="num">${c.vendasQtd}</td><td class="num"><b>${brl(c.totalVendas)}</b></td><td class="num">${brl(c.esperadoDinheiro)}</td><td class="num">${brl(c.contado)}</td>
      <td class="num"><span class="tag ${c.diferenca < 0 ? 'red' : c.diferenca > 0 ? 'amber' : 'green'}">${brl(c.diferenca)}</span></td></tr>`).join('') ||
      '<tr><td colspan="8" class="vazio">Nenhum caixa fechado hoje</td></tr>');
  rotular('#tabFechados', 0);
}

$('#caixasAbertos').addEventListener('click', (e) => {
  const u = e.target.closest('[data-usar]');
  if (u) { usarCaixa(u.dataset.usar); toast('Usando o caixa de ' + meuCaixa().operador); return carregarCaixa(); }
  const b = e.target.closest('[data-op]'); if (!b) return;
  const c = S.caixa.abertos.find((x) => x.caixa_id === b.dataset.cx); if (!c) return;
  const tipo = b.dataset.op;
  const titulo = { suprimento: 'Suprimento (entrada de dinheiro)', sangria: 'Sangria (retirada de dinheiro)', fechamento: 'Fechar caixa' }[tipo];
  const label = { suprimento: 'Valor colocado na gaveta (R$)', sangria: 'Valor retirado (R$)', fechamento: 'Dinheiro contado na gaveta (R$)' }[tipo];
  modal(`<h3>${titulo} — ${esc(c.operador)}</h3>
    ${tipo === 'fechamento' ? `<p class="muted">Conte o dinheiro da gaveta e informe abaixo. Vendido neste caixa: <b>${brl(c.totalVendas)}</b> (${c.vendasQtd} vendas).</p>` : ''}
    <form id="fOpCaixa">
      <label>${label}<input id="opValor" type="number" step="0.01" min="0" required></label>
      <label>Observação<input id="opObs"></label>
      <div class="modal-acoes"><button type="button" class="btn" onclick="fecharModal()">Cancelar</button><button class="btn primary">Confirmar</button></div>
    </form>`);
  setTimeout(() => $('#opValor').focus(), 50);
  $('#fOpCaixa').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('/api/caixa', { method: 'POST', body: { tipo, caixa_id: c.caixa_id, valor: $('#opValor').value, obs: $('#opObs').value } });
      if (r.resumo) {
        const d = r.resumo.diferenca;
        if (c.caixa_id === S.caixaId) usarCaixa('');
        modal(`<h3>Caixa de ${esc(c.operador)} fechado</h3><table>
          <tr><td>Total de vendas</td><td class="num"><b>${brl(r.resumo.totalVendas)}</b> (${r.resumo.vendasQtd})</td></tr>
          ${Object.entries(r.resumo.porForma).map(([f, t]) => `<tr><td>${esc(f)}</td><td class="num">${brl(t)}</td></tr>`).join('')}
          <tr><td>Dinheiro esperado</td><td class="num">${brl(r.resumo.esperadoDinheiro)}</td></tr>
          <tr><td>Dinheiro contado</td><td class="num">${brl(r.resumo.contado)}</td></tr>
          <tr><td><b>Diferença</b></td><td class="num"><b style="color:${d < 0 ? 'var(--red)' : 'var(--azul)'}">${brl(d)}</b></td></tr></table>
          <div class="modal-acoes"><button class="btn primary" onclick="fecharModal()">OK</button></div>`);
      } else { fecharModal(); toast('Operação registrada'); }
      carregarCaixa();
    } catch (err) { toast(err.message, true); }
  });
});

$('#formAbrir').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/caixa', { method: 'POST', body: { tipo: 'abertura', operador: $('#abNome').value, valor: $('#abValor').value, obs: $('#abObs').value } });
    $('#abNome').value = ''; $('#abValor').value = 0; $('#abObs').value = '';
    await atualizarBadge(); usarCaixa(r.caixa_id);
    toast(`Caixa de ${r.operador} aberto`);
    carregarCaixa();
  } catch (err) { toast(err.message, true); }
});

/* ================= painel ================= */
async function carregarPainel() {
  const r = await api('/api/resumo');
  $('#kpis').innerHTML = [
    ['Vendido hoje', brl(r.totalHoje)], ['Nº de vendas', r.qtdHoje], ['Ticket médio', brl(r.ticketMedio)],
    ['Lucro estimado', brl(r.lucroHoje)], ['Produtos ativos', r.totalProdutos], ['Estoque (a custo)', brl(r.valorEstoque)],
  ].map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  const max = Math.max(...r.ultimos7.map((d) => d.total), 1);
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  $('#grafico').innerHTML = r.ultimos7.map((d) => `<div class="bar"><span class="vv">${d.total ? brl(d.total).replace(',00', '') : ''}</span><div class="b" style="height:${(d.total / max) * 100}%"></div><span class="d">${dias[new Date(d.dia + 'T12:00').getDay()]} ${d.dia.slice(8)}</span></div>`).join('');
  $('#top').innerHTML = r.topProdutos.length ? `<table>${r.topProdutos.map((p) => `<tr><td>${esc(p.nome)}</td><td class="num">${num(p.quantidade)}</td><td class="num">${brl(p.total)}</td></tr>`).join('')}</table>` : '<div class="vazio">Nenhuma venda hoje</div>';
  $('#baixo').innerHTML = r.estoqueBaixo.length ? `<table><tr><th>Produto</th><th class="num">Estoque</th><th class="num">Mínimo</th></tr>${r.estoqueBaixo.map((p) => `<tr><td>${esc(p.nome)}</td><td class="num"><span class="tag ${p.estoque <= 0 ? 'red' : 'amber'}">${num(p.estoque)}</span></td><td class="num">${num(p.estoque_minimo)}</td></tr>`).join('')}</table>` : '<div class="vazio">Tudo em ordem 👍</div>';
  rotular($('#baixo table'), 0);
}

/* ================= início ================= */
// Mede topo e rodapé para o PDV caber exatamente na janela (sem botões escondidos atrás do rodapé).
function medirLayout() {
  const r = document.documentElement.style;
  r.setProperty('--topo-h', $('.topbar').offsetHeight + 'px');
  r.setProperty('--rodape-h', $('.rodape').offsetHeight + 'px');
}
if (window.ResizeObserver) { const ro = new ResizeObserver(medirLayout); ro.observe($('.topbar')); ro.observe($('.rodape')); }
window.addEventListener('resize', medirLayout);
async function iniciar() {
  try {
    S.config = await api('/api/config');
    $('#app').classList.remove('hidden');
    medirLayout();
    await Promise.all([carregarProdutos(), atualizarBadge()]);
    renderCarrinho();
    if (S.config.exigirCaixa && S.caixa && !meuCaixa()) toast(S.caixa.abertos.length ? 'Escolha em qual caixa você está (botão no topo)' : 'Nenhum caixa aberto — abra na aba Caixa para vender');
    $('#pdvBusca').focus();
  } catch (e) { if (e.message !== 'Faça login') toast(e.message, true); }
}
iniciar();
