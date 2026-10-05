# ops/apps-host — plano de controle dos apps gerados pelos assistentes

Estes dois arquivos rodam numa máquina separada, a **box de apps**, não no serviço web.

| arquivo     | caminho na box               | o que é                                                                                                                            |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ctl.py`    | `/opt/brambs-ctl/ctl.py`     | plano de controle. Recebe **um JSON no stdin** e devolve **uma linha JSON no stdout**. Chamado por SSH pelo `web/hosting.mjs`.      |
| `router.py` | `/opt/brambs-router/router.py` | roteador scale-to-zero em `127.0.0.1:9081` (atrás do Caddy:443, atrás do ALB). Acorda o container sob demanda e dorme por ociosidade. |

Só stdlib nos dois — nada de `pip install` na box.

## Como chega lá

**Git é a única fonte da verdade. Ninguém edita arquivo direto na box.**

Dois scripts, rodados na raiz do repositório numa máquina que tenha a chave do
canal de controle (`APPS_HOST_SSH`/`APPS_HOST_KEY` no `.env`, o mesmo canal
que o `web/appshost.mjs` usa pra chamar o `ctl.py`):

| script | o que faz |
| ------ | --------- |
| `check-drift.sh [ref]` | só lê. Compara git x box e sai 1 se divergir. |
| `deploy.sh [--aplicar] [--ref R]` | publica. Simula por padrão. |

```bash
ops/apps-host/check-drift.sh            # o que está no ar bate com o git?
ops/apps-host/deploy.sh                 # simulação: o que mudaria
ops/apps-host/deploy.sh --aplicar       # publica de verdade
```

O `deploy.sh` roda o `test_auth.py` **antes** de mandar qualquer byte, faz backup
(`.bak.<epoch>`), envia, confere o md5 do que chegou, compila com `py_compile`,
roda o `test_auth.py` de novo **contra os arquivos que ficaram em uso**, reinicia
o `brambs-router` só se ele mudou (`ctl.py` é one-shot por chamada, não precisa),
carimba o sha em `/opt/brambs-router/.deployed-sha` e **restaura o backup se
qualquer passo falhar**.

Só `router.py` e `ctl.py` entram nesse caminho.

Ordem preferida quando a mudança envolve o portão de acesso: **`router.py`
primeiro** (o `deploy.sh` já faz nessa ordem). O roteador é quem valida a senha;
se o `ctl.py` novo gravar entradas `auth` no registry antes de o roteador saber
checá-las, esses apps ficam abertos no intervalo. O sentido inverso é seguro
(roteador novo + registry velho = nenhum app tem `auth`, tudo segue como antes).

Isso deixou de ser uma janela silenciosa: o `ctl.py` devolve `privado: true/false`
e o harness **só afirma que trancou se o host confirmar**. Plataforma nova contra
host velho publica o app aberto e manda o assistente avisar o usuário, em vez de
prometer senha que não existe.

**Qual versão está no ar:** `cat /opt/brambs-router/.deployed-sha` na box, ou
`check-drift.sh` daqui. Não confie em md5 escrito à mão em documentação.

## Configuração

Os padrões abaixo valem se nada for configurado.

| o quê | onde | padrão |
| ----- | ---- | ------ |
| domínio dos apps | `APPS_DOMAIN` no `.env` do backend. O `web/appshost.mjs` manda `dominio` em todo JSON; o `ctl.py` monta com ele o link devolvido no `publish`, o `Host` do smoke-test e o e-mail dos commits. Sem `dominio` no JSON (backend antigo), vale `APPS_DOMAIN` do ambiente do `ctl.py`, que o `sudo` normalmente limpa. | host do site da marca; sem domínio válido, `localhost` |
| caminho do `ctl.py` | `APPS_CTL_PATH` no `.env` do backend | `/opt/brambs-ctl/ctl.py`, onde o `deploy.sh` instala |
| marca do host (nome, site, logo e texto do selo; o nome também é o autor dos commits sem pessoa por trás) | `ops/apps-host/marca.json` no repositório (`{"nome", "site", "logo", "selo", "selo_aria"}`, tudo opcional), que o `deploy.sh` instala em `/opt/brambs-router/marca.json` e reinicia o roteador; `BRAMBS_SITE_URL` e `BRAMBS_LOGO_URL` no ambiente da unit valem por cima | `Brambit`, `http://localhost:8080/`, `<site>/logo.svg` e "Feito com Brambit" |
| caminhos do roteador | `BRAMBS_REGISTRY`, `BRAMBS_INTERNAL_KEY_FILE`, `BRAMBS_USERS`, `BRAMBS_HOME`, `BRAMBS_LOG_DIR` no ambiente da unit | `/opt/brambs-router/...`, `/opt/brambs-home`, `/var/log/brambs` |

O roteador não depende do domínio: o label sai do primeiro pedaço do `Host`.
Os caminhos do `ctl.py` são fixos (`/opt/brambs-*`) e têm que bater com os do
roteador.

## Contratos que não dá para quebrar sozinho

- **`/opt/brambs-router/apps.json`** é lido pelo roteador **a cada request** (`load_registry`).
  Editar o registry tem efeito imediato, sem restart — é por isso que `set_auth` tranca e
  destranca uma URL sem republicar o app.
- **`/opt/brambs-router/internal.key`** (0600) é o segredo compartilhado entre `ctl.py` e
  `router.py`. É o que permite o smoke-test interno do `ctl` passar pelo portão sem senha de
  usuário (allow-list por IP não serve: o Caddy proxia de 127.0.0.1, igual a todo mundo).
  Os dois criam o arquivo com `O_EXCL` se não existir, então a ordem de deploy não importa
  para ele. Apagar esse arquivo quebra o smoke-test do publish, não o acesso dos usuários.
- **`/app/data`** é o diretório de dados de runtime do app. Fica **fora** de publish,
  snapshot e git — de propósito: dado de usuário não viaja em replicação nem volta em
  rollback. Consequência: `delete` destrói esse diretório e **não existe backup**. É por isso
  que `apagar_sistema` no harness passa pelo `inventory` antes e pede confirmação por escrito.
- `hash` do portão é `sha256(salt:senha)`. Serve porque a senha é gerada por nós, com
  entropia alta, e o roteador verifica a cada request. **Se algum dia aceitarmos senha
  escolhida pelo usuário, isto tem que virar pbkdf2/scrypt.**
