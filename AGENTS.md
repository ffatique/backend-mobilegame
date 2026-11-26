# Backend do My Little Pier

Este repositório contém a API NestJS do jogo. Use outros repositórios de backend apenas para consulta. Use credenciais e bancos próprios do My Little Pier.

## Entregas

1. Sincronize a `main` com `origin/main`. Abra uma branch `codex/vX.Y.Z-descricao-curta` e mantenha a versão do pacote e do lockfile coerente com a entrega.
2. Revise o diff, compile a API e rode o lint e os testes. Para mudanças de persistência ou das rotas, valide a migração e os testes HTTP em um PostgreSQL dedicado a testes.
3. Envie a branch e abra um PR para a `main`. Descreva a mudança, os testes e o que ainda depende de validação. Confira o diff e os checks. Se houver exigência de aprovação por outra pessoa, aguarde a revisão.
4. Faça o merge pelo PR, marque o commit integrado com a tag `vX.Y.Z` e publique a tag. Volte à `main` local e confira que ela coincide com `origin/main`.
5. Em entregas para produção, acompanhe o deploy e verifique a URL pública em `/health` e a proteção de `/users/me`.

Use a skill `humanizer`, quando disponível, nos textos, commits e PRs.
