package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Start at login on macOS: a LaunchAgent in the user's Library.
func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", "fr.watchparty.encoder.plist")
}

func autoStartEnabled() bool {
	_, err := os.Stat(launchAgentPath())
	return err == nil
}

func setAutoStart(on bool) error {
	if !on {
		if err := os.Remove(launchAgentPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	exe, err := selfPath()
	if err != nil {
		return err
	}
	esc := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(exe)
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>fr.watchparty.encoder</string>
  <key>ProgramArguments</key><array><string>%s</string><string>-background</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`, esc)
	if err := os.MkdirAll(filepath.Dir(launchAgentPath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(launchAgentPath(), []byte(plist), 0o644)
}
