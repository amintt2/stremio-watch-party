package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Prefs: choices made in the app's window, kept next to the saved settings.
type Prefs struct {
	AutoUpdate bool `json:"autoUpdate"`
	// "server" (the Watch Party site this PC is paired with: always the version that
	// matches it) or "github" (releases of GithubRepo).
	UpdateSource string `json:"updateSource"`
	GithubRepo   string `json:"githubRepo"`
	// Start with the computer was offered once (on by default on the first run).
	AutoStartSet bool `json:"autoStartSet"`
	// Last version installed automatically, and when: if the app still isn't on it after
	// restarting (a build that reports another version), it doesn't install it again and
	// again.
	TriedVersion string `json:"triedVersion,omitempty"`
	TriedAt      int64  `json:"triedAt,omitempty"`
}

const defaultRepo = "amintt2/stremio-watch-party"

var (
	prefsMu sync.Mutex
	prefs   = Prefs{AutoUpdate: true, UpdateSource: "server", GithubRepo: defaultRepo}
)

func prefsPath() string { return filepath.Join(configDir(), "prefs.json") }

func loadPrefs() {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	if data, err := os.ReadFile(prefsPath()); err == nil {
		_ = json.Unmarshal(data, &prefs)
	}
	if prefs.UpdateSource != "github" {
		prefs.UpdateSource = "server"
	}
	if !validRepo(prefs.GithubRepo) {
		prefs.GithubRepo = defaultRepo
	}
	publishPrefs()
}

// updatePrefs changes and saves the preferences.
func updatePrefs(fn func(p *Prefs)) {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	fn(&prefs)
	_ = os.MkdirAll(configDir(), 0o700)
	if data, err := json.MarshalIndent(prefs, "", "  "); err == nil {
		_ = os.WriteFile(prefsPath(), data, 0o600)
	}
	publishPrefs()
}

func currentPrefs() Prefs {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	return prefs
}

func publishPrefs() {
	p := prefs
	status.set(func(s *Status) {
		s.AutoUpdate = p.AutoUpdate
		s.Source = p.UpdateSource
		s.Repo = p.GithubRepo
	})
}

// validRepo: "owner/name" with GitHub's characters only.
func validRepo(r string) bool {
	slash := 0
	for i, c := range r {
		switch {
		case c == '/':
			if i == 0 || i == len(r)-1 {
				return false
			}
			slash++
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_', c == '.':
		default:
			return false
		}
	}
	if slash != 1 || len(r) > 140 {
		return false
	}
	for _, part := range strings.Split(r, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	return true
}
