package ollama

import "bytes"

// Image limits of a chat message (vision models). They are part of the validated structs of
// this package (tray rule 2) and are advertised to the browser in device_info.limits.
const (
	// MaxImagesPerMessage caps Message.Images.
	MaxImagesPerMessage = 4
	// MaxImageBytes caps one decoded image.
	MaxImageBytes = 4 << 20
)

// ImageMIME returns the MIME type of data by its magic bytes, or "" when the type is not one of
// the four accepted by the protocol: JPEG, PNG, WebP and GIF. Nothing else is ever sent to Ollama.
func ImageMIME(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg"
	case bytes.HasPrefix(data, []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return "image/png"
	case len(data) >= 12 && bytes.HasPrefix(data, []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	case bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a")):
		return "image/gif"
	}
	return ""
}

// validateImages enforces the image rules of one message: only user messages carry images,
// at most MaxImagesPerMessage of them, each ≤ MaxImageBytes and of an accepted type.
func validateImages(m Message) error {
	if len(m.Images) == 0 {
		return nil
	}
	if m.Role != "user" {
		return ErrInvalid("images only allowed on user messages")
	}
	if len(m.Images) > MaxImagesPerMessage {
		return ErrInvalid("too many images")
	}
	for _, img := range m.Images {
		if len(img) > MaxImageBytes {
			return ErrInvalid("image too large")
		}
		if ImageMIME(img) == "" {
			return ErrInvalid("unsupported image type")
		}
	}
	return nil
}
