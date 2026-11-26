# My Little Pier · API

Backend em NestJS com PostgreSQL e Prisma. O jogador entra pelo Google Play Games ou Apple Game Center, consulta o perfil e compra melhorias com moedas. Cada instalação desta API usa seu próprio banco, segredo JWT e credenciais de plataforma.

## Rodar localmente

Use Node.js 22.12 ou superior da série 22 e um banco PostgreSQL vazio dedicado ao jogo.

```sh
npm ci
cp .env.example .env
openssl rand -hex 32
```

Coloque o valor gerado em `JWT_SECRET` e a conexão do banco em `DATABASE_URL`. Para Android, preencha `GOOGLE_PLAY_GAMES_CLIENT_ID` e `GOOGLE_PLAY_GAMES_CLIENT_SECRET` com o cliente OAuth **Web** associado ao Play Games de `com.kumagames.mylittlepier`. No iOS, `APPLE_GAMECENTER_BUNDLE_ID` deve coincidir com o bundle assinado. O valor no exemplo é o do projeto Unity, `com.fishia.mylittlepier`.

```sh
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

A API atende em `http://localhost:3000`. No emulador Android, o host é `10.0.2.2`. Para publicar na Vercel, crie um projeto para este repositório e configure as variáveis por ambiente. Use um banco próprio também para previews. O comando `vercel-build` gera o cliente Prisma, aplica as migrações e compila a API.

## Contrato para o Unity

As chamadas com sessão usam `Authorization: Bearer <accessToken>`. Nos dois logins, a primeira chamada cria a conta. O próximo login com a mesma identidade recupera o mesmo `playerId`. Google e Apple têm contas independentes nesta versão. O campo opcional `name` define o nome na criação.

| Rota | Entrada | Resposta |
| --- | --- | --- |
| `POST /users/google` | `authToken` com o código de acesso ao servidor fornecido pelo Play Games | `playerId`, `accessToken`, `expiresIn`, `refreshToken`, `refreshExpiresAt`, `refreshExpiresIn` |
| `POST /users/apple` | `playerId` com o `teamPlayerID`, `publicKeyUrl`, `signature` e `salt` em Base64, `timestamp` em milissegundos | Mesmos campos do login Google |
| `POST /auth/refresh` | `refreshToken` | Novos tokens e prazos de expiração |
| `POST /auth/logout` | Com sessão, envie `refreshToken` do aparelho ou `allDevices: true` | HTTP 204. O token de acesso expira no prazo original |
| `GET /users/me` | Sessão | `id`, `name`, `createdAt`, `coins` e `ownedItemIds` |
| `GET /shop` | Sessão | Lista de produtos com `itemId`, `category`, `priceCoins` e `requires` |
| `POST /shop/buy` | Sessão e corpo como `{"itemId":"large_basket"}` | `status`, `itemId`, `pricePaid` e saldo restante em `coins` |
| `GET /health` | Pública | Estado e tempo de atividade do processo |

O cliente deve guardar o novo refresh token a cada renovação. Reapresentar um token já utilizado revoga a família daquela sessão. O verificador do Game Center baixa o certificado indicado pelo GameKit e confere sua validade e assinatura com a autoridade DigiCert usada pela Apple. Se a Apple trocar de autoridade emissora, atualize o certificado em `src/modules/auth/providers/gamecenter-issuer.ts`. [Verificação de identidade no GameKit](https://developer.apple.com/documentation/gamekit/gklocalplayer/fetchitems(foridentityverificationsignature:))

## Loja e progresso

O perfil começa com zero moedas. A loja usa os cinco produtos, preços e pré-requisitos da bancada do Unity. O servidor debita as moedas e grava a melhoria na mesma transação. Saldo insuficiente retorna 400, produto desconhecido retorna 404 e uma compra repetida ou bloqueada por pré-requisito retorna 409. Se a conexão cair após confirmar a compra, consulte `GET /users/me` para recuperar o saldo e as melhorias.

O jogo atual ganha moedas no aparelho. Para ativar compras online, falta integrar o cliente e registrar no servidor os créditos por venda de pescado e entrega de encomendas, com um identificador por operação para evitar crédito duplicado em uma reconexão. A importação do save existente também precisa de uma regra para conciliar moedas e melhorias entre aparelhos.

## Testes

```sh
npm run lint
npm run build
npm test -- --runInBand
```

Os testes HTTP usam PostgreSQL real e simulam as respostas dos provedores de identidade. Aponte `TEST_DATABASE_URL` para um banco de testes dedicado.

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run prisma:deploy
npm run test:e2e -- --runInBand
```
