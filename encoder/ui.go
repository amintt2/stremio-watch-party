package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// The app's window is a small page served on this PC only (127.0.0.1), opened in the
// browser: no GUI toolkit to install, same window on Windows, macOS and Linux. On Windows
// the icon near the clock (tray_windows.go) reopens it.

//go:embed ui.html
var uiPage string

// uiPort: fixed, so a second launch finds the first one and just shows its window.
const uiPort = 47470

type UI struct {
	url    string
	token  string
	server *http.Server
	// actions from the window, handled by main.go.
	pair  chan Settings
	retry chan struct{}
	quit  func()
}

// startUI listens on the window's port. When another copy of the app already runs there,
// it returns that copy's address instead (existing != "").
func startUI(quit func()) (ui *UI, existing string, err error) {
	addr := fmt.Sprintf("127.0.0.1:%d", uiPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if otherInstance(addr) {
			return nil, "http://" + addr + "/", nil
		}
		// The port is someone else's: any free one (no single-instance check then).
		if ln, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			return nil, "", err
		}
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	ui = &UI{
		url:   fmt.Sprintf("http://%s/", ln.Addr().String()),
		token: hex.EncodeToString(b),
		pair:  make(chan Settings, 1),
		retry: make(chan struct{}, 1),
		quit:  quit,
	}
	ui.server = &http.Server{Handler: ui.routes(ln.Addr().String()), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = ui.server.Serve(ln) }()
	return ui, "", nil
}

func otherInstance(addr string) bool {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://" + addr + "/api/ping")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct{ App string }
	return json.NewDecoder(resp.Body).Decode(&body) == nil && body.App == "watchparty-encoder"
}

func (ui *UI) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = ui.server.Shutdown(ctx)
}

func (ui *UI) routes(host string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:")
		_, _ = w.Write([]byte(strings.Replace(uiPage, "__TOKEN__", ui.token, 1)))
	})
	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"app": "watchparty-encoder", "version": version})
	})
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, status.snapshot())
	})
	mux.HandleFunc("POST /api/prefs", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AutoUpdate   *bool   `json:"autoUpdate"`
			UpdateSource *string `json:"updateSource"`
			GithubRepo   *string `json:"githubRepo"`
			AutoStart    *bool   `json:"autoStart"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		if body.GithubRepo != nil && !validRepo(strings.TrimSpace(*body.GithubRepo)) {
			writeError(w, errors.New("dépôt GitHub invalide : propriétaire/nom"))
			return
		}
		updatePrefs(func(p *Prefs) {
			if body.AutoUpdate != nil {
				p.AutoUpdate = *body.AutoUpdate
			}
			if body.UpdateSource != nil && (*body.UpdateSource == "server" || *body.UpdateSource == "github") {
				p.UpdateSource = *body.UpdateSource
			}
			if body.GithubRepo != nil {
				p.GithubRepo = strings.TrimSpace(*body.GithubRepo)
			}
		})
		if body.AutoStart != nil {
			if err := setAutoStart(*body.AutoStart); err != nil {
				writeError(w, err)
				return
			}
			status.set(func(s *Status) { s.AutoStart = autoStartEnabled() })
		}
		if body.UpdateSource != nil || body.GithubRepo != nil {
			pokeUpdater()
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/update/check", func(w http.ResponseWriter, r *http.Request) {
		pokeUpdater()
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/update/install", func(w http.ResponseWriter, r *http.Request) {
		go func() { _ = installUpdate(context.Background()) }()
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/pair", func(w http.ResponseWriter, r *http.Request) {
		var s Settings
		if json.NewDecoder(r.Body).Decode(&s) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		if err := saveSettings(s); err != nil {
			writeError(w, err)
			return
		}
		select {
		case ui.pair <- Settings{Server: strings.TrimSuffix(strings.TrimSpace(s.Server), "/"), Key: strings.TrimSpace(s.Key)}:
		default:
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/retry", func(w http.ResponseWriter, r *http.Request) {
		select {
		case ui.retry <- struct{}{}:
		default:
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/open-site", func(w http.ResponseWriter, r *http.Request) {
		if s := currentSettings(); s.valid() {
			openBrowser(s.Server)
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]bool{"ok": true})
		go func() {
			time.Sleep(200 * time.Millisecond)
			ui.quit()
		}()
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only this PC, by its own address (no other site through DNS rebinding), and every
		// action carries the page's token (no other site can send it).
		if r.Host != host {
			http.Error(w, "forbidden", 403)
			return
		}
		if r.Method == http.MethodPost && r.Header.Get("X-Token") != ui.token {
			http.Error(w, "forbidden", 403)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		mux.ServeHTTP(w, r)
	})
}

func pokeUpdater() {
	select {
	case wakeUpdater <- struct{}{}:
	default:
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(400)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

// openBrowser opens a page in the default browser.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hideWindow(cmd)
	if err := cmd.Start(); err == nil {
		go func() { _ = cmd.Wait() }()
	}
}
