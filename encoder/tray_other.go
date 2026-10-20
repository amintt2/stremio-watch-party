//go:build !windows

package main

import "context"

// runTray: macOS and Linux keep their terminal; the window is the browser page.
func runTray(ctx context.Context, windowURL string, quit func()) {
	<-ctx.Done()
}
