// Watch Party encoder: runs on a room member's PC and transcodes the film with its GPU
// (NVENC, Quick Sync, AMF, VideoToolbox, VA-API) into the qualities viewers ask for,
// instead of the server. It connects out to the Watch Party server (no port to open),
// reads the film from it and sends back short MPEG-TS segments.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Set at build time (-ldflags "-X main.version=…").
var version = "dev"

func main() {
	var flags Settings
	ffmpegFlag := flag.String("ffmpeg", "", "chemin de ffmpeg (sinon : à côté du programme, dans le PATH, ou téléchargé)")
	encoderFlag := flag.String("encoder", "", "forcer un encodeur : nvenc, qsv, amf, mf, videotoolbox, vaapi, software")
	flag.StringVar(&flags.Server, "server", "", "adresse du site Watch Party")
	flag.StringVar(&flags.Key, "key", "", "clé de jumelage (wpe_…)")
	flag.Parse()

	fmt.Printf("Watch Party — Encodeur GPU %s (%s/%s)\n\n", version, runtime.GOOS, runtime.GOARCH)
	settings, err := loadSettings(flags)
	if err != nil {
		fatal(err)
	}
	ffmpeg, err := findFFmpeg(*ffmpegFlag)
	if err != nil {
		fatal(err)
	}
	logf("ffmpeg : %s", ffmpeg)

	enc, err := probeEncoders(ffmpeg, *encoderFlag)
	if err != nil {
		fatal(err)
	}
	device := gpuName()
	logf("Encodeur : %s (%s)%s, jusqu'à %dp", enc.Label, enc.Codec, optional(" — "+device, device != ""), enc.MaxHeight)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	agent := &Agent{settings: settings, ffmpeg: ffmpeg, enc: enc, device: device, jobs: map[string]*Job{}}
	agent.run(ctx)
}

// Agent keeps the connection to the server and runs its jobs.
type Agent struct {
	settings Settings
	ffmpeg   string
	enc      *Encoder
	device   string

	mu   sync.Mutex
	conn *websocket.Conn
	jobs map[string]*Job
}

func (a *Agent) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := a.session(ctx)
		if ctx.Err() != nil {
			break
		}
		if errors.Is(err, errUnauthorized) {
			fatal(errors.New("clé refusée par le serveur : ce PC a été retiré ou la clé est invalide. Retélécharge l'encodeur depuis Paramètres → Encodeur GPU"))
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		logf("Connexion perdue (%v), nouvel essai dans %v", err, backoff)
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	a.stopAll()
	logf("Arrêté.")
}

var errUnauthorized = errors.New("unauthorized")

func (a *Agent) session(ctx context.Context) error {
	u, err := url.Parse(a.settings.Server)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/api/encoder/ws"
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(dialCtx, u.String(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + a.settings.Key}},
	})
	if err != nil {
		if resp != nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
			return errUnauthorized
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.conn = nil
		a.mu.Unlock()
		// The server takes the films back when we leave: stop encoding them.
		a.stopAll()
	}()

	a.send(map[string]any{
		"type": "hello", "version": version, "os": runtime.GOOS, "encoder": a.enc.Label,
		"device": a.device, "maxHeight": a.enc.MaxHeight,
	})
	logf("Connecté à %s — prêt. Laisse cette fenêtre ouverte (réduite) pendant la séance.", a.settings.Server)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) && ce.Code == 4001 {
				return errUnauthorized
			}
			return err
		}
		var msg ServerMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		a.handle(ctx, msg)
	}
}

// ServerMessage is any message from the server (see server/src/encoder.js).
type ServerMessage struct {
	Type  string          `json:"type"`
	Job   json.RawMessage `json:"job"`
	Start int             `json:"start"`
	Until int             `json:"until"`
	Video []Rendition     `json:"video"`
	Audio []int           `json:"audio"`
}

func (a *Agent) handle(ctx context.Context, msg ServerMessage) {
	switch msg.Type {
	case "job":
		var spec JobSpec
		if json.Unmarshal(msg.Job, &spec) != nil || spec.ID == "" {
			return
		}
		a.mu.Lock()
		if _, ok := a.jobs[spec.ID]; !ok {
			a.jobs[spec.ID] = newJob(a, spec)
		}
		a.mu.Unlock()
		logf("Nouveau film à préparer (%s)", formatDuration(spec.Duration))
	default:
		var id string
		if json.Unmarshal(msg.Job, &id) != nil {
			return
		}
		a.mu.Lock()
		job := a.jobs[id]
		if msg.Type == "stop" {
			delete(a.jobs, id)
		}
		a.mu.Unlock()
		if job == nil {
			return
		}
		switch msg.Type {
		case "want":
			job.want(ctx, msg.Start, msg.Until, msg.Video, msg.Audio)
		case "extend":
			job.extend(msg.Until)
		case "stop":
			job.stop()
			logf("Film terminé ou repris par le serveur.")
		}
	}
}

func (a *Agent) send(v any) {
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn == nil {
		return
	}
	data, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = conn.Write(ctx, websocket.MessageText, data)
}

func (a *Agent) stopAll() {
	a.mu.Lock()
	jobs := a.jobs
	a.jobs = map[string]*Job{}
	a.mu.Unlock()
	for _, j := range jobs {
		j.stop()
	}
}

func logf(format string, args ...any) {
	fmt.Printf("%s  %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
}

// fatal explains the problem and waits for Entrée on Windows (the window would close).
func fatal(err error) {
	fmt.Fprintf(os.Stderr, "\nErreur : %v\n", err)
	if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stderr, "\nAppuie sur Entrée pour fermer.")
		_, _ = fmt.Scanln()
	}
	os.Exit(1)
}

func optional(s string, ok bool) string {
	if ok {
		return s
	}
	return ""
}

func formatDuration(s float64) string {
	d := time.Duration(s) * time.Second
	return fmt.Sprintf("%dh%02d", int(d.Hours()), int(d.Minutes())%60)
}
