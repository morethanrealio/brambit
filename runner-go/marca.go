package main

import "strings"

// Marca do Runner, escolhida na hora de gerar o programa (build.sh passa por
// -ldflags -X), pra quem instala o servidor gerar o próprio Runner sem mexer no
// fonte. Sem nada, é o do núcleo: "Brambit Runner", ~/.brambit-runner.json,
// BRAMBIT_RUNNER_TOKEN. slug tem que ser o mesmo do servidor (slugDaMarca, em
// web/marca.mjs): é dele que saem os nomes dos executáveis e os comandos da /runner.
var (
	produto = "Brambit"
	slug    = "brambit"
	siteURL = "http://localhost:8080"
)

// "Brambit Runner": como o programa se apresenta pro dono.
func nomeRunner() string { return produto + " Runner" }

// Variável de ambiente com o prefixo da marca: envVar("RUNNER_TOKEN") = BRAMBIT_RUNNER_TOKEN.
func envVar(s string) string { return strings.ToUpper(slug) + "_" + s }

// Endereço do servidor como aparece em texto pro dono ("brambs.com.br/runner").
func siteNoTexto() string {
	s := strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	return strings.TrimRight(s, "/")
}
