package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// JobSpec is a film handed to this PC (see attach in server/src/encoder.js).
type JobSpec struct {
	ID       string  `json:"id"`
	Source   string  `json:"source"`
	Duration float64 `json:"duration"`
	Segment  float64 `json:"segment"`
	Video    struct {
		Codec  string  `json:"codec"`
		Width  int     `json:"width"`
		Height int     `json:"height"`
		Fps    float64 `json:"fps"`
		HDR    bool    `json:"hdr"`
	} `json:"video"`
	Audio int `json:"audio"`
}

var (
	jobIDRe     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	sourceRe    = regexp.MustCompile(`^/api/encoder/source/[A-Za-z0-9_-]{1,64}(\?t=[A-Za-z0-9_-]{1,128})?$`)
	renditionRe = regexp.MustCompile(`^\d{3,4}$`)
)

// validSpec: what the server sends goes into file names and ffmpeg's command line.
func validSpec(s JobSpec) bool {
	return jobIDRe.MatchString(s.ID) && sourceRe.MatchString(s.Source) && s.Duration >= 0 && s.Segment >= 0 && s.Segment <= 60
}

func validWant(m ServerMessage) bool {
	if m.Start < 0 || m.Until < m.Start || len(m.Video) > 8 || len(m.Audio) > 16 {
		return false
	}
	for _, v := range m.Video {
		if !renditionRe.MatchString(v.ID) || v.Width <= 0 || v.Width > 8192 || v.Height <= 0 || v.Height > 8192 || v.Bitrate <= 0 || v.Bitrate > 200_000_000 {
			return false
		}
	}
	for _, a := range m.Audio {
		if a < 0 || a > 63 {
			return false
		}
	}
	return true
}

