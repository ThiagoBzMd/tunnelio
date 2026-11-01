// Package history is the private-mode conversation store (SQLite via modernc.org/sqlite, WAL).
// Schema and append-only rules: SPEC §9. Written only by package channel for chat{mode:"private"}.
//
// Schema version 2 adds message_images (one row per image of a user message, raw bytes plus
// mime, cascade-deleted with the message). Get pages by row count and by bytes (MaxPageBytes)
// so that one history_get response never exceeds the channel's plaintext budget.
package history
