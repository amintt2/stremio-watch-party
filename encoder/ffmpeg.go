package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Windows build with NVENC, Quick Sync, AMF and libplacebo (GPL, BtbN's automated builds).
const windowsFFmpegURL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip"

// findFFmpeg: the --ffmpeg flag, next to this program, one downloaded earlier, the PATH;
// on Windows it is downloaded the first time (about 100 Mo).
func findFFmpeg(flag string) (string, error) {
	name := "ffmpeg"
	if runtime.GOOS == "windows" {
		name = "ffmpeg.exe"
	}
	exe, _ := os.Executable()
	cached := filepath.Join(cacheDir(), name)
	for _, p := range []string{flag, filepath.Join(filepath.Dir(exe), name), cached} {
		if p != "" && works(p) {
			return p, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil && works(p) {
		return p, nil
	}
	switch runtime.GOOS {
	case "windows":
		if err := downloadFFmpeg(cached); err != nil {
			return "", fmt.Errorf("téléchargement de ffmpeg impossible (%v) : mets ffmpeg.exe à côté de ce programme", err)
		}
		return cached, nil
	case "darwin":
		return "", errors.New("ffmpeg est introuvable : installe-le avec « brew install ffmpeg » puis relance")
	default:
		return "", errors.New("ffmpeg est introuvable : installe-le (ex. « sudo apt install ffmpeg ») puis relance")
	}
}

func cacheDir() string {
	if dir, err := os.UserCacheDir(); err == nil {
		return filepath.Join(dir, "WatchPartyEncoder")
	}
	return "."
}

func works(path string) bool {
	cmd := exec.Command(path, "-hide_banner", "-version")
	hideWindow(cmd)
	return cmd.Run() == nil
}

func downloadFFmpeg(dest string) error {
	logf("Premier lancement : téléchargement de ffmpeg (une seule fois)…")
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".zip.part"
	defer os.Remove(tmp)
	client := &http.Client{Timeout: 15 * time.Minute}
	resp, err := client.Get(windowsFFmpegURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	progress := &progressWriter{total: resp.ContentLength}
	if _, err := io.Copy(f, io.TeeReader(resp.Body, progress)); err != nil {
		f.Close()
		return err
	}
	f.Close()
	fmt.Println()
	return extractFromZip(tmp, "bin/ffmpeg.exe", dest)
}

func extractFromZip(archive, suffix, dest string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		if !strings.HasSuffix(f.Name, suffix) {
			continue
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		defer src.Close()
		out, err := os.OpenFile(dest+".part", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, src); err != nil {
			out.Close()
			return err
		}
		out.Close()
		return os.Rename(dest+".part", dest)
	}
	return fmt.Errorf("%s absent de l'archive", suffix)
}

type progressWriter struct {
	total, done int64
	last        time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if time.Since(p.last) > 500*time.Millisecond && p.total > 0 {
		p.last = time.Now()
		pct := int(p.done * 100 / p.total)
		status.set(func(s *Status) {
			s.Download = pct
			s.Message = fmt.Sprintf("%d / %d Mo", p.done>>20, p.total>>20)
		})
		fmt.Printf("\r  %d %%  (%d / %d Mo)", pct, p.done>>20, p.total>>20)
	}
	return len(b), nil
}
