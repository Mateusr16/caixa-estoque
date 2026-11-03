# Caixa & Estoque

Um sistema de PDV (frente de caixa) e controle de estoque bem simples, que usa o **Google Sheets como banco de dados** e é feito para rodar no **Render**.

## O que tem

- **PDV**: busca por nome ou código de barras (o leitor USB funciona direto), carrinho, desconto, formas de pagamento (Dinheiro/PIX/Débito/Crédito), cálculo de troco e cupom não fiscal para imprimir.
  - Atalhos: `F1` vai para o PDV, `F2` finaliza a venda, `Esc` limpa o carrinho.
  - Digitar `3*7891234567890` + Enter adiciona 3 unidades daquele código.
- **Produtos**: cadastro com código, categoria, custo, preço, margem, unidade e estoque mínimo.
- **Estoque**: entrada, saída e ajuste, com histórico completo. Toda venda baixa o estoque automaticamente.
- **Vendas**: filtro por período, totais por forma de pagamento, reimpressão e cancelamento (o estoque volta).
- **Caixa**: abertura com fundo de troco, sangria, suprimento e fechamento com conferência (valor esperado × valor contado).
- **Painel**: vendas do dia, ticket médio, lucro estimado, gráfico dos últimos 7 dias, mais vendidos e alertas de estoque baixo.
- Login por senha.

### Vários caixas ao mesmo tempo

- Na aba **Caixa**, cada pessoa abre o próprio caixa informando **o nome** e o fundo de troco. Podem ficar vários abertos ao mesmo tempo (não pode haver dois abertos com o mesmo nome).
- Cada computador lembra qual caixa está usando. O botão no topo (ou "Caixa: Nome ▾" no carrinho) troca de caixa. Se nenhum estiver escolhido, ao finalizar a venda o sistema pergunta em qual caixa registrar.
- Cada caixa tem as próprias sangrias, suprimentos e fechamento com conferência. A aba Caixa mostra quanto cada pessoa vendeu e a tabela **Caixas fechados hoje** (esperado × contado × diferença).
- O **Painel** continua mostrando sempre o total geral, somando todos os caixas. A aba **Vendas** ganhou a coluna "Caixa" com o nome do operador.
- Na planilha, as abas `Caixa` e `Vendas` ganharam as colunas `caixa_id` e `operador` no final (o cabeçalho é atualizado sozinho; dados antigos continuam valendo).

## Abas criadas automaticamente na planilha

| Aba | Conteúdo |
|---|---|
| `Produtos` | Cadastro e estoque atual |
| `Vendas` | Uma linha por venda |
| `ItensVenda` | Itens de cada venda |
| `Movimentacoes` | Histórico de entradas, saídas e ajustes |
| `Caixa` | Aberturas, sangrias, suprimentos e fechamentos |

> Você pode ler e filtrar os dados direto no Sheets e montar gráficos lá. **Evite editar à mão** as colunas `id` e `estoque`; para mudar o estoque, use a aba Estoque do sistema, que guarda o histórico.

---

## Passo a passo da configuração

### 1. Criar a conta de serviço no Google (uma vez só)

1. Acesse https://console.cloud.google.com e crie um projeto (por exemplo, "caixa").
2. Vá em **APIs e serviços → Biblioteca**, procure **Google Sheets API** e clique em **Ativar**.
3. Vá em **APIs e serviços → Credenciais → Criar credenciais → Conta de serviço**. Dê um nome e conclua.
4. Clique na conta criada, abra a aba **Chaves → Adicionar chave → Criar nova chave → JSON**. Um arquivo `.json` vai ser baixado. **Guarde-o com segurança.**
5. Copie o e-mail da conta de serviço (algo como `caixa@seu-projeto.iam.gserviceaccount.com`).

### 2. Preparar a planilha

1. Crie uma planilha em branco no Google Sheets.
2. Clique em **Compartilhar** e adicione o e-mail da conta de serviço como **Editor**.
3. Copie o ID da planilha, que fica na URL: `https://docs.google.com/spreadsheets/d/`**`ESTE_TRECHO_AQUI`**`/edit`

As abas e os cabeçalhos são criados sozinhos na primeira vez que o sistema inicia.

### 3. Subir no GitHub

```bash
git init
git add .
git commit -m "Caixa e estoque"
git branch -M main
git remote add origin https://github.com/Mateusr16/caixa-estoque.git
git push -u origin main
```

> O `.gitignore` já impede que o arquivo `.json` da credencial e o `.env` sejam enviados. **Nunca** coloque a chave no repositório.

### 4. Criar o serviço no Render

1. Em https://dashboard.render.com, clique em **New → Blueprint** e escolha o repositório. O `render.yaml` já configura tudo.
   *(ou **New → Web Service**: Build `npm install`, Start `npm start`.)*
2. Preencha as variáveis de ambiente:
   - `SHEET_ID`: o ID da planilha.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: abra o arquivo `.json` baixado e cole **o conteúdo inteiro**.
   - `APP_PASSWORD`: a senha para entrar no sistema.
3. Faça o deploy. Quando terminar, abra a URL `https://caixa-estoque-xxxx.onrender.com`.

Para conferir se está tudo certo, acesse `/api/health`. A resposta deve mostrar `"banco":"google-sheets"`.

### Variáveis opcionais

| Variável | Padrão | Para que serve |
|---|---|---|
| `TIMEZONE` | `America/Sao_Paulo` | Fuso usado nas datas |
| `EXIGIR_CAIXA_ABERTO` | `true` | Bloqueia vendas com o caixa fechado |
| `PERMITIR_ESTOQUE_NEGATIVO` | `false` | Permite vender sem estoque |
| `CACHE_SECONDS` | `20` | Cache de leitura, para respeitar o limite da API do Google |

---

## Rodar no seu computador

```bash
npm install
npm start          # abre em http://localhost:3000
```

Sem `SHEET_ID`, o sistema roda em **modo local**: os dados ficam em `data/local-db.json`. Serve para testar antes de ligar na planilha. Para usar a planilha localmente, crie um `.env` a partir do `.env.example` e rode `node --env-file=.env server.js`.

## Observações importantes

- **Plano grátis do Render**: o serviço "dorme" depois de cerca de 15 minutos sem uso, e o primeiro acesso seguinte pode levar uns 30 a 50 segundos. Para uso diário numa loja, o plano pago mais barato (Starter) mantém o sistema sempre ligado. Como os dados ficam no Sheets, nada se perde quando o serviço dorme.
- **Limites do Google**: a API do Sheets aceita cerca de 60 leituras por minuto. O cache interno resolve isso para uma loja pequena ou média (1 a 3 caixas).
- **Uma instância só**: as gravações são feitas em fila dentro do servidor. Mantenha 1 instância no Render, que já é o padrão.
- O cupom é **não fiscal**. Para emitir NFC-e, é preciso integrar um emissor fiscal.
