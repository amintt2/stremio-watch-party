package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Start at login on Linux desktops: an XDG autostart entry.
func desktopEntryPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "autostart", "watchparty-encoder.desktop")
}

func autoStartEnabled() bool {
	_, err := os.Stat(desktopEntryPath())
	return err == nil
}

func setAutoStart(on bool) error {
	if !on {
		if err := os.Remove(desktopEntryPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	exe, err := selfPath()
	if err != nil {
		return err
	}
	entry := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Watch Party — Encodeur GPU\nExec=%q -background\nX-GNOME-Autostart-enabled=true\n", exe)
	if err := os.MkdirAll(filepath.Dir(desktopEntryPath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(desktopEntryPath(), []byte(entry), 0o644)
}
