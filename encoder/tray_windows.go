package main

import (
	"context"
	_ "embed"
	"time"

	"fyne.io/systray"
)

//go:embed icon.ico
var trayIcon []byte

// runTray: on Windows the app has no console; its icon near the clock opens the window,
// the site, or quits. Blocks until the app quits.
func runTray(ctx context.Context, openWindow func(), quit func()) {
	go func() {
		<-ctx.Done()
		systray.Quit()
	}()
	systray.Run(func() {
		systray.SetIcon(trayIcon)
		systray.SetTitle("Watch Party")
		systray.SetTooltip("Watch Party · Encodeur GPU")
		open := systray.AddMenuItem("Ouvrir l'encodeur", "Voir l'état et les réglages")
		site := systray.AddMenuItem("Ouvrir Watch Party", "Le site dans le navigateur")
		systray.AddSeparator()
		exit := systray.AddMenuItem("Quitter", "Arrêter l'encodeur")
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					openWindow()
				case <-site.ClickedCh:
					if s := currentSettings(); s.valid() {
						openBrowser(s.Server)
					}
				case <-exit.ClickedCh:
					quit()
					return
				}
			}
		}()
		// The tooltip says how it is doing, like the window's first line.
		go func() {
			for range time.Tick(3 * time.Second) {
				systray.SetTooltip(trayText())
			}
		}()
	}, func() {})
}

func trayText() string {
	snap := status.snapshot()
	jobs, _ := snap["jobs"].([]JobStatus)
	for _, j := range jobs {
		if j.Active {
			return "Watch Party · Encodeur GPU : encode en ce moment"
		}
	}
	switch snap["connection"] {
	case "connected":
		return "Watch Party · Encodeur GPU : connecté, prêt"
	case "refused":
		return "Watch Party · Encodeur GPU : clé refusée"
	case "error":
		return "Watch Party · Encodeur GPU : problème (ouvre-le pour voir)"
	default:
		return "Watch Party · Encodeur GPU : connexion…"
	}
}
