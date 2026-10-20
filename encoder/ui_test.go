package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The window answers this PC only, and actions need the page's token (another website
// open in the browser can't press "Quitter" or change the update source).
func TestWindowGuards(t *testing.T) {
	ui := &UI{token: "secret", pair: make(chan Settings, 1), retry: make(chan struct{}, 1), quit: func() {}}
	h := ui.routes("127.0.0.1:47470")
	do := func(method, path, host, token string) int {
		r := httptest.NewRequest(method, path, strings.NewReader("{}"))
		r.Host = host
		if token != "" {
			r.Header.Set("X-Token", token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c := do("GET", "/api/status", "127.0.0.1:47470", ""); c != 200 {
		t.Fatalf("status: %d", c)
	}
	if c := do("GET", "/api/status", "evil.example:47470", ""); c != http.StatusForbidden {
		t.Fatalf("other host: %d", c)
	}
	if c := do("POST", "/api/retry", "127.0.0.1:47470", ""); c != http.StatusForbidden {
		t.Fatalf("no token: %d", c)
	}
	if c := do("POST", "/api/retry", "127.0.0.1:47470", "wrong"); c != http.StatusForbidden {
		t.Fatalf("wrong token: %d", c)
	}
	if c := do("POST", "/api/retry", "127.0.0.1:47470", "secret"); c != 200 {
		t.Fatalf("with token: %d", c)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Host = "127.0.0.1:47470"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if !strings.Contains(w.Body.String(), "const TOKEN = 'secret'") {
		t.Fatal("the page carries its token")
	}
}
