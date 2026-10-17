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
