//go:build !linux

package main

import "os/exec"

func own(cmd *exec.Cmd) {}
