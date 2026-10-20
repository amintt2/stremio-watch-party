package main

import "testing"

// Desktop Entry spec: quoting escapes ($ → \$), then string escaping doubles the backslash.
func TestDesktopQuote(t *testing.T) {
	if got := desktopQuote(`/home/a b/$x"100%`); got != `"/home/a b/\\$x\\"100%%"` {
		t.Fatal(got)
	}
}
