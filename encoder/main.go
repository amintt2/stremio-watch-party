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
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
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
	background := flag.Bool("background", false, "démarrer sans ouvrir la fenêtre (lancement avec l'ordinateur)")
	noWindow := flag.Bool("no-window", false, "ne jamais ouvrir la fenêtre (serveur sans écran)")
	flag.Parse()

	fmt.Printf("Watch Party — Encodeur GPU %s (%s/%s)\n\n", version, runtime.GOOS, runtime.GOARCH)
	status.set(func(s *Status) { s.Version, s.OS = version, runtime.GOOS })
	loadPrefs()
	go removeOldBuild()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ui, existing, err := startUI(stop)
	if err != nil {
		fatal(err)
	}
	if existing != "" {
		// Already running: show its window instead of starting a second one.
		if !*background && !*noWindow {
			showOther(existing)
		}
		fmt.Println("L'encodeur tourne déjà :", existing)
		return
	}
	beforeExit = append(beforeExit, ui.close)
	go removeOldTemp()

	// First run: start with the computer (the room gets this GPU without anyone thinking of it).
	if p := currentPrefs(); !p.AutoStartSet && !*noWindow {
		if err := setAutoStart(true); err != nil {
			logf("Lancement avec l'ordinateur impossible : %v", err)
		}
		updatePrefs(func(p *Prefs) { p.AutoStartSet = true })
	}
	status.set(func(s *Status) { s.AutoStart = autoStartEnabled() })

	agent := &Agent{jobs: map[string]*Job{}}
	beforeExit = append(beforeExit, agent.stopAll)
	go agent.main(ctx, ui, flags, *ffmpegFlag, *encoderFlag)
	go updater(ctx, agent.idle)
	if !*background && !*noWindow {
		ui.open()
	}
	logf("Fenêtre de l'encodeur : %s", ui.url)
	runTray(ctx, ui.open, stop)
	shutdown()
	logf("Arrêté.")
}

