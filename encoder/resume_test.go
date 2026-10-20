package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A GPU faster than real time stops ffmpeg once far enough ahead; when the viewers get
// closer (extend), it must start again from there. It used to stay stopped for good: the
// segments after ~20 never came and the server took the film back.
func TestResumesWhenViewersGetCloser(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake ffmpeg is a shell script")
	}
	dir := t.TempDir()
	spawns := filepath.Join(dir, "spawns.log")
	fake := filepath.Join(dir, "ffmpeg")
	script := `#!/bin/sh
csv=""; pat=""; start=0; prev=""
for a in "$@"; do
  case "$a" in *.csv) csv="$a";; *%d.ts) pat="$a";; esac
  [ "$prev" = "-segment_start_number" ] && start=$a
  prev=$a
done
echo "$start" >> ` + spawns + `
i=$start
while true; do f=$(echo "$pat" | sed "s/%d/$i/"); echo x > "$f"; echo "$i.ts,0,4" >> "$csv"; i=$((i+1)); sleep 0.02; done
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	var maxIdx atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Path, "/")
		if i, err := strconv.ParseInt(parts[len(parts)-1], 10, 64); err == nil && i > maxIdx.Load() {
			maxIdx.Store(i)
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()

	a := &Agent{settings: Settings{Server: srv.URL, Key: "wpe_k"}, ffmpeg: fake, enc: &Encoder{Name: "software", Codec: "libx264"}, jobs: map[string]*Job{}}
	j := newJob(a, JobSpec{ID: "j", Source: "/api/encoder/source/j", Duration: 7200, Segment: 4})
	defer j.stop()
	j.want(context.Background(), 0, 20, []Rendition{{ID: "720", Width: 1280, Height: 720, Bitrate: 3000000}}, nil)

	waitFor := func(what string, ok func() bool) {
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			if ok() {
				return
			}
		}
		t.Fatalf("%s (last segment %d)", what, maxIdx.Load())
	}
	waitFor("first run reaches segment 20", func() bool { return maxIdx.Load() >= 20 })
	time.Sleep(600 * time.Millisecond)
	stopped := maxIdx.Load()
	time.Sleep(600 * time.Millisecond)
	if got := maxIdx.Load(); got != stopped || got >= 60 {
		t.Fatalf("should stop once far enough ahead (before 60), got %d then %d", stopped, got)
	}
	j.extend(60)
	waitFor("resumes up to 60 after extend", func() bool { return maxIdx.Load() >= 60 })
	data, _ := os.ReadFile(spawns)
	starts := strings.Fields(string(data))
	if len(starts) < 2 || starts[0] != "0" || starts[1] == "0" {
		t.Fatalf("a second ffmpeg should start where the first stopped, starts: %v", starts)
	}
}
