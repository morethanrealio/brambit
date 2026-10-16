package main

import (
	"fmt"
	"testing"
)

// Prints the seatbelt profile to compare byte-for-byte with brambs-runner.mjs's.
func TestDumpSeatbelt(t *testing.T) {
	fmt.Println("=== workspace-write ===")
	fmt.Println(seatbeltProfile("workspace-write", []string{"/Users/x/Documents/Brambs", "/Users/x/proj"}))
	fmt.Println("=== read-only ===")
	fmt.Println(seatbeltProfile("read-only", nil))
}