// main keeps the app useful whatever happens: no pairing yet (waits for one from the
// window), no ffmpeg, a refused key, the server down. It never exits on its own.
func (a *Agent) main(ctx context.Context, ui *UI, flags Settings, ffmpegFlag, encoderFlag string) {
	refused := map[string]bool{}
	wait := func(d time.Duration) {
		select {
		case <-ctx.Done():
		case <-ui.retry:
		case <-ui.pair:
		case <-time.After(d):
		}
	}
	for ctx.Err() == nil {
		// ffmpeg and the GPU are looked up once (again after an error).
		if a.enc == nil {
			status.connection("ffmpeg", "")
			ffmpeg, err := findFFmpeg(ffmpegFlag)
			status.set(func(s *Status) { s.Download = -1 })
			if err != nil {
				status.connection("error", err.Error())
				logf("%v", err)
				wait(time.Minute)
				continue
			}
			status.set(func(s *Status) { s.FFmpeg = ffmpeg })
			logf("ffmpeg : %s", ffmpeg)
			status.connection("probing", "")
			enc, err := probeEncoders(ffmpeg, encoderFlag)
			if err != nil {
				status.connection("error", err.Error())
				logf("%v", err)
				wait(time.Minute)
				continue
			}
			device := gpuName()
			a.ffmpeg, a.enc, a.device = ffmpeg, enc, device
			status.set(func(s *Status) {
				s.Encoder, s.Codec, s.Device, s.MaxHeight = enc.Label, enc.Codec, device, enc.MaxHeight
			})
			logf("Encodeur : %s (%s)%s, jusqu'à %dp", enc.Label, enc.Codec, optional(" — "+device, device != ""), enc.MaxHeight)
		}

		settings, err := loadSettings(flags, refused)
		if err != nil {
			status.connection("setup", err.Error())
			select {
			case <-ctx.Done():
			case s := <-ui.pair:
				delete(refused, s.Key)
			case <-ui.retry:
				// "Réessayer": the keys refused before get another chance.
				clear(refused)
			}
			continue
		}
		setCurrentSettings(settings)
		a.settings = settings
		if err := a.run(ctx); errors.Is(err, errUnauthorized) {
			refused[settings.Key] = true
			if flags.Key == settings.Key {
				flags = Settings{}
			}
			status.connection("refused", "Ce PC a été retiré de ton compte, ou la clé n'est plus valable. Retélécharge l'encodeur depuis Paramètres → Encodeur GPU.")
			logf("Clé refusée par le serveur.")
			// Wait for a new pairing (or a retry) instead of hammering the server.
			select {
			case <-ctx.Done():
			case <-ui.pair:
			case <-ui.retry:
				clear(refused)
			case <-time.After(10 * time.Minute):
			}
		}
	}
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

func (a *Agent) run(ctx context.Context) error {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := a.session(ctx)
		if ctx.Err() != nil {
			break
		}
		if errors.Is(err, errUnauthorized) {
			a.stopAll()
			return err
		}
		if errors.Is(err, errReplaced) {
			// The same key connected from another PC: let that one work, try again later.
			status.connection("connecting", "Cette clé est utilisée sur un autre PC. Nouvel essai dans 5 min.")
			logf("Clé utilisée sur un autre PC ; nouvel essai dans 5 min.")
			select {
			case <-ctx.Done():
			case <-time.After(5 * time.Minute):
			}
			backoff = time.Second
			continue
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		status.connection("connecting", fmt.Sprintf("Connexion perdue (%v), nouvel essai dans %v", err, backoff))
		logf("Connexion perdue (%v), nouvel essai dans %v", err, backoff)
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	a.stopAll()
	return ctx.Err()
}

var (
	errUnauthorized = errors.New("unauthorized")
	errReplaced     = errors.New("replaced")
)

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
	status.connection("connecting", "")
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(dialCtx, u.String(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + a.settings.Key}},
	})
	if err != nil {
		// The server refuses a key by closing with 4001 once connected; an HTTP 401/403 here
		// comes from a proxy or a deploy in progress: retried like a network error.
		if resp != nil {
			return fmt.Errorf("%w (HTTP %d)", err, resp.StatusCode)
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
	status.connection("connected", "")
	logf("Connecté à %s — prêt. Il tourne en arrière-plan : rien à garder ouvert.", a.settings.Server)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) && ce.Code == 4001 {
				return errUnauthorized
			}
			if errors.As(err, &ce) && ce.Code == 4000 {
				return errReplaced
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
	// stop: why the server took the film back, and when it gives it again (s).
	Reason  string `json:"reason"`
	RetryIn int    `json:"retryIn"`
}

func (a *Agent) handle(ctx context.Context, msg ServerMessage) {
	switch msg.Type {
	case "job":
		var spec JobSpec
		if json.Unmarshal(msg.Job, &spec) != nil || !validSpec(spec) {
			return
		}
		a.mu.Lock()
		if _, ok := a.jobs[spec.ID]; !ok {
			a.jobs[spec.ID] = newJob(a, spec)
		}
		a.mu.Unlock()
		segment := spec.Segment
		if segment <= 0 {
			segment = 4
		}
		status.set(func(s *Status) {
			s.Jobs[spec.ID] = &JobStatus{ID: spec.ID, Duration: spec.Duration, Total: int(math.Ceil(spec.Duration / segment)), Renditions: []string{}}
			s.Stopped, s.RetryIn = "", 0
		})
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
			if !validWant(msg) {
				return
			}
			job.want(ctx, msg.Start, msg.Until, msg.Video, msg.Audio)
		case "extend":
			job.extend(msg.Until)
		case "stop":
			job.stop()
			reason := msg.Reason
			if reason == "" {
				reason = "film terminé"
			}
			status.set(func(s *Status) {
				delete(s.Jobs, id)
				s.Stopped, s.StoppedAt, s.RetryIn = reason, time.Now().Unix(), msg.RetryIn
			})
			if msg.RetryIn > 0 {
				logf("Le serveur reprend le film (%s) ; il revient dans %d s.", reason, msg.RetryIn)
			} else {
				logf("Film terminé ou repris par le serveur (%s).", reason)
			}
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
	status.set(func(s *Status) { s.Jobs = map[string]*JobStatus{} })
}

// idle: no film encoded lately (an update can restart the app).
func (a *Agent) idle() bool {
	snap := status.snapshot()
	jobs, _ := snap["jobs"].([]JobStatus)
	for _, j := range jobs {
		if time.Since(time.Unix(j.LastAt, 0)) < 2*time.Minute {
			return false
		}
	}
	return true
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
