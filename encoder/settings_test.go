package main

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestParseTrailer(t *testing.T) {
	// Same format as withTrailer in server/src/encoderRoutes.js.
	payload := base64.StdEncoding.EncodeToString([]byte(`{"server":"https://watch.example","key":"wpe_0123456789ab.abcdefghijklmnopqrstuvwxyz012345"}`))
	exe := append([]byte("MZ...program bytes...#WPCFG#bogus"), []byte("\n#WPCFG#"+payload+"#END#\n")...)
	s, err := parseTrailer(exe)
	if err != nil || !s.valid() || s.Server != "https://watch.example" || !strings.HasPrefix(s.Key, "wpe_") {
		t.Fatalf("got %+v, %v", s, err)
	}
	if _, err := parseTrailer([]byte("no settings here")); err == nil {
		t.Fatal("expected an error without trailer")
	}
}

func TestReadLinesSkipsPartialLine(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/v.csv"
	if err := writeFile(path, "10.ts,0,44\n11.ts,44,48\n12.ts,4"); err != nil {
		t.Fatal(err)
	}
	if got := readLines(path); len(got) != 2 || got[1] != "11.ts,44,48" {
		t.Fatalf("got %q", got)
	}
}

// The key travels with every request: in clear only to this PC.
func TestSettingsRefuseClearTextServer(t *testing.T) {
	for server, want := range map[string]bool{
		"https://watch.example":  true,
		"http://localhost:3001":  true,
		"http://127.0.0.1:3001":  true,
		"http://watch.example":   false,
		"http://192.168.1.2:300": false,
		"ftp://watch.example":    false,
	} {
		if got := (Settings{Server: server, Key: "wpe_x"}).valid(); got != want {
			t.Errorf("%s: %v", server, got)
		}
	}
}

// A pairing typed in the window wins over the one written in the program.
func TestTypedPairingIsUsed(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	if err := saveSettings(Settings{Server: "https://watch.example/", Key: "wpe_typed"}); err != nil {
		t.Fatal(err)
	}
	s, err := loadSettings(Settings{}, map[string]bool{})
	if err != nil || s.Key != "wpe_typed" || s.Server != "https://watch.example" || !s.Manual {
		t.Fatalf("got %+v, %v", s, err)
	}
	// Refused by the server: no longer used.
	if _, err := loadSettings(Settings{}, map[string]bool{"wpe_typed": true}); err == nil {
		t.Fatal("refused key still used")
	}
}
