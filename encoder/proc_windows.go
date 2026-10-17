package main

import (
	"os/exec"
	"syscall"
)

// hideWindow: ffmpeg runs without opening its own console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
