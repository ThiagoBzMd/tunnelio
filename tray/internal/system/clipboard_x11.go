//go:build linux

package system

import (
	"errors"
	"os"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

// x11Clipboard owns the X11 CLIPBOARD selection and serves it to other applications for as
// long as the tray runs — exactly what a Ctrl+C does, without xclip/xsel. Works on X11 and on
// Wayland sessions through XWayland (GNOME/KDE sync the X selection with Wayland clients).
type x11Clipboard struct {
	mu   sync.Mutex
	conn *xgb.Conn
	win  xproto.Window
	data []byte
	atom struct{ clipboard, utf8, targets, atomAtom, text, str xproto.Atom }
}

var x11Clip struct {
	once sync.Once
	c    *x11Clipboard
	err  error
}

// maxClipboard bounds the selection payload (pairing codes are 14 bytes; no INCR transfer needed).
const maxClipboard = 64 * 1024

func (c *x11Clipboard) intern(name string) (xproto.Atom, error) {
	r, err := xproto.InternAtom(c.conn, false, uint16(len(name)), name).Reply() //nolint:gosec // atom names are short constants
	if err != nil {
		return 0, err
	}
	return r.Atom, nil
}

func newX11Clipboard() (*x11Clipboard, error) {
	if os.Getenv("DISPLAY") == "" {
		return nil, errors.New("no X11 display")
	}
	conn, err := xgb.NewConn()
	if err != nil {
		return nil, err
	}
	c := &x11Clipboard{conn: conn}
	screen := xproto.Setup(conn).DefaultScreen(conn)
	wid, err := xproto.NewWindowId(conn)
	if err != nil {
		conn.Close()
		return nil, err
	}
	c.win = wid
	// An ordinary (InputOutput) window that is never mapped — the same trick xclip uses. An
	// InputOnly window would need depth 0 / visual CopyFromParent and yields BadMatch otherwise.
	if err := xproto.CreateWindowChecked(conn, screen.RootDepth, wid, screen.Root, 0, 0, 1, 1, 0,
		xproto.WindowClassInputOutput, screen.RootVisual, 0, nil).Check(); err != nil {
		conn.Close()
		return nil, err
	}
	for _, p := range []struct {
		dst  *xproto.Atom
		name string
	}{{&c.atom.clipboard, "CLIPBOARD"}, {&c.atom.utf8, "UTF8_STRING"}, {&c.atom.targets, "TARGETS"},
		{&c.atom.atomAtom, "ATOM"}, {&c.atom.text, "TEXT"}, {&c.atom.str, "STRING"}} {
		a, err := c.intern(p.name)
		if err != nil {
			conn.Close()
			return nil, err
		}
		*p.dst = a
	}
	go c.serve()
	return c, nil
}

// serve answers SelectionRequest events until the connection dies.
func (c *x11Clipboard) serve() {
	for {
		ev, err := c.conn.WaitForEvent()
		if err != nil && ev == nil {
			return
		}
		req, ok := ev.(xproto.SelectionRequestEvent)
		if !ok {
			continue
		}
		c.mu.Lock()
		data := c.data
		c.mu.Unlock()
		property := req.Property
		if property == xproto.AtomNone {
			property = req.Target
		}
		switch req.Target {
		case c.atom.targets:
			targets := []xproto.Atom{c.atom.targets, c.atom.utf8, c.atom.text, c.atom.str}
			buf := make([]byte, 4*len(targets))
			for i, a := range targets {
				xgb.Put32(buf[4*i:], uint32(a))
			}
			xproto.ChangeProperty(c.conn, xproto.PropModeReplace, req.Requestor, property, c.atom.atomAtom, 32, uint32(len(targets)), buf) //nolint:gosec // 4 targets
		case c.atom.utf8, c.atom.text, c.atom.str:
			xproto.ChangeProperty(c.conn, xproto.PropModeReplace, req.Requestor, property, c.atom.utf8, 8, uint32(len(data)), data) //nolint:gosec // bounded by maxClipboard
		default:
			property = xproto.AtomNone
		}
		notify := xproto.SelectionNotifyEvent{Time: req.Time, Requestor: req.Requestor, Selection: req.Selection, Target: req.Target, Property: property}
		xproto.SendEvent(c.conn, false, req.Requestor, xproto.EventMaskNoEvent, string(notify.Bytes()))
	}
}

func (c *x11Clipboard) write(text string) error {
	if len(text) > maxClipboard {
		return errors.New("text too large for the clipboard")
	}
	c.mu.Lock()
	c.data = []byte(text)
	c.mu.Unlock()
	if err := xproto.SetSelectionOwnerChecked(c.conn, c.win, c.atom.clipboard, xproto.TimeCurrentTime).Check(); err != nil {
		return err
	}
	owner, err := xproto.GetSelectionOwner(c.conn, c.atom.clipboard).Reply()
	if err != nil {
		return err
	}
	if owner.Owner != c.win {
		return errors.New("could not take ownership of the X11 clipboard")
	}
	return nil
}

// copyNative puts text on the clipboard without external tools (X11 / XWayland).
func copyNative(text string) error {
	x11Clip.once.Do(func() { x11Clip.c, x11Clip.err = newX11Clipboard() })
	if x11Clip.err != nil {
		return x11Clip.err
	}
	return x11Clip.c.write(text)
}
