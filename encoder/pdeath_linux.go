package main

import (
	"os/exec"
	"syscall"
)

// own: ffmpeg is killed with the app, even when the app is killed without warning.
func own(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}
