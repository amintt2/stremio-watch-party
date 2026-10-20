package main

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// Status is what the app's window shows (ui.go): connection, GPU, films, updates, log.
// Everything that changes it goes through these methods, under one lock.
type Status struct {
	mu sync.Mutex

	// connection: "starting", "setup" (no server/key yet), "ffmpeg" (downloading it),
	// "probing", "connecting", "connected", "refused" (key refused), "error".
	Connection string `json:"connection"`
	Message    string `json:"message"`
	Server     string `json:"server"`
	Since      int64  `json:"since"`

	Encoder   string `json:"encoder"`
	Codec     string `json:"codec"`
	Device    string `json:"device"`
	MaxHeight int    `json:"maxHeight"`
	FFmpeg    string `json:"ffmpeg"`
	// ffmpeg download, 0–100 (-1 when not downloading).
	Download int `json:"download"`

	Jobs map[string]*JobStatus `json:"-"`
	// Last time the server took a film back, and why.
	Stopped    string `json:"stopped"`
	StoppedAt  int64  `json:"stoppedAt"`
	RetryIn    int    `json:"retryIn"`
	Segments   int64  `json:"segments"`
	logs       []string
	Update     UpdateStatus `json:"update"`
	Version    string       `json:"version"`
	OS         string       `json:"os"`
	AutoStart  bool         `json:"autoStart"`
	AutoUpdate bool         `json:"autoUpdate"`
	Source     string       `json:"updateSource"`
	Repo       string       `json:"githubRepo"`
}

// JobStatus: one film this PC holds.
type JobStatus struct {
	ID         string   `json:"id"`
	Duration   float64  `json:"duration"`
	Renditions []string `json:"renditions"`
	From       int      `json:"from"`
	Done       int      `json:"done"`
	Total      int      `json:"total"`
	Fps        float64  `json:"fps"`
	Pipeline   string   `json:"pipeline"`
	Active     bool     `json:"active"`
	LastAt     int64    `json:"lastAt"`
	Error      string   `json:"error"`
}

// UpdateStatus: the latest version seen and what the updater is doing.
type UpdateStatus struct {
	Latest   string `json:"latest"`
	Checked  int64  `json:"checked"`
	State    string `json:"state"` // "", "checking", "available", "downloading", "installing", "uptodate", "error"
	Message  string `json:"message"`
	Progress int    `json:"progress"`
}

var status = &Status{Connection: "starting", Download: -1, Jobs: map[string]*JobStatus{}}

func (s *Status) set(fn func(s *Status)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s)
}

func (s *Status) connection(state, message string) {
	s.set(func(s *Status) {
		if s.Connection != state {
			s.Since = time.Now().Unix()
		}
		s.Connection = state
		s.Message = message
	})
}

func (s *Status) job(id string, fn func(j *JobStatus)) {
	s.set(func(s *Status) {
		j := s.Jobs[id]
		if j == nil {
			return
		}
		fn(j)
	})
}

func (s *Status) log(line string) {
	s.set(func(s *Status) {
		s.logs = append(s.logs, line)
		if len(s.logs) > 300 {
			s.logs = s.logs[len(s.logs)-300:]
		}
	})
}

// snapshot: a copy for the window, as JSON-ready data.
func (s *Status) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	jobs := make([]JobStatus, 0, len(s.Jobs))
	for _, j := range s.Jobs {
		c := *j
		c.Active = time.Since(time.Unix(j.LastAt, 0)) < 20*time.Second
		jobs = append(jobs, c)
	}
	sort.Slice(jobs, func(a, b int) bool { return jobs[a].ID < jobs[b].ID })
	return map[string]any{
		"connection": s.Connection, "message": s.Message, "server": s.Server, "since": s.Since,
		"encoder": s.Encoder, "codec": s.Codec, "device": s.Device, "maxHeight": s.MaxHeight,
		"ffmpeg": s.FFmpeg, "download": s.Download,
		"jobs": jobs, "stopped": s.Stopped, "stoppedAt": s.StoppedAt, "retryIn": s.RetryIn, "segments": s.Segments,
		"logs": append([]string(nil), s.logs...), "update": s.Update, "version": s.Version, "os": s.OS,
		"autoStart": s.AutoStart, "autoUpdate": s.AutoUpdate, "updateSource": s.Source, "githubRepo": s.Repo,
	}
}

func logf(format string, args ...any) {
	line := fmt.Sprintf("%s  %s", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
	fmt.Println(line)
	status.log(line)
}

// hostOf: "https://watch.example.com" → "watch.example.com".
func hostOf(server string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(server, "https://"), "http://")
	return strings.TrimSuffix(s, "/")
}

// fatal: only for command-line misuse; everything else is shown in the window.
func fatal(err error) {
	fmt.Fprintf(os.Stderr, "\nErreur : %v\n", err)
	os.Exit(1)
}
