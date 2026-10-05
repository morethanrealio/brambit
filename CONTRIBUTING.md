# Como contribuir

Obrigado pelo interesse no Brambit. Este guia mostra o caminho de uma contribuição,
da ideia ao merge.

## Antes de começar

- *Licença:* o projeto é AGPL-3.0 ([LICENSE](LICENSE)). Ao contribuir, o seu código
  entra sob essa licença.
- *CLA:* no primeiro pull request, você aceita o [Acordo de Licença de
  Contribuidor](CLA.md). Sem ele o PR não é mergeado.
- *Conduta:* vale o [código de conduta](CODE_OF_CONDUCT.md).
- *Vulnerabilidade:* não abra issue pública. Siga o [SECURITY.md](SECURITY.md).

## Rodar na sua máquina

O passo a passo está no [README](README.md#quick-start): `npm ci`, copiar
`.env.example` e `modelos.example.yaml`, pôr a chave do seu provedor de LLM e rodar
`npm run local`. Não precisa de nenhuma credencial do projeto nem de acesso à
produção.

## Fluxo

1. Para mudança maior que uma correção pequena, abra antes uma issue explicando o
   problema e a proposta. Assim ninguém perde trabalho com algo que não vai entrar.
2. Quer pegar uma issue? Comente nela; um mantenedor atribui a issue a você. A
   reserva vale 7 dias, ou o prazo do rótulo da issue (`prazo: 1 dia`,
   `prazo: 3 dias`, `prazo: 30 dias`). Comentário seu na issue renova o prazo, e
   enquanto houver PR seu aberto ligado a ela a reserva não vence. Venceu sem
   novidade, um robô tira a atribuição e a issue fica livre para outra pessoa.
3. Crie uma branch a partir de `main` e abra o PR contra ela.
4. Rode os testes da área que você mexeu (`node --test arquivo.test.mjs` ou o
   `npm run <area>:test` correspondente no `package.json`). O CI roda a checagem
   rápida em todo PR.
5. Um mantenedor da área revisa (ver [MAINTAINERS.md](MAINTAINERS.md) e
   `.github/CODEOWNERS`).

## O que um bom PR tem

- Um assunto por PR, com a descrição do problema, do que mudou e de como você testou.
- Teste quando a mudança pode quebrar sem ninguém perceber. Teste que só repete o
  código não ajuda.
- Nada de segredo, chave, dado real de usuário, IP ou host interno, nem no código
  nem nos testes. O CI barra segredo (gitleaks) e workflow perigoso (zizmor).
- Texto para o usuário em português, inglês e espanhol, quando a área já tiver os
  três idiomas.

## Áreas sensíveis

Mudança em login, separação entre contas, cobrança e crédito, execução de código,
esquema do banco ou CI precisa da revisão de quem cuida da área *e* de quem cuida de
segurança. Espere uma revisão mais longa nesses casos.
