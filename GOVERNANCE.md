# Governança

O Brambit é mantido pela STEM Tecnologia e Desenvolvimento de Software LTDA, que
também opera o Brambs, serviço hospedado construído sobre ele, em brambs.com.br.

## Papéis

- *Contribuidor:* qualquer pessoa que abre issue ou PR.
- *Mantenedor:* revisa e faz merge na sua área. Lista em [MAINTAINERS.md](MAINTAINERS.md).
- *Responsável pelo projeto:* decide o roteiro, a licença e quem é mantenedor, e
  desempata quando os mantenedores não chegam a acordo.

## Como as decisões são tomadas

- Mudança comum: um mantenedor da área aprova.
- Área sensível (login, separação entre contas, cobrança, execução de código, banco,
  CI): mantenedor da área *e* de segurança.
- Mudança de rumo (arquitetura, licença, dependência grande): issue aberta para
  discussão antes de qualquer PR; quem decide é o responsável pelo projeto.

## Núcleo aberto e serviço hospedado

Este repositório é o núcleo: tudo que alguém precisa pra rodar o assistente com a
própria chave de LLM. A operação do serviço brambs.com.br (planos, cobrança,
comunicação com usuários, métricas de negócio) fica fora dele e se conecta por pontos
de extensão. Correção ou recurso de interesse geral entra primeiro aqui.

## Marca

O código é AGPL-3.0; os nomes "Brambit" e "Brambs", os logos e os mascotes não. Uma
versão modificada pode citar que é baseada no Brambit, mas não pode se apresentar
como o Brambit nem como o Brambs.

## Tornar-se mantenedor

Quem contribui com regularidade e qualidade numa área pode ser convidado. O convite
é decidido pelo responsável pelo projeto, ouvindo os mantenedores atuais.
