package main

import (
	"os"
	"strings"
	"testing"
)

func writeFile(path, s string) error { return os.WriteFile(path, []byte(s), 0o644) }

func testJob(enc *Encoder) *Job {
	a := &Agent{settings: Settings{Server: "https://watch.example", Key: "wpe_k"}, ffmpeg: "ffmpeg", enc: enc}
	spec := JobSpec{ID: "job1", Source: "/api/encoder/source/job1", Duration: 7200, Segment: 4}
	spec.Video.Fps = 23.976
	return newJob(a, spec)
}

func TestArgsFullGPUPipeline(t *testing.T) {
	var nvenc *Encoder
	for _, e := range candidates() {
		if e.Name == "nvenc" {
			nvenc = e
		}
	}
	if nvenc == nil {
		t.Skip("no NVENC candidate on this OS")
	}
	j := testJob(nvenc)
	r := &run{video: []Rendition{{ID: "1080", Width: 1920, Height: 1080, Bitrate: 6000000}, {ID: "720", Width: 1280, Height: 720, Bitrate: 3000000}}, audio: []int{0, 1}}
	r.start.Store(30)
	got := strings.Join(j.args(r, "/tmp/x", false), " ")
	for _, want := range []string{
		"-hwaccel cuda -hwaccel_output_format cuda",
		"-ss 120.000",
		"Authorization: Bearer wpe_k",
		"-i https://watch.example/api/encoder/source/job1",
		"[0:v:0]split=2[s0][s1];[s0]scale_cuda=1920:1080:format=nv12[o0];[s1]scale_cuda=1280:720:format=nv12[o1]",
		"-c:v h264_nvenc",
		"-forced-idr 1",
		"-g 96",
		"-force_key_frames expr:gte(t,n_forced*4)",
		"-output_ts_offset 120.000",
		"-segment_start_number 30",
		"-map 0:a:1? -vn -sn -dn -c:a aac",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
}

func TestArgsHybridHDRToneMapsOnCPU(t *testing.T) {
	sw := &Encoder{Name: "software", Codec: "libx264"}
	j := testJob(sw)
	j.spec.Video.HDR = true
	r := &run{video: []Rendition{{ID: "480", Width: 854, Height: 480, Bitrate: 1400000}}}
	got := strings.Join(j.args(r, "/tmp/x", true), " ")
	if !strings.Contains(got, "tonemap=hable") || !strings.Contains(got, "scale=854:480") || strings.Contains(got, "-ss ") || strings.Contains(got, "-hwaccel") {
		t.Errorf("unexpected: %s", got)
	}
}
