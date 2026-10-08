//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// On Windows we create a new process group (to end the tree) and
// hide the child's console window (the app runs without a terminal, -H
// windowsgui; without this each powershell would flash open a console).
func setPgid(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000200 | 0x08000000, // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
		HideWindow:    true,
	}
}

// killGroup ends the process (and children) on Windows.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
