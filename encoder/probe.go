package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Encoder is one way to encode H.264 on this machine. Like Sunshine, the candidates are
// tried in order with a real test encode, and the first that works is kept.
type Encoder struct {
	Name  string
	Label string
	Codec string
	// Quality options (this is a film, not a game stream: quality over latency).
	Args []string
	// Full GPU pipeline: decode and scale stay on the GPU (no copy to system memory).
	// Empty: decode with -hwaccel auto, scale on the CPU, encode on the GPU ("hybrid").
	DecodeArgs []string
	Scale      func(w, h int) string
	// Extra input options every run needs (VA-API device).
	DeviceArgs []string
	// Frames must be uploaded to the GPU after CPU filters (VA-API).
	Upload string
	// Options for keyframes on demand at segment boundaries.
	ForceIDR  []string
	MaxHeight int
}

func candidates() []*Encoder {
	nvenc := &Encoder{
		Name: "nvenc", Label: "NVIDIA NVENC", Codec: "h264_nvenc",
		Args:       []string{"-preset", "p5", "-tune", "hq", "-rc", "vbr", "-spatial-aq", "1", "-profile:v", "high"},
		DecodeArgs: []string{"-hwaccel", "cuda", "-hwaccel_output_format", "cuda"},
		Scale:      func(w, h int) string { return fmt.Sprintf("scale_cuda=%d:%d:format=nv12", w, h) },
		ForceIDR:   []string{"-forced-idr", "1"},
	}
	qsv := &Encoder{
		Name: "qsv", Label: "Intel Quick Sync", Codec: "h264_qsv",
		Args:       []string{"-preset", "medium", "-profile:v", "high", "-low_power", "1"},
		DecodeArgs: []string{"-hwaccel", "qsv", "-hwaccel_output_format", "qsv"},
		Scale:      func(w, h int) string { return fmt.Sprintf("vpp_qsv=w=%d:h=%d:format=nv12", w, h) },
		ForceIDR:   []string{"-forced_idr", "1"},
	}
	// Old / low-end Intel GPUs have no low-power encoder (Sunshine's fallback too).
	qsvFull := *qsv
	qsvFull.Name, qsvFull.Args = "qsv", []string{"-preset", "medium", "-profile:v", "high", "-low_power", "0"}
	amf := &Encoder{
		Name: "amf", Label: "AMD AMF", Codec: "h264_amf",
		Args: []string{"-quality", "balanced", "-rc", "vbr_peak", "-profile:v", "high"},
	}
	mf := &Encoder{
		Name: "mf", Label: "Windows Media Foundation", Codec: "h264_mf",
		Args: []string{"-hw_encoding", "1", "-rate_control", "quality"},
	}
	vt := &Encoder{
		Name: "videotoolbox", Label: "Apple VideoToolbox", Codec: "h264_videotoolbox",
		Args:       []string{"-profile:v", "high", "-allow_sw", "0"},
		DecodeArgs: []string{"-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"},
		Scale:      func(w, h int) string { return fmt.Sprintf("scale_vt=w=%d:h=%d", w, h) },
	}
	vaapi := &Encoder{
		Name: "vaapi", Label: "VA-API", Codec: "h264_vaapi",
		Args:       []string{"-profile:v", "high"},
		DeviceArgs: []string{"-vaapi_device", "/dev/dri/renderD128"},
		DecodeArgs: []string{"-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"},
		Scale:      func(w, h int) string { return fmt.Sprintf("scale_vaapi=w=%d:h=%d:format=nv12", w, h) },
		Upload:     "hwupload",
	}
	software := &Encoder{
		Name: "software", Label: "Processeur (x264, sans GPU)", Codec: "libx264",
		Args: []string{"-preset", "veryfast", "-profile:v", "high"},
	}
	switch runtime.GOOS {
	case "windows":
		return []*Encoder{nvenc, qsv, &qsvFull, amf, mf, software}
	case "darwin":
		return []*Encoder{vt, software}
	default:
		return []*Encoder{nvenc, vaapi, qsv, &qsvFull, software}
	}
}

// probeEncoders keeps the first encoder that really encodes here (a driver can be
// installed without the hardware, or the other way round).
func probeEncoders(ffmpeg, forced string) (*Encoder, error) {
	have := ffmpegEncoders(ffmpeg)
	var tried []string
	for _, e := range candidates() {
		if forced != "" && e.Name != forced {
			continue
		}
		if !strings.Contains(have, e.Codec) {
			continue
		}
		tried = append(tried, e.Label)
		if err := testEncode(ffmpeg, e, 1280, 720); err != nil {
			continue
		}
		e.MaxHeight = 1080
		if testEncode(ffmpeg, e, 3840, 2160) == nil {
			e.MaxHeight = 2160
		}
		if e.Name == "software" {
			logf("Aucun encodeur GPU utilisable (%s) : le processeur encodera, en 1080p au plus.", strings.Join(tried, ", "))
			e.MaxHeight = 1080
		}
		return e, nil
	}
	if forced != "" {
		return nil, fmt.Errorf("l'encodeur %q ne fonctionne pas sur ce PC", forced)
	}
	return nil, errors.New("aucun encodeur H.264 ne fonctionne avec ce ffmpeg")
}

// quiet: no console window flashing on Windows (the app has none of its own).
func quiet(cmd *exec.Cmd) *exec.Cmd {
	hideWindow(cmd)
	return cmd
}

func ffmpegEncoders(ffmpeg string) string {
	out, _ := quiet(exec.Command(ffmpeg, "-hide_banner", "-encoders")).Output()
	return string(out)
}

func testEncode(ffmpeg string, e *Encoder, w, h int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	args = append(args, e.DeviceArgs...)
	args = append(args, "-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=30", w, h), "-frames:v", "30")
	vf := "format=nv12"
	if e.Upload != "" {
		vf += "," + e.Upload
	}
	args = append(args, "-vf", vf, "-c:v", e.Codec)
	args = append(args, e.Args...)
	args = append(args, "-b:v", "4M", "-f", "null", "-")
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, lastLines(string(out), 3))
	}
	return nil
}

// gpuName is only shown to people ("NVIDIA GeForce RTX 3070"), best effort.
func gpuName() string {
	var out []byte
	switch runtime.GOOS {
	case "windows":
		out, _ = quiet(exec.Command("powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name")).Output()
	case "darwin":
		raw, _ := quiet(exec.Command("system_profiler", "SPDisplaysDataType")).Output()
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, "Chipset Model:") {
				return strings.TrimSpace(strings.SplitN(line, ":", 2)[1])
			}
		}
	default:
		out, _ = quiet(exec.Command("nvidia-smi", "--query-gpu=name", "--format=csv,noheader")).Output()
		if len(out) == 0 {
			raw, _ := quiet(exec.Command("lspci")).Output()
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.Contains(line, "VGA") || strings.Contains(line, "3D controller") {
					if parts := strings.SplitN(line, ": ", 2); len(parts) == 2 {
						return strings.TrimSpace(parts[1])
					}
				}
			}
		}
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	// Several adapters (iGPU + dGPU): the discrete one is usually listed last on Windows.
	for i := len(lines) - 1; i >= 0; i-- {
		if name := strings.TrimSpace(lines[i]); name != "" {
			return name
		}
	}
	return ""
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
