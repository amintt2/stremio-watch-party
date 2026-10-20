package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The window answers this PC only, and actions need the page's token (another website
// open in the browser can't press "Quitter" or change the update source).
func TestWindowGuards(t *testing.T) {
	ui := &UI{url: "http://127.0.0.1:47470/", token: "secret", pair: make(chan Settings, 1), retry: make(chan struct{}, 1), quit: func() {}}
	h := ui.routes("127.0.0.1:47470")
	do := func(method, path, host, token string, cookie bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader("{}"))
		r.Host = host
		if token != "" {
			r.Header.Set("X-Token", token)
		}
		if cookie {
			r.AddCookie(&http.Cookie{Name: uiCookie, Value: "secret"})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	const local = "127.0.0.1:47470"
	if c := do("GET", "/api/status", local, "", true).Code; c != 200 {
		t.Fatalf("status: %d", c)
	}
	if c := do("GET", "/api/status", local, "", false).Code; c != http.StatusForbidden {
		t.Fatalf("status without the window's cookie: %d", c)
	}
	if c := do("GET", "/api/status", "evil.example:47470", "", true).Code; c != http.StatusForbidden {
		t.Fatalf("other host: %d", c)
	}
	if c := do("POST", "/api/retry", local, "", true).Code; c != http.StatusForbidden {
		t.Fatalf("no token: %d", c)
	}
	if c := do("POST", "/api/retry", local, "wrong", true).Code; c != http.StatusForbidden {
		t.Fatalf("wrong token: %d", c)
	}
	if c := do("POST", "/api/retry", local, "secret", false).Code; c != http.StatusForbidden {
		t.Fatalf("token without cookie: %d", c)
	}
	if c := do("POST", "/api/retry", local, "secret", true).Code; c != 200 {
		t.Fatalf("with token: %d", c)
	}
	// The page (and its token) only for the browser the app opened.
	w := do("GET", "/", local, "", false)
	if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("page given without the link: %d", w.Code)
	}
	if w.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatal("the window can be framed")
	}
	ui.links = map[string]time.Time{"onetime": time.Now()}
	w = do("GET", "/?k=onetime", local, "", false)
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Set-Cookie"), uiCookie+"=secret") {
		t.Fatalf("one-time link: %d %q", w.Code, w.Header().Get("Set-Cookie"))
	}
	if w = do("GET", "/?k=onetime", local, "", false); strings.Contains(w.Header().Get("Set-Cookie"), uiCookie) {
		t.Fatal("the link works twice")
	}
	if w = do("GET", "/", local, "", true); !strings.Contains(w.Body.String(), "const TOKEN = 'secret'") {
		t.Fatal("the page carries its token")
	}
}
