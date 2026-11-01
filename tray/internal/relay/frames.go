package relay

import "encoding/json"

// Device-side frames (SPEC §3.4). Field names are the wire names.

const (
	// Subprotocol is the WebSocket subprotocol required by the relay.
	Subprotocol = "tunnelio.v1"
	// ProtocolVersion is the v announced in hello.
	ProtocolVersion = 1
	// DefaultMaxFrameBytes is the relay frame limit until welcome says otherwise.
	DefaultMaxFrameBytes = 1 << 20
)

// WebSocket close codes (SPEC §3.5).
const (
	CloseUnauthorized   = 4001
	CloseProtocol       = 4002
	CloseRateLimit      = 4003
	CloseTooLarge       = 4004
	CloseServerShutdown = 4005
	CloseReplaced       = 4006
)

// Limits is welcome.limits.
type Limits struct {
	MaxFrameBytes int `json:"max_frame_bytes"`
}

// Latest is welcome.latest: the newest computer-app release, when the server announces one.
type Latest struct {
	Version string `json:"version"`
	URL     string `json:"url"`
}

// Welcome is the S→D welcome frame.
type Welcome struct {
	V        int     `json:"v"`
	DeviceID *string `json:"device_id"`
	Limits   Limits  `json:"limits"`
	Latest   *Latest `json:"latest,omitempty"`
}

// helloFrame is the first frame sent by the device.
type helloFrame struct {
	Type             string `json:"type"`
	V                int    `json:"v"`
	App              string `json:"app"`
	Version          string `json:"version"`
	Platform         string `json:"platform"`
	ProtocolVersions []int  `json:"protocol_versions"`
}

// inFrame is the union of every S→D frame; only the fields of the given type are set.
type inFrame struct {
	Type        string          `json:"type"`
	V           int             `json:"v"`
	DeviceID    *string         `json:"device_id"`
	ClientID    string          `json:"client_id"`
	Claim       string          `json:"claim"`
	ExpiresAt   string          `json:"expires_at"`
	Payload     json.RawMessage `json:"payload"`
	Reason      string          `json:"reason"`
	Code        string          `json:"code"`
	Message     string          `json:"message"`
	DeviceToken string          `json:"device_token"`
	Limits      *Limits         `json:"limits"`
	Latest      *Latest         `json:"latest"`
	T           int64           `json:"t"`
}

// Outbound frames.

type pingFrame struct {
	Type string `json:"type"`
	T    int64  `json:"t"`
}

type pairStartFrame struct {
	Type string `json:"type"`
}

type pairMsgFrame struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type pairDoneFrame struct {
	Type string `json:"type"`
	OK   bool   `json:"ok"`
	Name string `json:"name,omitempty"`
}

type dataFrame struct {
	Type     string          `json:"type"`
	ClientID string          `json:"client_id"`
	Payload  json.RawMessage `json:"payload"`
}

// closeFrame is the device-initiated session close. SPEC §3.4 does not list it explicitly but
// §6.3 requires the device to close a session on a counter violation; it mirrors the client's
// close{device_id} (spec note in the implementation report).
type closeFrame struct {
	Type     string `json:"type"`
	ClientID string `json:"client_id"`
}
