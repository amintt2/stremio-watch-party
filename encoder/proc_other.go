//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func hideWindow(cmd *exec.Cmd) {}

// detach: the restarted app outlives this process (its own session).
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
