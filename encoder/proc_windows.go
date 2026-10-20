package main

import (
	"os/exec"
	"syscall"
)

// hideWindow: ffmpeg runs without opening its own console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

// detach: the restarted app outlives this process (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
}
