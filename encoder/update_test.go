package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.2.0", "1.1.9", true},
		{"1.10.0", "1.9.0", true},
		{"1.1.0", "1.1.0", false},
		{"1.0.9", "1.1.0", false},
		{"v2.0.0", "1.9.9", true},
		{"1.1.0", "dev", true},
		{"1.1.0", "docker", true},
		{"dev", "1.0.0", false},
		{"1.1", "1.0.0", false},
	}
	for _, c := range cases {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestFindSum(t *testing.T) {
	sums := strings.Repeat("a", 64) + "  watchparty-encoder-linux-amd64\n" + strings.Repeat("B", 64) + " *watchparty-encoder-windows-amd64.exe\n"
	if got := findSum(sums, "watchparty-encoder-windows-amd64.exe"); got != strings.Repeat("b", 64) {
		t.Fatalf("got %q", got)
	}
	if findSum(sums, "watchparty-encoder-darwin-arm64") != "" {
		t.Fatal("missing file must give nothing")
	}
}

func TestValidRepo(t *testing.T) {
	for _, ok := range []string{"amintt2/stremio-watch-party", "a/b", "Org.Name/repo_1"} {
		if !validRepo(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "a", "/b", "a/", "a/b/c", "a b/c", "../x", "a/b?x=1"} {
		if validRepo(bad) {
			t.Errorf("%q should be refused", bad)
		}
	}
}

// The site source: version + checksum from /api/encoder/latest, then the file with the
// key; a file that doesn't match its checksum is never installed.
func TestUpdateFromServer(t *testing.T) {
	build := []byte("new build")
	sum := sha256.Sum256(build)
	good := hex.EncodeToString(sum[:])
	checksum := good
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wpe_test" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/encoder/latest":
			_ = json.NewEncoder(w).Encode(map[string]any{"version": "9.0.0", "files": map[string]any{platformFile(): map[string]string{"sha256": checksum}}})
		case "/api/encoder/update/" + platformFile():
			_, _ = w.Write(build)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("APPDATA", t.TempDir())
	setCurrentSettings(Settings{Server: srv.URL, Key: "wpe_test"})
	updatePrefs(func(p *Prefs) { p.UpdateSource = "server" })

	rel, err := checkUpdate(context.Background())
	if err != nil || rel == nil || rel.Version != "9.0.0" {
		t.Fatalf("check: %v %+v", err, rel)
	}
	data, err := fetch(context.Background(), rel.URL, "wpe_test", 1<<20, nil)
	if err != nil || string(data) != "new build" {
		t.Fatalf("download: %v %q", err, data)
	}

	// Replacing a file in place, as the app does with itself.
	exe := filepath.Join(t.TempDir(), "app")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	_ = os.WriteFile(exe, []byte("old build"), 0o755)
	if err := replaceSelf(exe, data); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "new build" {
		t.Fatalf("replaced with %q", got)
	}

	// A wrong checksum: refused before anything is written.
	checksum = strings.Repeat("0", 64)
	if _, err := checkUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := installUpdate(context.Background()); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("a corrupted file must be refused, got %v", err)
	}
}
