package main

import (
	"golang.org/x/sys/windows/registry"
)

// Start with Windows: a value in the user's Run key (no admin rights needed).
const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const runName = "WatchPartyEncoder"

func autoStartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runName)
	return err == nil
}

func setAutoStart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		if err := k.DeleteValue(runName); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := selfPath()
	if err != nil {
		return err
	}
	return k.SetStringValue(runName, `"`+exe+`" -background`)
}
