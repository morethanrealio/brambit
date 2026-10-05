package main

import (
	"fmt"
	"testing"
)

// Imprime o perfil seatbelt pra comparar byte-a-byte com o do brambs-runner.mjs.
func TestDumpSeatbelt(t *testing.T) {
	fmt.Println("=== workspace-write ===")
	fmt.Println(seatbeltProfile("workspace-write", []string{"/Users/x/Documents/Brambs", "/Users/x/proj"}))
	fmt.Println("=== read-only ===")
	fmt.Println(seatbeltProfile("read-only", nil))
}
