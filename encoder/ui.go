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
	"sync"
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

	// One-time links (?k=) that open the window: the page and its token are only given to
	// a browser opened by the app itself, never to whatever asks this port.
	mu       sync.Mutex
	links    map[string]time.Time
	lastShow time.Time
}

const uiCookie = "wpe_ui"

// open shows the window in the browser, through a fresh one-time link.
func (ui *UI) open() {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	k := hex.EncodeToString(b)
	ui.mu.Lock()
	if ui.links == nil {
		ui.links = map[string]time.Time{}
	}
	for old, at := range ui.links {
		if time.Since(at) > 2*time.Minute {
			delete(ui.links, old)
		}
	}
	ui.links[k] = time.Now()
	ui.mu.Unlock()
	openBrowser(ui.url + "?k=" + k)
}

func (ui *UI) useLink(k string) bool {
	ui.mu.Lock()
	defer ui.mu.Unlock()
	at, ok := ui.links[k]
	delete(ui.links, k)
	return ok && time.Since(at) < 2*time.Minute
}

func (ui *UI) hasCookie(r *http.Request) bool {
	c, err := r.Cookie(uiCookie)
	return err == nil && c.Value == ui.token
}

// showOther asks the copy already running (at url) to open its window.
func showOther(url string) {
	client := http.Client{Timeout: 2 * time.Second}
	if resp, err := client.Post(url+"api/show", "application/json", strings.NewReader("{}")); err == nil {
		resp.Body.Close()
	}
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
		w.Header().Set("Cache-Control", "no-store")
		if k := r.URL.Query().Get("k"); k != "" {
			if ui.useLink(k) {
				http.SetCookie(w, &http.Cookie{Name: uiCookie, Value: ui.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			}
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		if !ui.hasCookie(r) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(lockedPage))
			return
		}
		_, _ = w.Write([]byte(strings.Replace(uiPage, "__TOKEN__", ui.token, 1)))
	})
	// Anyone on this PC may ask for the window to open (the second launch, a stale tab):
	// it opens through a new one-time link, in the browser, nothing more.
	mux.HandleFunc("POST /api/show", func(w http.ResponseWriter, r *http.Request) {
		// From another website in the browser: no (it could open window after window).
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
			http.Error(w, "forbidden", 403)
			return
		}
		ui.mu.Lock()
		ok := time.Since(ui.lastShow) > 3*time.Second
		if ok {
			ui.lastShow = time.Now()
		}
		ui.mu.Unlock()
		if ok {
			ui.open()
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"app": "watchparty-encoder", "version": version})
	})
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		if !ui.hasCookie(r) {
			http.Error(w, "forbidden", 403)
			return
		}
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
		if r.Method == http.MethodPost && r.URL.Path != "/api/show" && (r.Header.Get("X-Token") != ui.token || !ui.hasCookie(r)) {
			http.Error(w, "forbidden", 403)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		mux.ServeHTTP(w, r)
	})
}

const lockedPage = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Encodeur GPU</title>
<body style="font:15px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px"><p>Cette page s'ouvre depuis l'app (icône Watch Party près de l'horloge, ou en relançant l'encodeur).</p>
<button style="font:inherit;padding:8px 16px" onclick="fetch('/api/show',{method:'POST'})">Ouvrir la fenêtre</button></div></body></html>`

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
