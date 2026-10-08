package main

import "strings"

// Runner brand, chosen when building the binary (build.sh passes it via
// -ldflags -X), so whoever installs the server can generate their own Runner without
// touching the source. With nothing set, it's the core's: "Brambit Runner", ~/.brambit-runner.json,
// BRAMBIT_RUNNER_TOKEN. slug has to match the server's (slugDaMarca, in
// web/marca.mjs): it's where the executable names and the /runner commands come from.
var (
	produto = "Brambit"
	slug    = "brambit"
	siteURL = "http://localhost:8080"
)

// "Brambit Runner": how the program introduces itself to the owner.
func nomeRunner() string { return produto + " Runner" }

// Environment variable with the brand prefix: envVar("RUNNER_TOKEN") = BRAMBIT_RUNNER_TOKEN.
func envVar(s string) string { return strings.ToUpper(slug) + "_" + s }

// Server address as shown in text to the owner ("example.com/runner").
func siteNoTexto() string {
	s := strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	return strings.TrimRight(s, "/")
}
