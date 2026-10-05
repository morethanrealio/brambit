//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// No Windows criamos um grupo de processo novo (pra encerrar a árvore) e
// escondemos a janela de console do filho (o app roda sem terminal, -H
// windowsgui; sem isso cada powershell abriria um console piscando).
func setPgid(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000200 | 0x08000000, // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
		HideWindow:    true,
	}
}

// killGroup encerra o processo (e filhos) no Windows.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
