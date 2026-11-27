# My Little Pier · API

Backend em NestJS com PostgreSQL e Prisma. O jogador entra pelo Google Play Games ou Apple Game Center, consulta o perfil e compra melhorias com moedas. A API também recebe compras de pacotes de gemas e recompensas de anúncios. Cada instalação desta API usa seu próprio banco, segredo JWT e credenciais de plataforma.

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

As chamadas com sessão usam `Authorization: Bearer <accessToken>`. Nos dois logins, a primeira chamada cria a conta. O próximo login com a mesma identidade recupera o mesmo `playerId`. Google e Apple têm contas independentes nesta versão. O Play Games fornece o nome público e o avatar a cada login. A conta Apple pode usar o campo opcional `name` na criação.

| Rota | Entrada | Resposta |
| --- | --- | --- |
| `POST /users/google` | `authToken` com o código de acesso ao servidor fornecido pelo Play Games | `playerId`, `accessToken`, `expiresIn`, `refreshToken`, `refreshExpiresAt`, `refreshExpiresIn` |
| `POST /users/apple` | `playerId` com o `teamPlayerID`, `publicKeyUrl`, `signature` e `salt` em Base64, `timestamp` em milissegundos | Mesmos campos do login Google |
| `POST /auth/refresh` | `refreshToken` | Novos tokens e prazos de expiração |
| `POST /auth/logout` | Com sessão, envie `refreshToken` do aparelho ou `allDevices: true` | HTTP 204. O token de acesso expira no prazo original |
| `GET /users/me` | Sessão | `id`, `name`, `createdAt`, `coins`, `gems` e `ownedItemIds` |
| `GET /shop` | Sessão | Lista de produtos com `itemId`, `category`, `priceCoins` e `requires` |
| `POST /shop/buy` | Sessão e corpo como `{"itemId":"large_basket"}` | `status`, `itemId`, `pricePaid` e saldo restante em `coins` |
| `GET /health` | Pública | Estado e tempo de atividade do processo |

