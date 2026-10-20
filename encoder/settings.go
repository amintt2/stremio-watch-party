package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Settings: where the server is and this PC's pairing key.
type Settings struct {
	Server string `json:"server"`
	Key    string `json:"key"`
}

func (s Settings) valid() bool {
	return (strings.HasPrefix(s.Server, "http://") || strings.HasPrefix(s.Server, "https://")) && strings.HasPrefix(s.Key, "wpe_")
}

const configName = "watchparty-encoder.json"

var (
	settingsMu sync.Mutex
	settingsV  Settings
)

// currentSettings: where this app is connected (for the updater and the window).
func currentSettings() Settings {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	return settingsV
}

func setCurrentSettings(s Settings) {
	settingsMu.Lock()
	settingsV = s
	settingsMu.Unlock()
	status.set(func(st *Status) { st.Server = s.Server })
}

// saveSettings: pairing typed in the window (server address + key from the site).
func saveSettings(s Settings) error {
	s.Server = strings.TrimSuffix(strings.TrimSpace(s.Server), "/")
	s.Key = strings.TrimSpace(s.Key)
	if !s.valid() {
		return errors.New("adresse (https://…) ou clé (wpe_…) invalide")
	}
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(filepath.Join(configDir(), configName), data, 0o600)
}

// loadSettings: command line, else the settings the site wrote into this .exe, else
// watchparty-encoder.json next to the program (macOS / Linux zip), else the copy saved
// on the first run (so renaming or moving the .exe keeps working).
// Keys the server refused are skipped (refused), so a pairing typed in the window wins over
// an older key still written in this .exe.
func loadSettings(flags Settings, refused map[string]bool) (Settings, error) {
	saved := filepath.Join(configDir(), configName)
	exe, _ := os.Executable()
	candidates := []func() (Settings, error){
		func() (Settings, error) { return flags, nil },
		func() (Settings, error) { return readTrailer(exe) },
		func() (Settings, error) { return readJSON(filepath.Join(filepath.Dir(exe), configName)) },
		func() (Settings, error) { return readJSON(saved) },
	}
	for i, get := range candidates {
		s, err := get()
		if err != nil || !s.valid() || refused[s.Key] {
			continue
		}
		if i < 3 {
			_ = os.MkdirAll(filepath.Dir(saved), 0o700)
			if data, err := json.MarshalIndent(s, "", "  "); err == nil {
				_ = os.WriteFile(saved, data, 0o600)
			}
		}
		return s, nil
	}
	return Settings{}, errors.New("pas encore jumelé : télécharge l'encodeur depuis Watch Party (Paramètres → Encodeur GPU), ou colle l'adresse du site et une clé ci-dessous")
}

func configDir() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "WatchPartyEncoder")
	}
	return "."
}

func readJSON(path string) (Settings, error) {
	var s Settings
	data, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}

// readTrailer finds "#WPCFG#<base64 json>#END#" in the last bytes of the program file
// (see withTrailer in server/src/encoderRoutes.js).
func readTrailer(path string) (Settings, error) {
	var s Settings
	f, err := os.Open(path)
	if err != nil {
		return s, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return s, err
	}
	size := min(info.Size(), 8192)
	buf := make([]byte, size)
	if _, err := f.ReadAt(buf, info.Size()-size); err != nil && err != io.EOF {
		return s, err
	}
	return parseTrailer(buf)
}

func parseTrailer(buf []byte) (Settings, error) {
	var s Settings
	start := bytes.LastIndex(buf, []byte("#WPCFG#"))
	if start < 0 {
		return s, errors.New("no trailer")
	}
	rest := buf[start+len("#WPCFG#"):]
	end := bytes.Index(rest, []byte("#END#"))
	if end < 0 {
		return s, errors.New("bad trailer")
	}
	data, err := base64.StdEncoding.DecodeString(string(rest[:end]))
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}
