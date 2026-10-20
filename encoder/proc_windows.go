package main

import (
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// hideWindow: ffmpeg runs without opening its own console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

// detach: the restarted app outlives this process (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
}

var (
	jobOnce   sync.Once
	jobHandle windows.Handle
)

// adopt puts a started ffmpeg in a job object that Windows closes with the app: killed
// from the task manager or crashed, the app takes its ffmpeg with it (no orphan using the GPU).
func adopt(cmd *exec.Cmd) {
	jobOnce.Do(func() {
		h, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			return
		}
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
			windows.CloseHandle(h)
			return
		}
		jobHandle = h
	})
	if jobHandle == 0 || cmd.Process == nil {
		return
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(p)
	_ = windows.AssignProcessToJobObject(jobHandle, p)
}

// showFatal: the app has no console on Windows; a message box says why it stops.
func showFatal(text string) {
	title, _ := windows.UTF16PtrFromString("Watch Party — Encodeur GPU")
	body, _ := windows.UTF16PtrFromString(text)
	windows.MessageBox(0, body, title, windows.MB_OK|windows.MB_ICONERROR)
}
