package channel

import (
	"encoding/base64"
	"strings"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
)

// maxImageB64 is the length of the standard base64 of MaxImageBytes (padded): anything longer
// is rejected before decoding so an oversize image never gets a 4 MiB buffer.
const maxImageB64 = (MaxImageBytes + 2) / 3 * 4

// decodeChatImages validates the images of every message (contract: only user messages, at
// most MaxImagesPerMessage, each ≤ MaxImageBytes after decoding and of an accepted type by
// magic bytes) and returns them decoded, indexed like msgs. The returned error strings are the
// E_INVALID messages of the protocol.
func decodeChatImages(msgs []chatMessage) ([][]history.Image, string) {
	out := make([][]history.Image, len(msgs))
	for i, msg := range msgs {
		if len(msg.Images) == 0 {
			continue
		}
		if msg.Role != "user" {
			return nil, "images only allowed on user messages"
		}
		if len(msg.Images) > MaxImagesPerMessage {
			return nil, "too many images"
		}
		images := make([]history.Image, 0, len(msg.Images))
		for _, s := range msg.Images {
			data, reason := decodeImage(s)
			if reason != "" {
				return nil, reason
			}
			images = append(images, data)
		}
		out[i] = images
	}
	return out, ""
}

// decodeImage decodes one base64 image (RFC 4648 standard alphabet, padding optional, no
// data-URL prefix) and classifies it by magic bytes.
func decodeImage(s string) (history.Image, string) {
	if len(s) > maxImageB64 {
		return history.Image{}, "image too large"
	}
	data, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil || len(data) == 0 {
		return history.Image{}, "invalid image base64"
	}
	if len(data) > MaxImageBytes {
		return history.Image{}, "image too large"
	}
	mime := ollama.ImageMIME(data)
	if mime == "" {
		return history.Image{}, "unsupported image type"
	}
	return history.Image{Mime: mime, Data: data}, ""
}