// Rendition is one video quality to make.
type Rendition struct {
	ID      string `json:"id"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Bitrate int    `json:"bitrate"`
}

// Job encodes one film: one ffmpeg run at a time, covering every rendition someone
// watches (one decode for all), from a segment index up to another.
type Job struct {
	agent *Agent
	spec  JobSpec

	mu  sync.Mutex
	run *run
	// The full GPU pipeline failed once on this film: decode/scale on the CPU instead.
	// Atomic: set by the encoding goroutine while want/stop hold mu waiting for it.
	hybrid atomic.Bool
}

type run struct {
	cancel context.CancelFunc
	done   chan struct{}
	// First segment of the current ffmpeg process (moves on when it restarts further).
	start atomic.Int64
	until atomic.Int64
	// The viewers got closer (extend): an ffmpeg stopped for being far enough ahead resumes.
	wake  chan struct{}
	video []Rendition
	audio []int
	// Highest segment sent, per rendition.
	sent sync.Map
}

func newJob(a *Agent, spec JobSpec) *Job {
	if spec.Segment <= 0 {
		spec.Segment = 4
	}
	return &Job{agent: a, spec: spec}
}

func (j *Job) want(ctx context.Context, start, until int, video []Rendition, audio []int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if r := j.run; r != nil && sameSet(r, video, audio) {
		// Already on it: just go further.
		if next := r.next(); start >= int(r.start.Load()) && start <= next+2 {
			r.raise(until)
			return
		}
	}
	j.stopLocked()
	r := &run{video: video, audio: audio, done: make(chan struct{}), wake: make(chan struct{}, 1)}
	r.start.Store(int64(start))
	r.until.Store(int64(until))
	names := make([]string, 0, len(video))
	for _, v := range video {
		names = append(names, v.ID+"p")
	}
	status.job(j.spec.ID, func(js *JobStatus) {
		js.Renditions, js.From, js.Done, js.Error = names, start, start, ""
		js.LastAt = time.Now().Unix()
	})
	runCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	j.run = r
	go j.execute(runCtx, r)
}

func (j *Job) extend(until int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.run != nil {
		j.run.raise(until)
	}
}

// raise: encode up to `until` now (and wake the run if it was waiting for it).
func (r *run) raise(until int) {
	r.until.Store(int64(max(int(r.until.Load()), until)))
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (j *Job) stop() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.stopLocked()
}

func (j *Job) stopLocked() {
	if j.run == nil {
		return
	}
	j.run.cancel()
	<-j.run.done
	j.run = nil
}

func sameSet(r *run, video []Rendition, audio []int) bool {
	if len(r.video) != len(video) || len(r.audio) != len(audio) {
		return false
	}
	for i := range video {
		if r.video[i].ID != video[i].ID {
			return false
		}
	}
	for i := range audio {
		if r.audio[i] != audio[i] {
			return false
		}
	}
	return true
}

// next: the lowest "next segment" over the renditions (where the run is now).
func (r *run) next() int {
	lowest := math.MaxInt
	for _, name := range r.names() {
		v, ok := r.sent.Load(name)
		n := int(r.start.Load())
		if ok {
			n = v.(int) + 1
		}
		lowest = min(lowest, n)
	}
	return lowest
}

func (r *run) names() []string {
	var names []string
	for _, v := range r.video {
		names = append(names, "v"+v.ID)
	}
	for _, a := range r.audio {
		names = append(names, fmt.Sprintf("a%d", a))
	}
	return names
}

func (j *Job) execute(ctx context.Context, r *run) {
	defer close(r.done)
	last := int(math.Ceil(j.spec.Duration/j.spec.Segment)) - 1
	for ctx.Err() == nil {
		produced, ok := j.encodeOnce(ctx, r)
		if !ok || ctx.Err() != nil {
			return
		}
		next := r.next()
		if next > last || produced == 0 {
			return // the end of the film (or ffmpeg has nothing more to give)
		}
		// Stopped far enough ahead of the viewers: wait for them to get closer (the server
		// raises `until`), then go on from where it stopped, in a new ffmpeg.
		for next > int(r.until.Load()) {
			select {
			case <-ctx.Done():
				return
			case <-r.wake:
			}
		}
		r.start.Store(int64(next))
	}
}

// encodeOnce runs ffmpeg once (falling back to CPU decoding if the full GPU pipeline
// can't take this file). ok=false: an error the server was told about.
func (j *Job) encodeOnce(ctx context.Context, r *run) (int, bool) {
	for attempt := 0; attempt < 2; attempt++ {
		hybrid := j.hybrid.Load() || j.agent.enc.Scale == nil || j.spec.Video.HDR
		produced, err := j.encode(ctx, r, hybrid)
		if ctx.Err() != nil || err == nil {
			return produced, true
		}
		if !hybrid && produced == 0 {
			// Same as Sunshine falling back: the GPU-only pipeline isn't supported for this
			// file (decoder, pixel format); decode and scale on the CPU, encode on the GPU.
			logf("Pipeline GPU complet impossible pour ce fichier (%v) : décodage sur le processeur.", err)
			j.hybrid.Store(true)
			continue
		}
		logf("Erreur d'encodage : %v", err)
		status.job(j.spec.ID, func(js *JobStatus) { js.Error = err.Error() })
		j.agent.send(map[string]any{"type": "error", "job": j.spec.ID, "message": err.Error()})
		return produced, false
	}
	return 0, false
}

// removeOldTemp: segment folders left by an app that was killed (only this copy runs,
// so anything older than an hour is nobody's).
func removeOldTemp() {
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "watchparty-encoder-*"))
	for _, d := range dirs {
		if fi, err := os.Stat(d); err == nil && fi.IsDir() && time.Since(fi.ModTime()) > time.Hour {
			_ = os.RemoveAll(d)
		}
	}
}

// encode runs ffmpeg for one run. Returns how many segments were sent.
func (j *Job) encode(ctx context.Context, r *run, hybrid bool) (int, error) {
	dir, err := os.MkdirTemp("", "watchparty-encoder-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(dir)
	for _, name := range r.names() {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			return 0, err
		}
	}
	args := j.args(r, dir, hybrid)
	ffCtx, kill := context.WithCancel(ctx)
	defer kill()
	cmd := exec.CommandContext(ffCtx, j.agent.ffmpeg, args...)
	hideWindow(cmd)
	own(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, _ := cmd.StdoutPipe()
	label := make([]string, 0, len(r.video))
	for _, v := range r.video {
		label = append(label, v.ID+"p")
	}
	pipeline := map[bool]string{true: "décodage sur le processeur", false: "tout sur le GPU"}[hybrid]
	status.job(j.spec.ID, func(js *JobStatus) { js.Pipeline = pipeline })
	logf("Encodage %s à partir de %s (%s)", strings.Join(label, " + "), clock(float64(r.start.Load())*j.spec.Segment), pipeline)
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	adopt(cmd)
	go j.readProgress(stdout)

	var sentCount atomic.Int64
	uploads := make(chan upload, 64)
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for u := range uploads {
				if j.put(ctx, u) == nil {
					sentCount.Add(1)
					prev, _ := r.sent.Load(u.name)
					if p, ok := prev.(int); !ok || u.index > p {
						r.sent.Store(u.name, u.index)
					}
					done := r.next()
					status.set(func(s *Status) { s.Segments++ })
					status.job(j.spec.ID, func(js *JobStatus) {
						js.Done = max(js.Done, done)
						js.LastAt = time.Now().Unix()
					})
				}
				os.Remove(u.path)
			}
		}()
	}

	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	seen := map[string]int{}
	var waitErr error
	finished := false
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for !finished {
		select {
		case waitErr = <-exited:
			finished = true
		case <-tick.C:
		}
		// New finished segments: each list file gets a line when a segment is closed.
		for _, name := range r.names() {
			lines := readLines(filepath.Join(dir, name+".csv"))
			for _, line := range lines[min(seen[name], len(lines)):] {
				file := strings.SplitN(line, ",", 2)[0]
				index, err := strconv.Atoi(strings.TrimSuffix(file, ".ts"))
				if err != nil {
					continue
				}
				uploads <- upload{name: name, index: index, path: filepath.Join(dir, name, file)}
			}
			seen[name] = len(lines)
		}
		// Far enough ahead of the viewers: stop (the server asks again when they get closer).
		if !finished && r.next() > int(r.until.Load()) {
			kill()
		}
	}
	close(uploads)
	wg.Wait()
	sent := int(sentCount.Load())
	if ctx.Err() != nil || ffCtx.Err() != nil {
		return sent, nil
	}
	if waitErr != nil {
		return sent, fmt.Errorf("%v: %s", waitErr, lastLines(stderr.String(), 4))
	}
	return sent, nil
}

type upload struct {
	name  string
	index int
	path  string
}

func (j *Job) put(ctx context.Context, u upload) error {
	data, err := os.ReadFile(u.path)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/api/encoder/segment/%s/%s/%d", strings.TrimSuffix(j.agent.settings.Server, "/"), j.spec.ID, u.name, u.index)
	for attempt := 0; attempt < 3; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+j.agent.settings.Key)
		req.Header.Set("Content-Type", "video/mp2t")
		resp, err := httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 300 {
				return nil
			}
			if resp.StatusCode == 409 || resp.StatusCode == 401 {
				return fmt.Errorf("refusé (%d)", resp.StatusCode)
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		time.Sleep(time.Duration(attempt+1) * time.Second)
	}
	return fmt.Errorf("envoi du segment %s/%d impossible", u.name, u.index)
}

var httpClient = &http.Client{Timeout: 2 * time.Minute}

func (j *Job) readProgress(stdout interface{ Read([]byte) (int, error) }) {
	scanner := bufio.NewScanner(stdout)
	last := time.Time{}
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "fps=") || time.Since(last) < 5*time.Second {
			continue
		}
		if fps, err := strconv.ParseFloat(strings.TrimPrefix(line, "fps="), 64); err == nil {
			last = time.Now()
			status.job(j.spec.ID, func(js *JobStatus) { js.Fps = fps })
			j.agent.send(map[string]any{"type": "progress", "job": j.spec.ID, "fps": fps})
		}
	}
}

// args builds the ffmpeg command line: one input, every rendition as its own output with
// the segment muxer on the server's fixed grid (segment i = i × 4 s).
func (j *Job) args(r *run, dir string, hybrid bool) []string {
	enc := j.agent.enc
	seg := j.spec.Segment
	startTime := float64(r.start.Load()) * seg
	fps := j.spec.Video.Fps
	if fps <= 0 || fps > 120 {
		fps = 24
	}
	gop := int(math.Round(fps * seg))

	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-stats_period", "2"}
	args = append(args, enc.DeviceArgs...)
	if !hybrid {
		args = append(args, enc.DecodeArgs...)
	} else if enc.Name != "software" {
		args = append(args, "-hwaccel", "auto")
	}
	if startTime > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", startTime))
	}
	// The source URL carries a token for this film only (?t=): the pairing key never goes on
	// ffmpeg's command line, where other programs on the PC could read it.
	src := strings.TrimSuffix(j.agent.settings.Server, "/") + j.spec.Source
	args = append(args,
		"-protocol_whitelist", "http,https,tcp,tls,crypto",
		"-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10", "-rw_timeout", "60000000")
	args = append(args, "-i", src)

	// Video: one decode, split into every rendition.
	var graph []string
	n := len(r.video)
	if n > 0 {
		pre := "[0:v:0]"
		chain := ""
		if hybrid && j.spec.Video.HDR {
			// HDR → SDR (browsers get H.264 8-bit): tone mapping on the CPU.
			chain = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"
		}
		if n == 1 {
			graph = append(graph, pre+chain+j.scale(r.video[0], hybrid)+"[o0]")
		} else {
			outs := ""
			for i := range r.video {
				outs += fmt.Sprintf("[s%d]", i)
			}
			graph = append(graph, fmt.Sprintf("%s%ssplit=%d%s", pre, chain, n, outs))
			for i, v := range r.video {
				graph = append(graph, fmt.Sprintf("[s%d]%s[o%d]", i, j.scale(v, hybrid), i))
			}
		}
		args = append(args, "-filter_complex", strings.Join(graph, ";"))
	}

	segmentArgs := func(name string) []string {
		return []string{
			"-output_ts_offset", fmt.Sprintf("%.3f", startTime),
			"-f", "segment", "-segment_format", "mpegts", "-segment_time", fmt.Sprintf("%g", seg),
			"-segment_start_number", strconv.Itoa(int(r.start.Load())),
			"-segment_list", filepath.Join(dir, name+".csv"), "-segment_list_type", "csv",
			filepath.Join(dir, name, "%d.ts"),
		}
	}
	for i, v := range r.video {
		args = append(args, "-map", fmt.Sprintf("[o%d]", i), "-an", "-sn", "-dn", "-c:v", enc.Codec)
		args = append(args, enc.Args...)
		args = append(args, enc.ForceIDR...)
		args = append(args,
			"-b:v", strconv.Itoa(v.Bitrate), "-maxrate", strconv.Itoa(v.Bitrate*3/2), "-bufsize", strconv.Itoa(v.Bitrate*2),
			"-g", strconv.Itoa(gop), "-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%g)", seg))
		if enc.Name == "software" {
			args = append(args, "-sc_threshold", "0", "-pix_fmt", "yuv420p")
		}
		args = append(args, segmentArgs("v"+v.ID)...)
	}
	for _, a := range r.audio {
		args = append(args, "-map", fmt.Sprintf("0:a:%d?", a), "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000")
		args = append(args, segmentArgs(fmt.Sprintf("a%d", a))...)
	}
	return args
}

// scale: on the GPU in the full pipeline, else on the CPU (then uploaded if the encoder
// needs GPU frames).
func (j *Job) scale(v Rendition, hybrid bool) string {
	enc := j.agent.enc
	if !hybrid && enc.Scale != nil {
		return enc.Scale(v.Width, v.Height)
	}
	s := fmt.Sprintf("scale=%d:%d:flags=bicubic,format=nv12", v.Width, v.Height)
	if enc.Upload != "" {
		s += "," + enc.Upload
	}
	return s
}

func readLines(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var lines []string
	for _, l := range strings.Split(string(data), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	// The last line may still be written: only count complete lines.
	if len(data) > 0 && data[len(data)-1] != '\n' && len(lines) > 0 {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func clock(s float64) string {
	t := int(s)
	return fmt.Sprintf("%d:%02d:%02d", t/3600, t/60%60, t%60)
}
