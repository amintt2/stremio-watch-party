package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Updates: the app replaces itself with a newer build, from the Watch Party site it is
// paired with (default: always the version that matches that server) or from the GitHub
// releases of the project. The file is checked against its SHA-256 before it is used.

const updateEvery = 6 * time.Hour

// platformFile: this build's file name, as the site and the releases name it.
func platformFile() string {
	name := fmt.Sprintf("watchparty-encoder-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// release: a newer build somewhere.
type release struct {
	Version string
	URL     string
	SHA256  string
	// The site wants the pairing key to hand out the file.
	auth bool
}

var (
	updateMu  sync.Mutex
	available *release
	// wakeUpdater: the window asked to check now.
	wakeUpdater = make(chan struct{}, 1)
)

// newer: is version a newer than b ("1.2.0" > "1.1.9")? Builds without a version ("dev")
// are never newer, and anything is newer than them.
func newer(a, b string) bool {
	pa, okA := parseVersion(a)
	pb, okB := parseVersion(b)
	if !okA {
		return false
	}
	if !okB {
		return true
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// checkUpdate asks the chosen source for its latest version.
func checkUpdate(ctx context.Context) (*release, error) {
	p := currentPrefs()
	status.set(func(s *Status) { s.Update.State, s.Update.Message = "checking", "" })
	var rel *release
	var err error
	if p.UpdateSource == "github" {
		rel, err = latestFromGitHub(ctx, p.GithubRepo)
	} else {
		rel, err = latestFromServer(ctx)
	}
	updateMu.Lock()
	defer updateMu.Unlock()
	now := time.Now().Unix()
	if err != nil {
		available = nil
		status.set(func(s *Status) { s.Update.State, s.Update.Message, s.Update.Checked = "error", err.Error(), now })
		return nil, err
	}
	if !newer(rel.Version, version) {
		available = nil
		status.set(func(s *Status) {
			s.Update.State, s.Update.Message, s.Update.Latest, s.Update.Checked = "uptodate", "", rel.Version, now
		})
		return nil, nil
	}
	available = rel
	status.set(func(s *Status) {
		s.Update.State, s.Update.Message, s.Update.Latest, s.Update.Checked = "available", "", rel.Version, now
	})
	return rel, nil
}

func latestFromServer(ctx context.Context) (*release, error) {
	st := currentSettings()
	if !st.valid() {
		return nil, errors.New("pas encore jumelé à un site Watch Party")
	}
	var body struct {
		Version string `json:"version"`
		Files   map[string]struct {
			SHA256 string `json:"sha256"`
		} `json:"files"`
	}
	base := strings.TrimSuffix(st.Server, "/")
	if err := getJSON(ctx, base+"/api/encoder/latest", st.Key, &body); err != nil {
		return nil, err
	}
	file, ok := body.Files[platformFile()]
	if !ok || body.Version == "" {
		return nil, fmt.Errorf("le site ne propose pas de version pour %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return &release{Version: body.Version, URL: base + "/api/encoder/update/" + platformFile(), SHA256: file.SHA256, auth: true}, nil
}

func latestFromGitHub(ctx context.Context, repo string) (*release, error) {
	if !validRepo(repo) {
		return nil, errors.New("dépôt GitHub invalide (propriétaire/nom)")
	}
	var list []struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := getJSON(ctx, "https://api.github.com/repos/"+repo+"/releases?per_page=20", "", &list); err != nil {
		return nil, err
	}
	for _, r := range list {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, "encoder-v") {
			continue
		}
		var url, sums string
		for _, a := range r.Assets {
			switch a.Name {
			case platformFile():
				url = a.URL
			case "SHA256SUMS":
				sums = a.URL
			}
		}
		if url == "" || sums == "" {
			continue
		}
		data, err := fetch(ctx, sums, "", 1<<20, nil)
		if err != nil {
			return nil, err
		}
		sum := findSum(string(data), platformFile())
		if sum == "" {
			return nil, fmt.Errorf("%s absent de SHA256SUMS", platformFile())
		}
		return &release{Version: strings.TrimPrefix(r.Tag, "encoder-v"), URL: url, SHA256: sum}, nil
	}
	return nil, errors.New("aucune version de l'encodeur publiée sur ce dépôt")
}

// findSum reads "<sha256>  <file>" lines (sha256sum's format).
func findSum(sums, file string) string {
	sc := bufio.NewScanner(strings.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == file && len(f[0]) == 64 {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

func getJSON(ctx context.Context, url, key string, out any) error {
	data, err := fetch(ctx, url, key, 1<<20, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// fetch downloads at most limit bytes; progress(done, total) is called along the way.
func fetch(ctx context.Context, url, key string, limit int64, progress func(done, total int64)) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "watchparty-encoder/"+version)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s : HTTP %d", hostOf(url), resp.StatusCode)
	}
	var buf bytes.Buffer
	r := io.LimitReader(resp.Body, limit+1)
	chunk := make([]byte, 256<<10)
	for {
		n, err := r.Read(chunk)
		buf.Write(chunk[:n])
		if progress != nil {
			progress(int64(buf.Len()), resp.ContentLength)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	if int64(buf.Len()) > limit {
		return nil, errors.New("fichier trop gros")
	}
	return buf.Bytes(), nil
}

// installUpdate downloads, checks and puts the new build in place, then restarts into it.
func installUpdate(ctx context.Context) error {
	updateMu.Lock()
	rel := available
	updateMu.Unlock()
	if rel == nil {
		return errors.New("aucune mise à jour disponible")
	}
	fail := func(err error) error {
		status.set(func(s *Status) { s.Update.State, s.Update.Message = "error", err.Error() })
		logf("Mise à jour impossible : %v", err)
		return err
	}
	logf("Mise à jour vers la version %s…", rel.Version)
	status.set(func(s *Status) { s.Update.State, s.Update.Progress = "downloading", 0 })
	key := ""
	if rel.auth {
		key = currentSettings().Key
	}
	data, err := fetch(ctx, rel.URL, key, 200<<20, func(done, total int64) {
		if total > 0 {
			status.set(func(s *Status) { s.Update.Progress = int(done * 100 / total) })
		}
	})
	if err != nil {
		return fail(err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != rel.SHA256 {
		return fail(errors.New("fichier corrompu (empreinte SHA-256 différente), mise à jour annulée"))
	}
	status.set(func(s *Status) { s.Update.State = "installing" })
	exe, err := selfPath()
	if err != nil {
		return fail(err)
	}
	if err := replaceSelf(exe, data); err != nil {
		return fail(err)
	}
	logf("Version %s installée : redémarrage.", rel.Version)
	restart(exe)
	return nil
}

func selfPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// replaceSelf: a running .exe can't be overwritten on Windows, but it can be renamed:
// the old one becomes .old (deleted at the next start) and the new one takes its name.
func replaceSelf(exe string, data []byte) error {
	next := exe + ".new"
	if err := os.WriteFile(next, data, 0o755); err != nil {
		return fmt.Errorf("écriture impossible à côté du programme (%v)", err)
	}
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			os.Remove(next)
			return err
		}
		if err := os.Rename(next, exe); err != nil {
			_ = os.Rename(old, exe)
			return err
		}
		return nil
	}
	return os.Rename(next, exe)
}

// removeOldBuild: what the last update left behind (the old process may still be exiting).
func removeOldBuild() {
	exe, err := selfPath()
	if err != nil {
		return
	}
	for range 10 {
		if err := os.Remove(exe + ".old"); err == nil || os.IsNotExist(err) {
			return
		}
		time.Sleep(time.Second)
	}
}

// beforeExit: stops the films and frees the window's port for the next process.
var beforeExit []func()

func shutdown() {
	for _, fn := range beforeExit {
		fn()
	}
}

// restart starts the new build in the background (no new window) and leaves.
func restart(exe string) {
	shutdown()
	args := []string{"-background"}
	for _, a := range os.Args[1:] {
		if a != "-background" && a != "--background" {
			args = append(args, a)
		}
	}
	cmd := exec.Command(exe, args...)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		logf("Redémarrage impossible : %v (relance le programme)", err)
	}
	os.Exit(0)
}

// updater checks now and then; with automatic updates on, it installs between films.
func updater(ctx context.Context, idle func() bool) {
	timer := time.NewTimer(30 * time.Second)
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-wakeUpdater:
		}
		rel, _ := checkUpdate(ctx)
		next := updateEvery
		if rel != nil && currentPrefs().AutoUpdate {
			if idle() {
				_ = installUpdate(ctx)
			} else {
				// A film is being encoded: try again in a few minutes.
				next = 5 * time.Minute
			}
		}
		timer.Reset(next)
	}
}