O cliente deve guardar o novo refresh token a cada renovação. Reapresentar um token já utilizado revoga a família daquela sessão. O verificador do Game Center baixa o certificado indicado pelo GameKit e confere sua validade e assinatura com a autoridade DigiCert usada pela Apple. Se a Apple trocar de autoridade emissora, atualize o certificado em `src/modules/auth/providers/gamecenter-issuer.ts`. [Verificação de identidade no GameKit](https://developer.apple.com/documentation/gamekit/gklocalplayer/fetchitems(foridentityverificationsignature:))

## Loja e progresso

O perfil começa com zero moedas. A loja usa os cinco produtos, preços e pré-requisitos da bancada do Unity. O servidor debita as moedas e grava a melhoria na mesma transação. Saldo insuficiente retorna 400, produto desconhecido retorna 404 e uma compra repetida ou bloqueada por pré-requisito retorna 409. Se a conexão cair após confirmar a compra, consulte `GET /users/me` para recuperar o saldo e as melhorias.

O jogo atual ganha moedas no aparelho. Para ativar compras online, falta integrar o cliente e registrar no servidor os créditos por venda de pescado e entrega de encomendas, com um identificador por operação para evitar crédito duplicado em uma reconexão. A importação do save existente também precisa de uma regra para conciliar moedas e melhorias entre aparelhos.

## Compras nas lojas e anúncios

Cadastre os produtos reais do jogo em `GemPackDefinition` pelo Prisma Studio, um registro por plataforma (`APPLE` ou `GOOGLE`), com o `productId` da loja, a quantidade de `gems` e `isEnabled`. O catálogo começa vazio. Configure pacotes consumíveis de uma unidade por transação. As gemas ficam em saldo separado das moedas da bancada. Por padrão, os recibos de sandbox ficam registrados com crédito zero. Use `IAP_CREDIT_SANDBOX=true` no ambiente de testes para exercitar o crédito.

| Rota | Quem envia | Uso |
| --- | --- | --- |
| `POST /iap/apple/verify` | Unity, com JWT | Envia `transactionId`. O StoreKit deve receber o UUID do jogador em `appAccountToken` ao iniciar a compra. |
| `POST /iap/google/verify` | Unity, com JWT | Envia `productId` e `purchaseToken`. Configure `obfuscatedAccountId` com o UUID do jogador ao abrir o Play Billing. |
| `POST /iap/apple/notifications/production` | App Store Connect | Recebe `signedPayload` das notificações V2 de produção. |
| `POST /iap/apple/notifications/sandbox` | App Store Connect | Recebe notificações V2 de sandbox, incluindo TestFlight. |
| `POST /iap/google/rtdn` | Google Cloud Pub/Sub | Push autenticado com o envelope padrão. Ative notificações de produtos avulsos na Play Console. |
| `GET /rewards/admob/ssv` | AdMob | Retorno de verificação de anúncio recompensado. No SDK, defina `user_id` como o UUID do jogador. |

Nas duas rotas de verificação, a resposta contém `status`, `productId`, `gemsGranted`, `gems` e `coins`. O servidor valida a compra na loja, confere a conta e registra o crédito uma vez, mesmo quando o webhook e o Unity confirmam a mesma compra. Um reembolso retira as gemas concedidas e pode deixar o saldo negativo.

**Apple.** Cadastre as duas URLs HTTPS no App Store Connect. Configure o ID numérico do app, bundle ID, emissor, ID da chave e chave privada de compras no ambiente. O backend valida a assinatura Apple e separa produção de sandbox. [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications)

**Google Play.** Dê à conta de serviço de compras acesso ao app na Play Console e configure o JSON da credencial no ambiente. Na assinatura push, configure uma conta de serviço para assinar o token OIDC e a audiência esperada em `GOOGLE_RTDN_AUDIENCE`. O e-mail dessa conta deve coincidir com `GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT`. [Notificações da Google Play](https://developer.android.com/google/play/billing/rtdn-reference)

**AdMob.** Ao criar o bloco, teste a URL SSV com o campo User ID vazio. O servidor confirma o callback assinado sem conceder moedas. Configure a URL SSV em cada unidade recompensada e liste seus IDs numéricos em `ADMOB_REWARDED_AD_UNITS`, separados por vírgula. O backend confere a assinatura do Google e a unidade antes do crédito. O bloco do My Little Pier usa a regra de três iscas descrita abaixo. Cada `transaction_id` pode gerar um único crédito. [Verificação do AdMob](https://developers.google.com/admob/android/ssv)

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

## Progresso e amizades da v0.10.0

O cliente Android usa `https://api.mylittlepier.com`. As rotas `/pier` exigem o JWT da conta. O servidor obtém o dono do progresso pelo token. A chave composta de provedor e identidade externa garante uma conta por jogador. A primeira leitura cria um save vazio com 12 iscas. O instantâneo privado guarda a economia da pescaria, o álbum, o cesto, os equipamentos, os postos, as missões e o barco. Os saldos comerciais de moedas e gemas do servidor continuam protegidos nas rotas de compras e recompensas.

| Rota | Operação |
| --- | --- |
| `GET /pier/state` | Devolve o save, a revisão, as iscas do dia UTC e o perfil. |
| `POST /pier/state` | Grava `snapshot`, revisão esperada, UUID da operação, gasto de zero ou uma isca e captura opcional. O bloqueio de linha serializa o gasto e a reposição. Uma revisão antiga retorna 409. |
| `GET /pier/stats`, `GET /pier/history?before=N` | Totais e maior peixe, ou até 50 capturas da conta por página. Cada captura tem a revisão da gravação como chave e conserva a data da pescaria mesmo se o envio atrasar. |
| `GET /pier/players?q=Ana` | Busca por prefixo de 2 a 32 caracteres, até 30 resultados com ID, nome e avatar. |
| `GET /pier/friends` | Amizades e pedidos de entrada e saída da própria conta. |
| `POST /pier/friends/:id` | Recebe `action` com `send`, `accept` ou `decline`. Só o destinatário pode decidir sobre um pedido. |
| `GET /jobs/bait` | A Vercel envia `Authorization: Bearer` com o valor de `CRON_SECRET`. |

A migração `20261126010000_pier` cria índices para a data das iscas, o prefixo do nome, os dois lados da amizade e o histórico por jogador e revisão. A chave única do par torna a amizade simétrica e impede duplicatas. As relações com o jogador e a restrição que exige dois participantes diferentes também valem no banco.

No painel do projeto Vercel, configure `CRON_SECRET` como Sensitive em Production. O agendamento em `vercel.json` usa `0 0 * * *` (UTC). O cron repõe o saldo de todas as contas com data anterior. A primeira leitura ou gravação após a virada aplica a mesma regra se o cron atrasar. A função diária e o PostgreSQL consomem recursos do plano contratado. Nenhum dado de save legado é importado pela migração.

### Caixa de iscas do My Little Pier

A API devolve a oferta na gravação de cada quinta captura. O jogo usa o bloco premiado Android `2697891384`. O cliente autenticado reserva uma exibição em `POST /pier/bait/ad` com um UUID e a contagem de capturas. O banco limita a três reservas por conta e dia UTC, inclusive entre aparelhos. Fechar a oferta antes de assistir preserva a vaga. O AdMob devolve o UUID em `custom_data` e o jogador em `user_id` para `GET /rewards/admob/ssv`. A assinatura, a unidade, o titular e a transação confirmam o crédito de três iscas. A callback de teste do console pode usar um usuário vazio.

`POST /pier/bait/purchase` usa o JWT e uma chave UUID de idempotência. Uma gema compra três iscas. As iscas extras sobrevivem à reposição diária e o jogo gasta as do dia primeiro. A migração Prisma cria a tabela de operações e os índices de limite e deduplicação.

Para o convidado, `/rewards/guest/availability`, `/rewards/guest/ad` e `/rewards/guest/status` usam uma credencial aleatória da instalação. O app Android guarda a credencial na área privada excluída do backup. O banco guarda o hash. O limite UTC sobrevive à troca de sessão. A confirmação do vídeo só acrescenta iscas à partida em memória que solicitou o anúncio.
