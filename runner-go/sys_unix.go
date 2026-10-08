//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// setPgid puts the child in its own process group, to kill the whole tree
// on timeout (otherwise only bash would die, leaving the grandchild command alive).
func setPgid(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killGroup kills the child's process group (negative pid = group).
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
