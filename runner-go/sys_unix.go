//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// setPgid põe o filho num grupo de processo próprio, pra matar a árvore inteira
// no timeout (senão só o bash morreria, deixando o comando neto vivo).
func setPgid(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killGroup mata o grupo de processo do filho (pid negativo = grupo).
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
